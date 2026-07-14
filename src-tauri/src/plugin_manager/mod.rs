//! Secure, execution-free lifecycle management for BlueTalk plugin packages.
//!
//! The manager intentionally does not execute JavaScript or WASM. It owns the
//! trust boundary before a future runtime sees a package: manifest validation,
//! permission grants, bounded copying, staging, rollback, discovery and
//! bundled-plugin seeding.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
#[cfg(test)]
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::{Mutex, RwLock};
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

pub const PLUGIN_MANIFEST_FILE: &str = "manifest.json";
const REGISTRY_FILE: &str = ".plugin-registry-v2.json";
const REGISTRY_BACKUP_FILE: &str = ".plugin-registry-v2.json.bak";
const STAGING_DIR: &str = ".staging";
const BACKUP_DIR: &str = ".backup";
const TRASH_DIR: &str = ".trash";
const REGISTRY_FORMAT_VERSION: u32 = 2;
const PLUGIN_MANIFEST_SCHEMA_VERSION: u32 = 2;
const MAX_REGISTRY_BYTES: u64 = 2 * 1024 * 1024;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

pub type Result<T> = std::result::Result<T, PluginError>;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("I/O operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid semantic version: {0}")]
    Semver(#[from] semver::Error),
    #[error("invalid plugin manifest: {0}")]
    InvalidManifest(String),
    #[error("invalid plugin path `{path}`: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("plugin package limit exceeded: {0}")]
    LimitExceeded(String),
    #[error("plugin package contains a symbolic link or special file: {0}")]
    UnsupportedFileType(PathBuf),
    #[error("plugin package contains colliding paths `{first}` and `{second}`")]
    PathCollision { first: String, second: String },
    #[error("unknown plugin permission `{0}`")]
    UnknownPermission(String),
    #[error("permission `{permission}` was not requested by plugin `{plugin_id}`")]
    PermissionNotRequested {
        plugin_id: String,
        permission: String,
    },
    #[error("plugin `{plugin_id}` is missing grants: {permissions:?}")]
    MissingPermissions {
        plugin_id: String,
        permissions: Vec<String>,
    },
    #[error("plugin `{0}` is not installed")]
    NotFound(String),
    #[error("plugin `{0}` is already installed")]
    AlreadyInstalled(String),
    #[error("a user plugin cannot replace bundled plugin `{0}`")]
    BundledConflict(String),
    #[error("plugin `{plugin_id}` downgrade from {installed} to {candidate} is not allowed")]
    DowngradeNotAllowed {
        plugin_id: String,
        installed: Version,
        candidate: Version,
    },
    #[error("plugin registry is corrupt: {0}")]
    CorruptRegistry(String),
    #[error("plugin operation failed: {0}")]
    Operation(String),
}

#[derive(Debug, Clone)]
pub struct PluginLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_manifest_bytes: u64,
    pub max_depth: usize,
    pub max_relative_path_bytes: usize,
    pub max_component_bytes: usize,
}

