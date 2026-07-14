//! Tauri-facing plugin service.
//!
//! Thin orchestration layer between the Tauri command surface and the
//! execution-free [`PluginManager`]. It adds everything the frontend contract
//! needs on top of pure package management:
//!
//! * the `plugins:changed` event, whose payload is the full plugin list
//!   (`pluginRuntime.js` applies the event payload directly),
//! * bundled-plugin seeding from the app resource directory with v1 semantics
//!   (`plugins.userRemoved` map in the KV store, update only on a higher
//!   version, `plugins_reseed_bundled` clears the map and restores),
//! * lenient support for the legacy (manifest v1) bundled packages that ship
//!   in `assets/bundled-plugins/`. Their JavaScript is never read or executed
//!   from disk by the v2 renderer — trusted bundled UI is statically imported
//!   in `pluginRuntime.js` — so the copied files are metadata carriers only.
//!   Legacy packages fail the strict v2 validation of [`PluginManager`] and
//!   are therefore tracked directly by this service (enabled state in the KV
//!   store under `plugins.enabled`, exactly like BlueTalk v1).
//!
//! There is intentionally no main-process plugin runtime in v2:
//! `plugins_invoke_command` answers with a structured
//! `{ ok: false, error: "plugin_main_runtime_not_available" }` and
//! `plugins_send_to_main` is a logged no-op, so legacy plugin UI code that
//! still calls these APIs degrades gracefully instead of crashing.

use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use semver::Version;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter, Manager, path::BaseDirectory};
use tauri_plugin_opener::OpenerExt;
use uuid::Uuid;
use walkdir::WalkDir;

use crate::{
    database::Database,
    error::{AppError, Result},
    plugin_manager::{
        BundledSeedOptions, InstallOptions, PLUGIN_MANIFEST_FILE, PluginError, PluginManager,
        PluginOrigin, PluginPayloadFile, PluginRecord, validate_payload_path, validate_plugin_id,
    },
};

/// Event whose payload is the complete plugin list (see `pluginRuntime.js`).
pub const PLUGINS_CHANGED_EVENT: &str = "plugins:changed";

/// KV key holding `{ "<plugin-id>": true }` for bundled plugins the user
/// removed. Same key as BlueTalk v1, so migrated databases keep the state.
const USER_REMOVED_KEY: &str = "plugins.userRemoved";

/// KV key holding `{ "<plugin-id>": bool }` enable overrides for legacy
/// (manifest v1) plugins. Same key as BlueTalk v1.
const LEGACY_ENABLED_KEY: &str = "plugins.enabled";

/// Bundled resource directory name (`tauri.conf.json` maps
/// `../assets/bundled-plugins/` to `bundled-plugins/`).
const BUNDLED_RESOURCE_DIR: &str = "bundled-plugins";

/// Maximum size accepted for a lenient (legacy) manifest read.
const MAX_LEGACY_MANIFEST_BYTES: u64 = 256 * 1024;

// Working directories inside the plugin root. These mirror the private
// constants in `plugin_manager.rs`; both directories are created by
// `PluginManager::new` and emptied on startup.
const STAGING_DIR: &str = ".staging";
const TRASH_DIR: &str = ".trash";

impl From<PluginError> for AppError {
    fn from(error: PluginError) -> Self {
        match error {
            PluginError::NotFound(id) => Self::NotFound(format!("plugin `{id}` is not installed")),
            PluginError::AlreadyInstalled(id) => {
                Self::Conflict(format!("plugin `{id}` is already installed"))
            }
            other => Self::Plugin(other.to_string()),
        }
    }
}

/// Payload of the `plugins_install` command. Mirrors the BlueTalk v1 IPC
/// shape: either `{ dir }` or `{ id, files: { "rel/path": "text" | { base64 } } }`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPayload {
    #[serde(default)]
    pub dir: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub files: Option<BTreeMap<String, PayloadContents>>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum PayloadContents {
    Text(String),
    Binary { base64: String },
}

/// Thin service around [`PluginManager`]; all methods are blocking by design
/// and should be called via `tauri::async_runtime::spawn_blocking` from
/// commands.
pub struct PluginService {
    app: AppHandle,
    manager: PluginManager,
    database: Arc<Database>,
}

