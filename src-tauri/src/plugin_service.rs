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

    pub fn rescan(&self) -> Result<Vec<Value>> {
        self.manager.scan()?;
        let list = self.list()?;
        if let Err(error) = self.app.emit(PLUGINS_CHANGED_EVENT, &list) {
            log::warn!("could not emit {PLUGINS_CHANGED_EVENT}: {error}");
        }
        Ok(list)
    }

    /// Startup hook: seeds bundled plugins (respecting `plugins.userRemoved`)
    /// and refreshes the manager state.
    pub fn seed_bundled_startup(&self) -> Result<()> {
        self.seed_bundled(false);
        self.manager.scan()?;
        self.emit_changed();
        Ok(())
    }

    /// `plugins_reseed_bundled`: v1 semantics — clear the user-removed map,
    /// restore and update every bundled plugin, rescan, notify.
    pub fn reseed_bundled(&self) -> Result<bool> {
        self.database.set(USER_REMOVED_KEY, json!({}))?;
        self.seed_bundled(true);
        self.manager.scan()?;
        self.emit_changed();
        Ok(true)
    }

    fn seed_bundled(&self, restore_removed: bool) {
        let Some(bundled_root) = self.bundled_root() else {
            log::warn!("bundled plugin directory not found; seeding skipped");
            return;
        };
        // First give strict v2 packages to the manager. Today's bundled
        // packages still carry v1 manifests and end up in `report.errors`,
        // which is expected and handled by the legacy pass below.
        let report = self.manager.seed_bundled_from(
            &bundled_root,
            BundledSeedOptions {
                restore_removed,
                grant_all_requested: true,
                enable_new: true,
            },
        );
        for id in report.installed.iter().chain(report.updated.iter()) {
            log::info!("bundled plugin seeded: {id}");
        }
        for (id, error) in &report.errors {
            log::debug!("bundled v2 seeding skipped `{id}`: {error}");
        }

        let removed = self.kv_object(USER_REMOVED_KEY);
        let entries = match fs::read_dir(&bundled_root) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!("could not read bundled plugins: {error}");
                return;
            }
        };
        let mut sources: Vec<_> = entries.filter_map(std::result::Result::ok).collect();
        sources.sort_by_key(|entry| entry.file_name());
        for entry in sources {
            let name = entry.file_name();
            let Some(name) = name.to_str().map(str::to_owned) else {
                continue;
            };
            if validate_plugin_id(&name).is_err() {
                continue;
            }
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let source = entry.path();
            let Some(manifest) = read_lenient_manifest(&source) else {
                continue;
            };
            if manifest.get("id").and_then(Value::as_str) != Some(name.as_str()) {
                continue;
            }
            // v2 packages were handled (or legitimately rejected) above.
            if manifest.get("schemaVersion").is_some() {
                continue;
            }
            if !restore_removed
                && removed
                    .get(&name)
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                continue;
            }
            // Never shadow an id owned by a validated v2 package.
            if self.manager.get(&name).is_some() {
                continue;
            }
            let target = self.manager.root().join(&name);
            if target.exists() && !legacy_should_update(&source, &target) {
                continue;
            }
            match self.copy_legacy_package(&source, &name) {
                Ok(()) => log::info!("bundled legacy plugin seeded: {name}"),
                Err(error) => log::warn!("seeding bundled plugin `{name}` failed: {error}"),
            }
        }
    }

    /// Copies a trusted legacy bundled package into the plugin directory via
    /// a staging directory, with the same bounds the manager applies.
    fn copy_legacy_package(&self, source: &Path, id: &str) -> Result<()> {
        let limits = self.manager.limits();
        let root = self.manager.root().to_path_buf();
        let staging_container = root.join(STAGING_DIR).join(format!("seed-{}", Uuid::new_v4()));
        let staging = staging_container.join("plugin");
        let result = (|| -> Result<()> {
            fs::create_dir_all(&staging)?;
            let mut file_count = 0usize;
            let mut total_bytes = 0u64;
            for entry in WalkDir::new(source).follow_links(false).min_depth(1) {
                let entry = entry.map_err(|error| {
                    AppError::Plugin(format!("walk failed below {}: {error}", source.display()))
                })?;
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata.file_type().is_symlink() {
                    return Err(AppError::Plugin(format!(
                        "symbolic link in bundled plugin: {}",
                        entry.path().display()
                    )));
                }
                let relative = entry.path().strip_prefix(source).map_err(|_| {
                    AppError::Plugin("bundled plugin path escaped its root".to_owned())
                })?;
                let relative = relative.to_str().ok_or_else(|| {
                    AppError::Plugin("bundled plugin path is not UTF-8".to_owned())
                })?;
                let normalized = relative.replace(std::path::MAIN_SEPARATOR, "/");
                let safe_relative =
                    validate_payload_path(&normalized, limits).map_err(AppError::from)?;
                let destination = staging.join(&safe_relative);
                if metadata.is_dir() {
                    fs::create_dir_all(&destination)?;
                    continue;
                }
                if !metadata.is_file() {
                    return Err(AppError::Plugin(format!(
                        "unsupported file type in bundled plugin: {}",
                        entry.path().display()
                    )));
                }
                file_count += 1;
                if file_count > limits.max_files {
                    return Err(AppError::Plugin("bundled plugin has too many files".into()));
                }
                let size = metadata.len();
                if size > limits.max_file_bytes {
                    return Err(AppError::Plugin(format!(
                        "bundled plugin file `{normalized}` is too large"
                    )));
                }
                total_bytes = total_bytes.saturating_add(size);
                if total_bytes > limits.max_total_bytes {
                    return Err(AppError::Plugin("bundled plugin is too large".into()));
                }
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &destination)?;
            }
            let target = root.join(id);
            let trash = root
                .join(TRASH_DIR)
                .join(format!("{id}--seed-{}", Uuid::new_v4()));
            let had_target = target.exists();
            if had_target {
                fs::rename(&target, &trash)?;
            }
            if let Err(error) = fs::rename(&staging, &target) {
                if had_target {
                    let _ = fs::rename(&trash, &target);
                }
                return Err(error.into());
            }
            if had_target {
                let _ = fs::remove_dir_all(&trash);
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(&staging_container);
        result
    }

    // ------------------------------------------------------------------
    // Mutations
    // ------------------------------------------------------------------

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<bool> {
        validate_plugin_id(id).map_err(AppError::from)?;
        if let Some(record) = self.manager.get(id) {
            if enabled && !record.missing_permissions.is_empty() {
                // The renderer asks the user to confirm activation; that
                // explicit toggle is the consent for the permissions the
                // manifest requests, mirroring the v1 activation flow.
                self.manager
                    .set_grants(id, record.manifest.requested_permissions())?;
            }
            self.manager.set_enabled(id, enabled)?;
        } else if self.legacy_dir(id).is_some() {
            let mut map = self.kv_object(LEGACY_ENABLED_KEY);
            map.insert(id.to_owned(), Value::Bool(enabled));
            self.database.set(LEGACY_ENABLED_KEY, Value::Object(map))?;
        } else {
            return Err(AppError::NotFound(format!(
                "plugin `{id}` is not installed"
            )));
        }
        self.emit_changed();
        Ok(true)
    }

    /// Additive permission grant for a managed (v2) plugin.
    pub fn grant_permissions(&self, id: &str, permissions: Vec<String>) -> Result<Value> {
        let record = self
            .manager
            .get(id)
            .ok_or_else(|| AppError::NotFound(format!("plugin `{id}` is not installed")))?;
        let mut grants = record.granted_permissions;
        grants.extend(permissions);
        let record = self.manager.set_grants(id, grants)?;
        let entry = Self::record_entry(&record);
        self.emit_changed();
        Ok(entry)
    }

    pub fn uninstall(&self, id: &str) -> Result<bool> {
        validate_plugin_id(id).map_err(AppError::from)?;
        let is_bundled_source = self.bundled_ids().contains(id);
        let removed = if self.manager.get(id).is_some() {
            self.manager.uninstall(id)?
        } else if let Some(dir) = self.legacy_dir(id) {
            fs::remove_dir_all(&dir)?;
            let mut map = self.kv_object(LEGACY_ENABLED_KEY);
            if map.remove(id).is_some() {
                self.database.set(LEGACY_ENABLED_KEY, Value::Object(map))?;
            }
            true
        } else {
            false
        };
        if removed {
            if is_bundled_source {
                let mut map = self.kv_object(USER_REMOVED_KEY);
                map.insert(id.to_owned(), Value::Bool(true));
                self.database.set(USER_REMOVED_KEY, Value::Object(map))?;
            }
            // v1 parity: drop persisted plugin data.
            let _ = self.database.delete(&format!("plugins.data.{id}"));
            self.emit_changed();
        }
        Ok(removed)
    }

    // ------------------------------------------------------------------
    // Installation
    // ------------------------------------------------------------------

    /// `plugins_install`: returns a structured `{ ok, plugin? , error? }`
    /// object instead of throwing, mirroring the v1 IPC contract.
    pub fn install(&self, payload: InstallPayload) -> Value {
        let outcome = if let Some(dir) = payload.dir.as_deref() {
            self.install_directory(Path::new(dir))
        } else if let Some(files) = payload.files {
            self.install_files(payload.id, files)
        } else {
            Err(AppError::InvalidInput("invalid_payload".to_owned()))
        };
        self.install_outcome(outcome)
    }

    /// `plugins_install_from_dialog` after the user picked a folder.
    pub fn install_from_picked_directory(&self, dir: &Path) -> Value {
        let outcome = self.install_directory(dir);
        self.install_outcome(outcome)
    }

    fn install_outcome(&self, outcome: Result<Value>) -> Value {
        match outcome {
            Ok(entry) => {
                self.emit_changed();
                json!({ "ok": true, "canceled": false, "plugin": entry })
            }
            Err(error) => json!({ "ok": false, "canceled": false, "error": error.to_string() }),
        }
    }

    fn install_directory(&self, dir: &Path) -> Result<Value> {
        let record = self
            .manager
            .install_from_directory(dir, Self::user_install_options(None))?;
        Ok(Self::record_entry(&record))
    }

    fn install_files(
        &self,
        expected_id: Option<String>,
        files: BTreeMap<String, PayloadContents>,
    ) -> Result<Value> {
        let mut payload_files = Vec::with_capacity(files.len());
        for (path, contents) in files {
            let bytes = match contents {
                PayloadContents::Text(text) => text.into_bytes(),
                PayloadContents::Binary { base64 } => {
                    BASE64.decode(base64.as_bytes()).map_err(|_| {
                        AppError::InvalidInput(format!("file `{path}` is not valid base64"))
                    })?
                }
            };
            payload_files.push(PluginPayloadFile::new(path, bytes));
        }
        let record = self
            .manager
            .install_payload(payload_files, Self::user_install_options(expected_id))?;
        Ok(Self::record_entry(&record))
    }

    fn user_install_options(expected_id: Option<String>) -> InstallOptions {
        InstallOptions {
            origin: PluginOrigin::User,
            replace_existing: true,
            allow_downgrade: false,
            // Freshly installed and updated plugins always start disabled;
            // the user enables them explicitly (v1: `initialEnabled: false`).
            enabled: Some(false),
            grants: BTreeSet::new(),
            expected_id,
        }
    }

    // ------------------------------------------------------------------
    // Misc
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

fn origin_label(origin: PluginOrigin) -> &'static str {
    match origin {
        PluginOrigin::Bundled => "bundled",
        PluginOrigin::User => "user",
    }
}

/// Reads a manifest without v2 schema validation (legacy v1 packages).
fn read_lenient_manifest(dir: &Path) -> Option<Value> {
    let path = dir.join(PLUGIN_MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_LEGACY_MANIFEST_BYTES
    {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.is_object().then_some(value)
}

/// v1 update rule: a strictly higher manifest version updates; as a dev
/// convenience a newer bundled `ui.js` (same version) also updates.
fn legacy_should_update(source: &Path, target: &Path) -> bool {
    let source_version = manifest_version(source);
    let target_version = manifest_version(target);
    if lenient_version_cmp(&source_version, &target_version) == Ordering::Greater {
        return true;
    }
    match (
        fs::metadata(source.join("ui.js")).and_then(|metadata| metadata.modified()),
        fs::metadata(target.join("ui.js")).and_then(|metadata| metadata.modified()),
    ) {
        (Ok(source_time), Ok(target_time)) => source_time > target_time,
        _ => false,
    }
}

fn manifest_version(dir: &Path) -> String {
    read_lenient_manifest(dir)
        .and_then(|manifest| {
            manifest
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "0.0.0".to_owned())
}

/// Compares versions: exact semver when both parse, otherwise a numeric
/// dot-part comparison (v1 `compareVersionParts`).
fn lenient_version_cmp(a: &str, b: &str) -> Ordering {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => {
            let a = numeric_parts(a);
            let b = numeric_parts(b);
            let length = a.len().max(b.len());
            for index in 0..length {
                let left = a.get(index).copied().unwrap_or(0);
                let right = b.get(index).copied().unwrap_or(0);
                match left.cmp(&right) {
                    Ordering::Equal => {}
                    unequal => return unequal,
                }
            }
            Ordering::Equal
        }
    }
}

fn numeric_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}