impl Default for PluginLimits {
    fn default() -> Self {
        Self {
            max_files: 500,
            max_total_bytes: 64 * 1024 * 1024,
            max_file_bytes: 24 * 1024 * 1024,
            max_manifest_bytes: 256 * 1024,
            max_depth: 16,
            max_relative_path_bytes: 240,
            max_component_bytes: 120,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PermissionRegistry {
    permissions: BTreeSet<String>,
}

impl Default for PermissionRegistry {
    fn default() -> Self {
        Self::from_permissions([
            "storage:read",
            "storage:write",
            "peer:read",
            "peer:connect",
            "peer:disconnect",
            "peer:send",
            "peer:broadcast",
            "chat:read",
            "chat:send",
            "chat:delete",
            "contacts:read",
            "contacts:write",
            "contacts:block",
            "realtime:rooms",
            "notifications:show",
            "ui:tab",
            "ui:screen",
            "ui:composer",
            "network:http",
            "files:plugin-data",
        ])
        .expect("built-in plugin permission names must be valid")
    }
}

impl PermissionRegistry {
    pub fn empty() -> Self {
        Self {
            permissions: BTreeSet::new(),
        }
    }

    pub fn from_permissions<I, S>(permissions: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let mut registry = Self::empty();
        for permission in permissions {
            registry.register(permission)?;
        }
        Ok(registry)
    }

    pub fn register<S: Into<String>>(&mut self, permission: S) -> Result<()> {
        let permission = permission.into();
        validate_permission_name(&permission)?;
        self.permissions.insert(permission);
        Ok(())
    }

    pub fn contains(&self, permission: &str) -> bool {
        self.permissions.contains(permission)
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.permissions.iter().map(String::as_str)
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginUiKind {
    /// Third-party UI runs inside a sandboxed webview from an `.html` entry.
    #[default]
    SandboxedHtml,
    /// Trusted, first-party bundled UI loaded as an ES module (`.js`) by the
    /// renderer. The manager never executes it — it only tracks the package —
    /// and the renderer statically imports bundled entries, refusing to run any
    /// third-party code in the privileged webview.
    TrustedRenderer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginUi {
    pub entry: String,
    #[serde(default)]
    pub kind: PluginUiKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginBackendRuntime {
    WasmComponent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginBackend {
    pub runtime: PluginBackendRuntime,
    pub entry: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifestV2 {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: Version,
    pub api_version: VersionReq,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub ui: Option<PluginUi>,
    #[serde(default)]
    pub backend: Option<PluginBackend>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub auto_enable: bool,
    #[serde(default)]
    pub metadata: BTreeMap<String, Value>,
}

impl PluginManifestV2 {
    pub fn parse_and_validate(
        bytes: &[u8],
        supported_api_version: &Version,
        permission_registry: &PermissionRegistry,
        limits: &PluginLimits,
    ) -> Result<Self> {
        if bytes.len() as u64 > limits.max_manifest_bytes {
            return Err(PluginError::LimitExceeded(format!(
                "manifest is larger than {} bytes",
                limits.max_manifest_bytes
            )));
        }
        let manifest: Self = serde_json::from_slice(bytes)?;
        manifest.validate(supported_api_version, permission_registry, limits)?;
        Ok(manifest)
    }

    pub fn validate(
        &self,
        supported_api_version: &Version,
        permission_registry: &PermissionRegistry,
        limits: &PluginLimits,
    ) -> Result<()> {
        if self.schema_version != PLUGIN_MANIFEST_SCHEMA_VERSION {
            return Err(PluginError::InvalidManifest(format!(
                "schemaVersion must be {PLUGIN_MANIFEST_SCHEMA_VERSION}"
            )));
        }
        validate_plugin_id(&self.id)?;
        validate_trimmed_field("name", &self.name, 1, 120)?;
        validate_optional_field("description", &self.description, 4_096)?;
        validate_optional_string("author", self.author.as_deref(), 200)?;
        validate_optional_string("publisher", self.publisher.as_deref(), 200)?;
        validate_optional_string("license", self.license.as_deref(), 100)?;
        if !self.api_version.matches(supported_api_version) {
            return Err(PluginError::InvalidManifest(format!(
                "apiVersion `{}` does not support host API {}",
                self.api_version, supported_api_version
            )));
        }
        if self.ui.is_none() && self.backend.is_none() {
            return Err(PluginError::InvalidManifest(
                "at least one of `ui` or `backend` is required".to_owned(),
            ));
        }
        if self.permissions.len() > 64 {
            return Err(PluginError::LimitExceeded(
                "manifest requests more than 64 permissions".to_owned(),
            ));
        }
        let mut unique_permissions = BTreeSet::new();
        for permission in &self.permissions {
            validate_permission_name(permission)?;
            if !permission_registry.contains(permission) {
                return Err(PluginError::UnknownPermission(permission.clone()));
            }
            if !unique_permissions.insert(permission) {
                return Err(PluginError::InvalidManifest(format!(
                    "duplicate permission `{permission}`"
                )));
            }
        }
        if let Some(ui) = &self.ui {
            let path = validate_payload_path(&ui.entry, limits)?;
            let required = match ui.kind {
                PluginUiKind::SandboxedHtml => "html",
                PluginUiKind::TrustedRenderer => "js",
            };
            if path.extension() != Some(OsStr::new(required)) {
                return Err(PluginError::InvalidManifest(format!(
                    "ui.entry must point to a .{required} file for this ui.kind"
                )));
            }
        }
        if let Some(backend) = &self.backend {
            let path = validate_payload_path(&backend.entry, limits)?;
            if path.extension() != Some(OsStr::new("wasm")) {
                return Err(PluginError::InvalidManifest(
                    "backend.entry must point to a .wasm file".to_owned(),
                ));
            }
        }
        Ok(())
    }

    pub fn requested_permissions(&self) -> BTreeSet<String> {
        self.permissions.iter().cloned().collect()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PluginOrigin {
    User,
    Bundled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    pub manifest: PluginManifestV2,
    pub root: PathBuf,
    pub origin: PluginOrigin,
    pub enabled: bool,
    pub granted_permissions: BTreeSet<String>,
    pub missing_permissions: BTreeSet<String>,
    pub file_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct PluginPayloadFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

impl PluginPayloadFile {
    pub fn new(path: impl Into<String>, bytes: impl Into<Vec<u8>>) -> Self {
        Self {
            path: path.into(),
            bytes: bytes.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub origin: PluginOrigin,
    pub replace_existing: bool,
    pub allow_downgrade: bool,
    /// `None` preserves the old state for updates and means disabled for a new
    /// plugin. A manifest can never silently enable itself.
    pub enabled: Option<bool>,
    /// Explicit grants made by trusted application code during this install.
    pub grants: BTreeSet<String>,
    pub expected_id: Option<String>,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            origin: PluginOrigin::User,
            replace_existing: false,
            allow_downgrade: false,
            enabled: Some(false),
            grants: BTreeSet::new(),
            expected_id: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BundledSeedOptions {
    pub restore_removed: bool,
    pub grant_all_requested: bool,
    pub enable_new: bool,
}

impl Default for BundledSeedOptions {
    fn default() -> Self {
        Self {
            restore_removed: false,
            grant_all_requested: true,
            enable_new: true,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BundledSeedReport {
    pub installed: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanIssue {
    pub path: PathBuf,
    pub error: String,
}

#[derive(Debug, Clone, Default)]
pub struct ScanReport {
    pub plugins: Vec<PluginRecord>,
    pub rejected: Vec<ScanIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedPluginState {
    enabled: bool,
    origin: PluginOrigin,
    #[serde(default)]
    granted_permissions: BTreeSet<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedRegistry {
    format_version: u32,
    #[serde(default)]
    plugins: BTreeMap<String, PersistedPluginState>,
    #[serde(default)]
    removed_bundled: BTreeSet<String>,
}

impl Default for PersistedRegistry {
    fn default() -> Self {
        Self {
            format_version: REGISTRY_FORMAT_VERSION,
            plugins: BTreeMap::new(),
            removed_bundled: BTreeSet::new(),
        }
    }
}

#[derive(Debug, Clone, Default)]
struct ManagerState {
    registry: PersistedRegistry,
    records: BTreeMap<String, PluginRecord>,
}

#[derive(Debug)]
struct ValidatedPackage {
    manifest: PluginManifestV2,
    file_count: usize,
    total_bytes: u64,
}

/// Thread-safe plugin package manager.
///
/// All mutating filesystem operations are serialized. The methods are blocking
/// by design and should be called via `tokio::task::spawn_blocking` from Tauri
/// commands.
pub struct PluginManager {
    root: PathBuf,
    supported_api_version: Version,
    limits: PluginLimits,
    permission_registry: PermissionRegistry,
    operation_lock: Mutex<()>,
    state: RwLock<ManagerState>,
    #[cfg(test)]
    fail_after_backup_once: AtomicBool,
}

impl PluginManager {
    pub fn new(
        root: impl Into<PathBuf>,
        supported_api_version: Version,
        limits: PluginLimits,
        permission_registry: PermissionRegistry,
    ) -> Result<Self> {
        let root = root.into();
        ensure_root_directory(&root)?;
        for name in [STAGING_DIR, BACKUP_DIR, TRASH_DIR] {
            fs::create_dir_all(root.join(name))?;
        }
        recover_registry_file(&root)?;
        recover_interrupted_installs(&root)?;
        cleanup_directory_contents(&root.join(STAGING_DIR))?;
        cleanup_directory_contents(&root.join(TRASH_DIR))?;
        let registry = load_registry(&root)?;
        let manager = Self {
            root,
            supported_api_version,
            limits,
            permission_registry,
            operation_lock: Mutex::new(()),
            state: RwLock::new(ManagerState {
                registry,
                records: BTreeMap::new(),
            }),
            #[cfg(test)]
            fail_after_backup_once: AtomicBool::new(false),
        };
        manager.scan()?;
        Ok(manager)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn limits(&self) -> &PluginLimits {
        &self.limits
    }

    pub fn permission_registry(&self) -> &PermissionRegistry {
        &self.permission_registry
    }

    pub fn list(&self) -> Vec<PluginRecord> {
        self.state.read().records.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<PluginRecord> {
        self.state.read().records.get(id).cloned()
    }

    pub fn is_permission_granted(&self, id: &str, permission: &str) -> bool {
        self.state
            .read()
            .records
            .get(id)
            .is_some_and(|record| record.granted_permissions.contains(permission))
    }

    pub fn scan(&self) -> Result<ScanReport> {
        let _operation = self.operation_lock.lock();
        self.scan_locked()
    }

    fn scan_locked(&self) -> Result<ScanReport> {
        let mut candidates = Vec::new();
        let mut rejected = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    rejected.push(ScanIssue {
                        path: self.root.clone(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                rejected.push(ScanIssue {
                    path: entry.path(),
                    error: "plugin directory name is not UTF-8".to_owned(),
                });
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    rejected.push(ScanIssue {
                        path: entry.path(),
                        error: error.to_string(),
                    });
                    continue;
                }
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                rejected.push(ScanIssue {
                    path: entry.path(),
                    error: "plugin root must be a real directory".to_owned(),
                });
                continue;
            }
            if let Err(error) = validate_plugin_id(name) {
                rejected.push(ScanIssue {
                    path: entry.path(),
                    error: error.to_string(),
                });
                continue;
            }
            match self.validate_package_directory(&entry.path()) {
                Ok(package) if package.manifest.id == name => candidates.push((entry.path(), package)),
                Ok(package) => rejected.push(ScanIssue {
                    path: entry.path(),
                    error: format!(
                        "manifest id `{}` does not match directory `{name}`",
                        package.manifest.id
                    ),
                }),
                Err(error) => rejected.push(ScanIssue {
                    path: entry.path(),
                    error: error.to_string(),
                }),
            }
        }
        candidates.sort_by(|a, b| a.1.manifest.id.cmp(&b.1.manifest.id));

        let state_snapshot = self.state.read().clone();
        let mut state = self.state.write();
        let mut records = BTreeMap::new();
        for (path, package) in candidates {
            let id = package.manifest.id.clone();
            let requested = package.manifest.requested_permissions();
            let persisted = state
                .registry
                .plugins
                .entry(id.clone())
                .or_insert_with(|| PersistedPluginState {
                    enabled: false,
                    origin: PluginOrigin::User,
                    granted_permissions: BTreeSet::new(),
                });
            persisted
                .granted_permissions
                .retain(|permission| requested.contains(permission) && self.permission_registry.contains(permission));
            let missing = requested
                .difference(&persisted.granted_permissions)
                .cloned()
                .collect::<BTreeSet<_>>();
            if !missing.is_empty() {
                persisted.enabled = false;
            }
            records.insert(
                id.clone(),
                PluginRecord {
                    id,
                    manifest: package.manifest,
                    root: path,
                    origin: persisted.origin,
                    enabled: persisted.enabled,
                    granted_permissions: persisted.granted_permissions.clone(),
                    missing_permissions: missing,
                    file_count: package.file_count,
                    total_bytes: package.total_bytes,
                },
            );
        }
        state.records = records;
        let registry = state.registry.clone();
        let plugins = state.records.values().cloned().collect();
        drop(state);
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            return Err(error);
        }
        Ok(ScanReport { plugins, rejected })
    }

    fn validate_package_directory(&self, root: &Path) -> Result<ValidatedPackage> {
        let root_metadata = fs::symlink_metadata(root)?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(PluginError::UnsupportedFileType(root.to_path_buf()));
        }
        let canonical_root = fs::canonicalize(root)?;
        let mut paths = BTreeMap::<String, String>::new();
        let mut file_count = 0usize;
        let mut total_bytes = 0u64;
        let mut manifest_bytes = None;

        for entry in WalkDir::new(root).follow_links(false).min_depth(1) {
            let entry = entry.map_err(|error| {
                PluginError::Operation(format!("walk failed below {}: {error}", root.display()))
            })?;
            let absolute = entry.path();
            let relative = absolute.strip_prefix(root).map_err(|_| {
                PluginError::InvalidPath {
                    path: absolute.display().to_string(),
                    reason: "path escaped plugin root".to_owned(),
                }
            })?;
            let relative = relative.to_str().ok_or_else(|| PluginError::InvalidPath {
                path: relative.display().to_string(),
                reason: "path is not UTF-8".to_owned(),
            })?;
            let normalized = relative.replace(std::path::MAIN_SEPARATOR, "/");
            validate_payload_path(&normalized, &self.limits)?;
            let key = collision_key(&normalized);
            if let Some(first) = paths.insert(key, normalized.clone()) {
                return Err(PluginError::PathCollision {
                    first,
                    second: normalized,
                });
            }
            let metadata = fs::symlink_metadata(absolute)?;
            if metadata.file_type().is_symlink() {
                return Err(PluginError::UnsupportedFileType(absolute.to_path_buf()));
            }
            if metadata.is_dir() {
                continue;
            }
            if !metadata.is_file() {
                return Err(PluginError::UnsupportedFileType(absolute.to_path_buf()));
            }
            let canonical_file = fs::canonicalize(absolute)?;
            if !canonical_file.starts_with(&canonical_root) {
                return Err(PluginError::InvalidPath {
                    path: normalized,
                    reason: "canonical path escaped plugin root".to_owned(),
                });
            }
            file_count = file_count
                .checked_add(1)
                .ok_or_else(|| PluginError::LimitExceeded("file count overflow".to_owned()))?;
            if file_count > self.limits.max_files {
                return Err(PluginError::LimitExceeded(format!(
                    "package has more than {} files",
                    self.limits.max_files
                )));
            }
            let size = metadata.len();
            if size > self.limits.max_file_bytes {
                return Err(PluginError::LimitExceeded(format!(
                    "file `{normalized}` exceeds {} bytes",
                    self.limits.max_file_bytes
                )));
            }
            total_bytes = total_bytes
                .checked_add(size)
                .ok_or_else(|| PluginError::LimitExceeded("package size overflow".to_owned()))?;
            if total_bytes > self.limits.max_total_bytes {
                return Err(PluginError::LimitExceeded(format!(
                    "package exceeds {} bytes",
                    self.limits.max_total_bytes
                )));
            }
            if normalized == PLUGIN_MANIFEST_FILE {
                if size > self.limits.max_manifest_bytes {
                    return Err(PluginError::LimitExceeded(format!(
                        "manifest exceeds {} bytes",
                        self.limits.max_manifest_bytes
                    )));
                }
                manifest_bytes = Some(fs::read(absolute)?);
            }
        }
        let manifest_bytes = manifest_bytes.ok_or_else(|| {
            PluginError::InvalidManifest(format!("missing `{PLUGIN_MANIFEST_FILE}`"))
        })?;
        let manifest = PluginManifestV2::parse_and_validate(
            &manifest_bytes,
            &self.supported_api_version,
            &self.permission_registry,
            &self.limits,
        )?;
        if let Some(ui) = &manifest.ui {
            ensure_regular_entry(root, &ui.entry, &self.limits)?;
        }
        if let Some(backend) = &manifest.backend {
            ensure_regular_entry(root, &backend.entry, &self.limits)?;
        }
        Ok(ValidatedPackage {
            manifest,
            file_count,
            total_bytes,
        })
    }

    #[cfg(test)]
    pub fn fail_next_cutover_after_backup_for_test(&self) {
        self.fail_after_backup_once.store(true, Ordering::SeqCst);
    }
}

mod install;
mod lifecycle;
mod registry;
mod validation;

pub use validation::{validate_payload_path, validate_plugin_id};
use validation::{
    collision_key, validate_optional_field, validate_optional_string, validate_permission_name,
    validate_trimmed_field,
};
use registry::{
    cleanup_directory_contents, ensure_regular_entry, ensure_root_directory, load_registry,
    persist_registry, recover_interrupted_installs, recover_registry_file,
};