impl PluginService {
    pub fn new(app: AppHandle, manager: PluginManager, database: Arc<Database>) -> Arc<Self> {
        Arc::new(Self {
            app,
            manager,
            database,
        })
    }

    pub fn manager(&self) -> &PluginManager {
        &self.manager
    }

    // ------------------------------------------------------------------
    // Listing
    // ------------------------------------------------------------------

    /// Returns the frontend-facing plugin list. Entries combine strict v2
    /// records from [`PluginManager`] with lenient legacy (manifest v1)
    /// packages found directly in the plugin directory.
    pub fn list(&self) -> Result<Vec<Value>> {
        let records = self.manager.list();
        let managed: BTreeSet<String> = records.iter().map(|record| record.id.clone()).collect();
        let mut entries: Vec<Value> = records.iter().map(Self::record_entry).collect();
        entries.extend(self.legacy_entries(&managed));
        entries.sort_by_key(Self::sort_key);
        Ok(entries)
    }

    fn sort_key(entry: &Value) -> (String, String) {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let name = entry
            .get("manifest")
            .and_then(|manifest| manifest.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_lowercase();
        (name, id)
    }

    fn record_entry(record: &PluginRecord) -> Value {
        let mut manifest = match serde_json::to_value(&record.manifest) {
            Ok(Value::Object(map)) => map,
            _ => Map::new(),
        };
        // Surface free-form metadata (`game`, `tag`, `gameMark`, …) at the
        // manifest top level, where the renderer looks for it.
        for (key, value) in record.manifest.metadata.clone() {
            manifest.entry(key).or_insert(value);
        }
        json!({
            "id": &record.id,
            "manifest": Value::Object(manifest),
            "enabled": record.enabled,
            "hasUi": record.manifest.ui.is_some(),
            "hasMain": record.manifest.backend.is_some(),
            "bundled": record.origin == PluginOrigin::Bundled,
            "source": origin_label(record.origin),
            "grantedPermissions": &record.granted_permissions,
            "missingPermissions": &record.missing_permissions,
            "fileCount": record.file_count,
            "totalBytes": record.total_bytes,
            "legacyManifest": false,
            "lastError": "",
        })
    }

    fn legacy_entries(&self, skip: &BTreeSet<String>) -> Vec<Value> {
        let mut entries = Vec::new();
        let read_dir = match fs::read_dir(self.manager.root()) {
            Ok(read_dir) => read_dir,
            Err(error) => {
                log::warn!("plugin directory scan failed: {error}");
                return entries;
            }
        };
        let bundled_ids = self.bundled_ids();
        let enabled_map = self.kv_object(LEGACY_ENABLED_KEY);
        for entry in read_dir.filter_map(std::result::Result::ok) {
            let name = entry.file_name();
            let Some(name) = name.to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.')
                || skip.contains(&name)
                || validate_plugin_id(&name).is_err()
                || !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false)
            {
                continue;
            }
            let Some(manifest) = read_lenient_manifest(&entry.path()) else {
                continue;
            };
            if manifest.get("id").and_then(Value::as_str) != Some(name.as_str()) {
                log::debug!("plugin directory `{name}` skipped: manifest id mismatch");
                continue;
            }
            // Strict v2 manifests that are not in the manager's records were
            // rejected for a concrete reason; do not resurrect them here.
            if manifest.get("schemaVersion").is_some() {
                continue;
            }
            let bundled = bundled_ids.contains(&name);
            entries.push(Self::legacy_entry(&name, manifest, bundled, &enabled_map));
        }
        entries
    }

    fn legacy_entry(
        id: &str,
        manifest: Value,
        bundled: bool,
        enabled_map: &Map<String, Value>,
    ) -> Value {
        let auto_enable = manifest
            .get("autoEnable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let enabled = match enabled_map.get(id) {
            Some(value) => value.as_bool().unwrap_or(false),
            // Only trusted bundled packages may auto-enable; a legacy
            // third-party package could not run in v2 anyway.
            None => auto_enable && bundled,
        };
        let has_ui = match manifest.get("ui") {
            Some(Value::String(entry)) => !entry.is_empty(),
            Some(Value::Object(object)) => object
                .get("entry")
                .and_then(Value::as_str)
                .is_some_and(|entry| !entry.is_empty()),
            _ => false,
        };
        let has_main = manifest
            .get("main")
            .and_then(Value::as_str)
            .is_some_and(|entry| !entry.is_empty());
        let permissions = manifest
            .get("permissions")
            .cloned()
            .unwrap_or_else(|| json!([]));
        json!({
            "id": id,
            "manifest": manifest,
            "enabled": enabled,
            "hasUi": has_ui,
            "hasMain": has_main,
            "bundled": bundled,
            "source": if bundled { "bundled" } else { "user" },
            "grantedPermissions": if bundled { permissions } else { json!([]) },
            "missingPermissions": json!([]),
            "legacyManifest": true,
            "lastError": "",
        })
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// Emits `plugins:changed` with the full list as payload.
    pub fn emit_changed(&self) {
        match self.list() {
            Ok(list) => {
                if let Err(error) = self.app.emit(PLUGINS_CHANGED_EVENT, &list) {
                    log::warn!("could not emit {PLUGINS_CHANGED_EVENT}: {error}");
                }
            }
            Err(error) => log::warn!("could not build plugin list for change event: {error}"),
        }
    }

    // ------------------------------------------------------------------
    // Scanning and seeding
    // ------------------------------------------------------------------

    /// Opens the plugin directory in the system file manager.
    pub fn open_dir(&self) -> Result<bool> {
        let path = self.manager.root().to_path_buf();
        fs::create_dir_all(&path)?;
        self.app
            .opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| {
                AppError::Plugin(format!("could not open the plugin directory: {error}"))
            })?;
        Ok(true)
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// Resolves the bundled plugin resource directory, with a repo-relative
    /// fallback for `tauri dev`.
    fn bundled_root(&self) -> Option<PathBuf> {
        if let Ok(path) = self
            .app
            .path()
            .resolve(BUNDLED_RESOURCE_DIR, BaseDirectory::Resource)
        {
            if path.is_dir() {
                return Some(path);
            }
        }
        #[cfg(debug_assertions)]
        {
            let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/bundled-plugins");
            if dev.is_dir() {
                return Some(dev);
            }
        }
        None
    }

    /// Ids of every valid plugin directory in the bundled resource folder.
    fn bundled_ids(&self) -> BTreeSet<String> {
        let mut ids = BTreeSet::new();
        let Some(root) = self.bundled_root() else {
            return ids;
        };
        let Ok(entries) = fs::read_dir(root) else {
            return ids;
        };
        for entry in entries.filter_map(std::result::Result::ok) {
            let name = entry.file_name();
            let Some(name) = name.to_str().map(str::to_owned) else {
                continue;
            };
            if validate_plugin_id(&name).is_err() {
                continue;
            }
            if !entry.path().join(PLUGIN_MANIFEST_FILE).is_file() {
                continue;
            }
            ids.insert(name);
        }
        ids
    }

    /// Returns the on-disk directory of a legacy (non manager-managed)
    /// plugin, if it exists and carries a matching lenient manifest.
    fn legacy_dir(&self, id: &str) -> Option<PathBuf> {
        if validate_plugin_id(id).is_err() || self.manager.get(id).is_some() {
            return None;
        }
        let dir = self.manager.root().join(id);
        let metadata = fs::symlink_metadata(&dir).ok()?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return None;
        }
        let manifest = read_lenient_manifest(&dir)?;
        (manifest.get("id").and_then(Value::as_str) == Some(id)).then_some(dir)
    }

    /// Reads a KV entry expected to be a JSON object.
    fn kv_object(&self, key: &str) -> Map<String, Value> {
        match self.database.get(key, json!({})) {
            Ok(Value::Object(map)) => map,
            Ok(_) => Map::new(),
            Err(error) => {
                log::warn!("could not read `{key}` from the KV store: {error}");
                Map::new()
            }
        }
    }
}

mod bundled;
mod helpers;
mod install;

use helpers::{origin_label, read_lenient_manifest};
