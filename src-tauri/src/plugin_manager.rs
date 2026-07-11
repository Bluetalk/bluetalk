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

fn validate_permission_name(permission: &str) -> Result<()> {
    if permission.is_empty() || permission.len() > 96 || !permission.is_ascii() {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    }
    let mut parts = permission.split(':');
    let Some(namespace) = parts.next() else {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    };
    let Some(action) = parts.next() else {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    };
    if parts.next().is_some()
        || namespace.is_empty()
        || action.is_empty()
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !action
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    }
    Ok(())
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

pub fn validate_plugin_id(id: &str) -> Result<()> {
    const RESERVED: [&str; 3] = ["constructor", "prototype", "__proto__"];
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.is_ascii()
        && !RESERVED.contains(&id)
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.'))
        && id
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && id
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric);
    if !valid {
        return Err(PluginError::InvalidManifest(format!(
            "invalid plugin id `{id}`"
        )));
    }
    Ok(())
}

fn validate_trimmed_field(name: &str, value: &str, min: usize, max: usize) -> Result<()> {
    if value.trim() != value || value.len() < min || value.len() > max || value.contains('\0') {
        return Err(PluginError::InvalidManifest(format!(
            "{name} must be trimmed and between {min} and {max} bytes"
        )));
    }
    Ok(())
}

fn validate_optional_field(name: &str, value: &str, max: usize) -> Result<()> {
    if value.len() > max || value.contains('\0') {
        return Err(PluginError::InvalidManifest(format!(
            "{name} exceeds {max} bytes"
        )));
    }
    Ok(())
}

fn validate_optional_string(name: &str, value: Option<&str>, max: usize) -> Result<()> {
    if let Some(value) = value {
        if value.trim() != value || value.is_empty() || value.len() > max || value.contains('\0') {
            return Err(PluginError::InvalidManifest(format!(
                "{name} must be non-empty, trimmed and at most {max} bytes"
            )));
        }
    }
    Ok(())
}

/// Validates a canonical package-relative path and returns its platform path.
///
/// Package paths intentionally use a conservative ASCII alphabet. Apart from
/// making package URLs predictable this prevents NFC/NFD and Unicode case-fold
/// aliases across Windows, macOS and Linux without trusting the host filesystem.
pub fn validate_payload_path(raw: &str, limits: &PluginLimits) -> Result<PathBuf> {
    if raw.is_empty() {
        return invalid_path(raw, "path is empty");
    }
    if !raw.is_ascii() {
        return invalid_path(raw, "package paths must be ASCII");
    }
    if raw.len() > limits.max_relative_path_bytes {
        return invalid_path(raw, "path is too long");
    }
    if raw.starts_with('/') || raw.starts_with('\\') || raw.contains('\\') {
        return invalid_path(raw, "absolute, UNC and backslash paths are forbidden");
    }
    if raw.contains(':') || raw.contains('%') || raw.contains('?') || raw.contains('#') {
        return invalid_path(raw, "path contains an ambiguous or reserved character");
    }

    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() > limits.max_depth {
        return invalid_path(raw, "path nesting is too deep");
    }
    let mut path = PathBuf::new();
    for part in parts {
        if part.is_empty() || part == "." || part == ".." {
            return invalid_path(raw, "empty, dot and parent components are forbidden");
        }
        if part.len() > limits.max_component_bytes {
            return invalid_path(raw, "a path component is too long");
        }
        if part.starts_with('.') || part.ends_with('.') || part.ends_with(' ') {
            return invalid_path(raw, "hidden and trailing-dot/space components are forbidden");
        }
        if !part.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@' | b'+')
        }) {
            return invalid_path(raw, "path contains unsupported characters");
        }
        if is_windows_reserved_component(part) {
            return invalid_path(raw, "path uses a reserved Windows device name");
        }
        path.push(part);
    }
    Ok(path)
}

fn invalid_path<T>(raw: &str, reason: &str) -> Result<T> {
    Err(PluginError::InvalidPath {
        path: raw.to_owned(),
        reason: reason.to_owned(),
    })
}

fn is_windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
            })
}

fn collision_key(path: &str) -> String {
    path.to_ascii_lowercase()
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

    pub fn install_from_directory(
        &self,
        source: impl AsRef<Path>,
        options: InstallOptions,
    ) -> Result<PluginRecord> {
        let _operation = self.operation_lock.lock();
        let staging = StagingDirectory::create(&self.root)?;
        self.copy_package_directory(source.as_ref(), staging.plugin_path())?;
        let package = self.validate_package_directory(staging.plugin_path())?;
        self.finish_install(staging, package, options)
    }

    pub fn install_payload(
        &self,
        files: Vec<PluginPayloadFile>,
        options: InstallOptions,
    ) -> Result<PluginRecord> {
        let _operation = self.operation_lock.lock();
        let staging = StagingDirectory::create(&self.root)?;
        self.write_payload(files, staging.plugin_path())?;
        let package = self.validate_package_directory(staging.plugin_path())?;
        self.finish_install(staging, package, options)
    }

    fn finish_install(
        &self,
        staging: StagingDirectory,
        package: ValidatedPackage,
        options: InstallOptions,
    ) -> Result<PluginRecord> {
        let id = package.manifest.id.clone();
        if let Some(expected_id) = &options.expected_id {
            validate_plugin_id(expected_id)?;
            if expected_id != &id {
                return Err(PluginError::InvalidManifest(format!(
                    "manifest id `{id}` does not match expected id `{expected_id}`"
                )));
            }
        }
        let existing = self.state.read().records.get(&id).cloned();
        let target = self.root.join(&id);
        let target_exists = target.exists();
        // Only a *registered* plugin blocks a non-replacing install. A bare
        // directory with no registry record (e.g. an orphan left by an earlier
        // seeding path) is safely overwritten — the swap below backs it up.
        if target_exists && !options.replace_existing && existing.is_some() {
            return Err(PluginError::AlreadyInstalled(id));
        }
        if existing
            .as_ref()
            .is_some_and(|record| record.origin == PluginOrigin::Bundled && options.origin == PluginOrigin::User)
        {
            return Err(PluginError::BundledConflict(id));
        }
        if let Some(existing) = &existing {
            if package.manifest.version < existing.manifest.version && !options.allow_downgrade {
                return Err(PluginError::DowngradeNotAllowed {
                    plugin_id: id,
                    installed: existing.manifest.version.clone(),
                    candidate: package.manifest.version,
                });
            }
        }

        let requested = package.manifest.requested_permissions();
        for grant in &options.grants {
            if !self.permission_registry.contains(grant) {
                return Err(PluginError::UnknownPermission(grant.clone()));
            }
            if !requested.contains(grant) {
                return Err(PluginError::PermissionNotRequested {
                    plugin_id: id.clone(),
                    permission: grant.clone(),
                });
            }
        }
        let mut grants = existing
            .as_ref()
            .map(|record| record.granted_permissions.clone())
            .unwrap_or_default();
        grants.retain(|permission| requested.contains(permission));
        grants.extend(options.grants.iter().cloned());
        let missing = requested
            .difference(&grants)
            .cloned()
            .collect::<BTreeSet<_>>();
        let desired_enabled = options.enabled.unwrap_or_else(|| {
            existing.as_ref().is_some_and(|record| record.enabled)
        });
        if desired_enabled && !missing.is_empty() && options.enabled == Some(true) {
            return Err(PluginError::MissingPermissions {
                plugin_id: id,
                permissions: missing.iter().cloned().collect(),
            });
        }
        let enabled = desired_enabled && missing.is_empty();

        let backup = self
            .root
            .join(BACKUP_DIR)
            .join(format!("{}--{}", package.manifest.id, Uuid::new_v4()));
        if target_exists {
            fs::rename(&target, &backup)?;
        }

        #[cfg(test)]
        if self.fail_after_backup_once.swap(false, Ordering::SeqCst) {
            if target_exists {
                fs::rename(&backup, &target)?;
            }
            return Err(PluginError::Operation(
                "injected failure after backup".to_owned(),
            ));
        }

        if let Err(error) = fs::rename(staging.plugin_path(), &target) {
            if target_exists {
                let _ = fs::rename(&backup, &target);
            }
            return Err(error.into());
        }

        let record = PluginRecord {
            id: package.manifest.id.clone(),
            manifest: package.manifest,
            root: target.clone(),
            origin: options.origin,
            enabled,
            granted_permissions: grants.clone(),
            missing_permissions: missing,
            file_count: package.file_count,
            total_bytes: package.total_bytes,
        };
        let state_snapshot = self.state.read().clone();
        let registry = {
            let mut state = self.state.write();
            state.records.insert(record.id.clone(), record.clone());
            state.registry.plugins.insert(
                record.id.clone(),
                PersistedPluginState {
                    enabled: record.enabled,
                    origin: record.origin,
                    granted_permissions: grants,
                },
            );
            state.registry.clone()
        };
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            let failed = self
                .root
                .join(TRASH_DIR)
                .join(format!("{}--failed--{}", record.id, Uuid::new_v4()));
            let _ = fs::rename(&target, &failed);
            if target_exists {
                let _ = fs::rename(&backup, &target);
            }
            let _ = fs::remove_dir_all(failed);
            return Err(error);
        }
        if target_exists {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(record)
    }

    pub fn set_grants<I, S>(&self, id: &str, grants: I) -> Result<PluginRecord>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let _operation = self.operation_lock.lock();
        validate_plugin_id(id)?;
        let grants = grants.into_iter().map(Into::into).collect::<BTreeSet<_>>();
        let state_snapshot = self.state.read().clone();
        let registry = {
            let mut state = self.state.write();
            let record = state
                .records
                .get_mut(id)
                .ok_or_else(|| PluginError::NotFound(id.to_owned()))?;
            let requested = record.manifest.requested_permissions();
            for permission in &grants {
                if !self.permission_registry.contains(permission) {
                    return Err(PluginError::UnknownPermission(permission.clone()));
                }
                if !requested.contains(permission) {
                    return Err(PluginError::PermissionNotRequested {
                        plugin_id: id.to_owned(),
                        permission: permission.clone(),
                    });
                }
            }
            let missing = requested
                .difference(&grants)
                .cloned()
                .collect::<BTreeSet<_>>();
            record.granted_permissions = grants.clone();
            record.missing_permissions = missing.clone();
            if !missing.is_empty() {
                record.enabled = false;
            }
            let enabled = record.enabled;
            let origin = record.origin;
            state.registry.plugins.insert(
                id.to_owned(),
                PersistedPluginState {
                    enabled,
                    origin,
                    granted_permissions: grants,
                },
            );
            state.registry.clone()
        };
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            return Err(error);
        }
        self.get(id).ok_or_else(|| PluginError::NotFound(id.to_owned()))
    }

    pub fn grant(&self, id: &str, permission: &str) -> Result<PluginRecord> {
        let mut grants = self
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_owned()))?
            .granted_permissions;
        grants.insert(permission.to_owned());
        self.set_grants(id, grants)
    }

    pub fn revoke(&self, id: &str, permission: &str) -> Result<PluginRecord> {
        let mut grants = self
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_owned()))?
            .granted_permissions;
        grants.remove(permission);
        self.set_grants(id, grants)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<PluginRecord> {
        let _operation = self.operation_lock.lock();
        validate_plugin_id(id)?;
        let state_snapshot = self.state.read().clone();
        let registry = {
            let mut state = self.state.write();
            let record = state
                .records
                .get_mut(id)
                .ok_or_else(|| PluginError::NotFound(id.to_owned()))?;
            if enabled && !record.missing_permissions.is_empty() {
                return Err(PluginError::MissingPermissions {
                    plugin_id: id.to_owned(),
                    permissions: record.missing_permissions.iter().cloned().collect(),
                });
            }
            record.enabled = enabled;
            let persisted = state
                .registry
                .plugins
                .get_mut(id)
                .ok_or_else(|| PluginError::CorruptRegistry(format!("missing state for `{id}`")))?;
            persisted.enabled = enabled;
            state.registry.clone()
        };
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            return Err(error);
        }
        self.get(id).ok_or_else(|| PluginError::NotFound(id.to_owned()))
    }

    pub fn uninstall(&self, id: &str) -> Result<bool> {
        let _operation = self.operation_lock.lock();
        validate_plugin_id(id)?;
        let record = match self.state.read().records.get(id).cloned() {
            Some(record) => record,
            None => return Ok(false),
        };
        let target = self.root.join(id);
        let trash = self
            .root
            .join(TRASH_DIR)
            .join(format!("{}--{}", id, Uuid::new_v4()));
        if target.exists() {
            fs::rename(&target, &trash)?;
        }
        let state_snapshot = self.state.read().clone();
        let registry = {
            let mut state = self.state.write();
            state.records.remove(id);
            state.registry.plugins.remove(id);
            if record.origin == PluginOrigin::Bundled {
                state.registry.removed_bundled.insert(id.to_owned());
            }
            state.registry.clone()
        };
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            if trash.exists() {
                let _ = fs::rename(&trash, &target);
            }
            return Err(error);
        }
        if trash.exists() {
            fs::remove_dir_all(trash)?;
        }
        Ok(true)
    }

    pub fn is_bundled_removed(&self, id: &str) -> bool {
        self.state.read().registry.removed_bundled.contains(id)
    }

    pub fn clear_bundled_removal(&self, id: &str) -> Result<()> {
        let _operation = self.operation_lock.lock();
        validate_plugin_id(id)?;
        let state_snapshot = self.state.read().clone();
        let registry = {
            let mut state = self.state.write();
            state.registry.removed_bundled.remove(id);
            state.registry.clone()
        };
        if let Err(error) = persist_registry(&self.root, &registry) {
            *self.state.write() = state_snapshot;
            return Err(error);
        }
        Ok(())
    }

    /// Seeds versioned, manifest-v2 plugin directories shipped with the app.
    ///
    /// This hook never downgrades and never replaces a user-origin plugin. A
    /// same-version package is skipped: bundled changes therefore require a
    /// manifest version bump.
    pub fn seed_bundled_from(
        &self,
        bundled_root: impl AsRef<Path>,
        options: BundledSeedOptions,
    ) -> BundledSeedReport {
        let bundled_root = bundled_root.as_ref();
        let mut report = BundledSeedReport::default();
        let entries = match fs::read_dir(bundled_root) {
            Ok(entries) => entries,
            Err(error) => {
                report.errors.push((
                    bundled_root.display().to_string(),
                    error.to_string(),
                ));
                return report;
            }
        };
        let mut sources = entries.filter_map(std::result::Result::ok).collect::<Vec<_>>();
        sources.sort_by_key(|entry| entry.file_name());
        for entry in sources {
            let source = entry.path();
            let source_label = entry.file_name().to_string_lossy().into_owned();
            let package = match self.validate_package_directory(&source) {
                Ok(package) => package,
                Err(error) => {
                    report.errors.push((source_label, error.to_string()));
                    continue;
                }
            };
            let id = package.manifest.id.clone();
            if self.is_bundled_removed(&id) && !options.restore_removed {
                report.skipped.push(id);
                continue;
            }
            let existing = self.get(&id);
            if existing
                .as_ref()
                .is_some_and(|record| record.origin == PluginOrigin::User)
            {
                report.errors.push((
                    id,
                    "bundled plugin conflicts with a user-origin plugin".to_owned(),
                ));
                continue;
            }
            if existing.as_ref().is_some_and(|record| {
                package.manifest.version <= record.manifest.version
            }) {
                report.skipped.push(id);
                continue;
            }
            let grants = if options.grant_all_requested {
                package.manifest.requested_permissions()
            } else {
                BTreeSet::new()
            };
            let install_options = InstallOptions {
                origin: PluginOrigin::Bundled,
                replace_existing: existing.is_some(),
                allow_downgrade: false,
                enabled: if existing.is_some() {
                    None
                } else {
                    Some(options.enable_new)
                },
                grants,
                expected_id: Some(id.clone()),
            };
            match self.install_from_directory(&source, install_options) {
                Ok(_) => {
                    if options.restore_removed {
                        if let Err(error) = self.clear_bundled_removal(&id) {
                            report.errors.push((id.clone(), error.to_string()));
                            continue;
                        }
                    }
                    if existing.is_some() {
                        report.updated.push(id);
                    } else {
                        report.installed.push(id);
                    }
                }
                Err(error) => report.errors.push((id, error.to_string())),
            }
        }
        report
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

    fn copy_package_directory(&self, source: &Path, destination: &Path) -> Result<()> {
        // Validate before copying for early rejection, then validate the staged
        // copy again before cutover to close mutation and partial-copy gaps.
        self.validate_package_directory(source)?;
        let source_root = fs::canonicalize(source)?;
        fs::create_dir_all(destination)?;
        let mut file_count = 0usize;
        let mut total_bytes = 0u64;
        let mut paths = BTreeMap::<String, String>::new();
        for entry in WalkDir::new(source).follow_links(false).min_depth(1) {
            let entry = entry.map_err(|error| {
                PluginError::Operation(format!("walk failed below {}: {error}", source.display()))
            })?;
            let src = entry.path();
            let relative = src.strip_prefix(source).map_err(|_| PluginError::InvalidPath {
                path: src.display().to_string(),
                reason: "path escaped source root".to_owned(),
            })?;
            let relative_string = relative.to_str().ok_or_else(|| PluginError::InvalidPath {
                path: relative.display().to_string(),
                reason: "path is not UTF-8".to_owned(),
            })?;
            let normalized = relative_string.replace(std::path::MAIN_SEPARATOR, "/");
            let safe_relative = validate_payload_path(&normalized, &self.limits)?;
            let key = collision_key(&normalized);
            if let Some(first) = paths.insert(key, normalized.clone()) {
                return Err(PluginError::PathCollision {
                    first,
                    second: normalized,
                });
            }
            let metadata = fs::symlink_metadata(src)?;
            if metadata.file_type().is_symlink() {
                return Err(PluginError::UnsupportedFileType(src.to_path_buf()));
            }
            let dest = destination.join(safe_relative);
            if metadata.is_dir() {
                fs::create_dir(&dest)?;
                continue;
            }
            if !metadata.is_file() {
                return Err(PluginError::UnsupportedFileType(src.to_path_buf()));
            }
            let canonical_file = fs::canonicalize(src)?;
            if !canonical_file.starts_with(&source_root) {
                return Err(PluginError::InvalidPath {
                    path: normalized,
                    reason: "canonical source path escaped plugin root".to_owned(),
                });
            }
            file_count += 1;
            if file_count > self.limits.max_files {
                return Err(PluginError::LimitExceeded(format!(
                    "package has more than {} files",
                    self.limits.max_files
                )));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file_bounded(
                src,
                &dest,
                &mut total_bytes,
                &self.limits,
                &normalized,
            )?;
        }
        Ok(())
    }

    fn write_payload(&self, files: Vec<PluginPayloadFile>, destination: &Path) -> Result<()> {
        if files.is_empty() {
            return Err(PluginError::InvalidManifest("payload is empty".to_owned()));
        }
        if files.len() > self.limits.max_files {
            return Err(PluginError::LimitExceeded(format!(
                "payload has more than {} files",
                self.limits.max_files
            )));
        }
        let mut validated = Vec::with_capacity(files.len());
        let mut paths = BTreeMap::<String, String>::new();
        let mut total_bytes = 0u64;
        for file in files {
            let relative = validate_payload_path(&file.path, &self.limits)?;
            let key = collision_key(&file.path);
            if let Some(first) = paths.insert(key, file.path.clone()) {
                return Err(PluginError::PathCollision {
                    first,
                    second: file.path,
                });
            }
            let size = file.bytes.len() as u64;
            if size > self.limits.max_file_bytes {
                return Err(PluginError::LimitExceeded(format!(
                    "file `{}` exceeds {} bytes",
                    file.path, self.limits.max_file_bytes
                )));
            }
            if file.path == PLUGIN_MANIFEST_FILE && size > self.limits.max_manifest_bytes {
                return Err(PluginError::LimitExceeded(format!(
                    "manifest exceeds {} bytes",
                    self.limits.max_manifest_bytes
                )));
            }
            total_bytes = total_bytes
                .checked_add(size)
                .ok_or_else(|| PluginError::LimitExceeded("payload size overflow".to_owned()))?;
            if total_bytes > self.limits.max_total_bytes {
                return Err(PluginError::LimitExceeded(format!(
                    "payload exceeds {} bytes",
                    self.limits.max_total_bytes
                )));
            }
            validated.push((relative, file.bytes));
        }
        fs::create_dir_all(destination)?;
        for (relative, bytes) in validated {
            let target = destination.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(target)?;
            output.write_all(&bytes)?;
            output.sync_all()?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn fail_next_cutover_after_backup_for_test(&self) {
        self.fail_after_backup_once.store(true, Ordering::SeqCst);
    }
}

fn ensure_regular_entry(root: &Path, raw: &str, limits: &PluginLimits) -> Result<()> {
    let relative = validate_payload_path(raw, limits)?;
    let entry = root.join(relative);
    let metadata = fs::symlink_metadata(&entry).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            PluginError::InvalidManifest(format!("entry `{raw}` does not exist"))
        } else {
            PluginError::Io(error)
        }
    })?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PluginError::InvalidManifest(format!(
            "entry `{raw}` is not a regular file"
        )));
    }
    Ok(())
}

fn copy_file_bounded(
    source: &Path,
    destination: &Path,
    package_bytes: &mut u64,
    limits: &PluginLimits,
    display_path: &str,
) -> Result<()> {
    let mut input = File::open(source)?;
    let opened_metadata = input.metadata()?;
    if !opened_metadata.is_file() {
        return Err(PluginError::UnsupportedFileType(source.to_path_buf()));
    }
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)?;
    let mut file_bytes = 0u64;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        file_bytes = file_bytes
            .checked_add(read as u64)
            .ok_or_else(|| PluginError::LimitExceeded("file size overflow".to_owned()))?;
        if file_bytes > limits.max_file_bytes {
            return Err(PluginError::LimitExceeded(format!(
                "file `{display_path}` exceeds {} bytes while copying",
                limits.max_file_bytes
            )));
        }
        *package_bytes = package_bytes
            .checked_add(read as u64)
            .ok_or_else(|| PluginError::LimitExceeded("package size overflow".to_owned()))?;
        if *package_bytes > limits.max_total_bytes {
            return Err(PluginError::LimitExceeded(format!(
                "package exceeds {} bytes while copying",
                limits.max_total_bytes
            )));
        }
        output.write_all(&buffer[..read])?;
    }
    output.sync_all()?;
    Ok(())
}

struct StagingDirectory {
    container: PathBuf,
    plugin: PathBuf,
}

impl StagingDirectory {
    fn create(root: &Path) -> Result<Self> {
        let container = root.join(STAGING_DIR).join(Uuid::new_v4().to_string());
        let plugin = container.join("plugin");
        fs::create_dir_all(&plugin)?;
        Ok(Self { container, plugin })
    }

    fn plugin_path(&self) -> &Path {
        &self.plugin
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.container);
    }
}

fn ensure_root_directory(root: &Path) -> Result<()> {
    if root.exists() {
        let metadata = fs::symlink_metadata(root)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PluginError::UnsupportedFileType(root.to_path_buf()));
        }
    } else {
        fs::create_dir_all(root)?;
    }
    Ok(())
}

fn registry_path(root: &Path) -> PathBuf {
    root.join(REGISTRY_FILE)
}

fn registry_backup_path(root: &Path) -> PathBuf {
    root.join(REGISTRY_BACKUP_FILE)
}

fn load_registry(root: &Path) -> Result<PersistedRegistry> {
    let path = registry_path(root);
    if !path.exists() {
        return Ok(PersistedRegistry::default());
    }
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(PluginError::CorruptRegistry(
            "registry path is not a regular file".to_owned(),
        ));
    }
    if metadata.len() > MAX_REGISTRY_BYTES {
        return Err(PluginError::CorruptRegistry(
            "registry exceeds its size limit".to_owned(),
        ));
    }
    let registry: PersistedRegistry = serde_json::from_slice(&fs::read(path)?)?;
    if registry.format_version != REGISTRY_FORMAT_VERSION {
        return Err(PluginError::CorruptRegistry(format!(
            "unsupported registry format {}",
            registry.format_version
        )));
    }
    for (id, state) in &registry.plugins {
        validate_plugin_id(id).map_err(|error| PluginError::CorruptRegistry(error.to_string()))?;
        for permission in &state.granted_permissions {
            validate_permission_name(permission)
                .map_err(|error| PluginError::CorruptRegistry(error.to_string()))?;
        }
    }
    for id in &registry.removed_bundled {
        validate_plugin_id(id).map_err(|error| PluginError::CorruptRegistry(error.to_string()))?;
    }
    Ok(registry)
}

fn persist_registry(root: &Path, registry: &PersistedRegistry) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(registry)?;
    if bytes.len() as u64 > MAX_REGISTRY_BYTES {
        return Err(PluginError::LimitExceeded(
            "plugin registry exceeds its size limit".to_owned(),
        ));
    }
    let target = registry_path(root);
    let backup = registry_backup_path(root);
    let temp = root.join(format!("{REGISTRY_FILE}.{}.tmp", Uuid::new_v4()));
    {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    if backup.exists() {
        fs::remove_file(&backup)?;
    }
    let had_target = target.exists();
    if had_target {
        fs::rename(&target, &backup)?;
    }
    if let Err(error) = fs::rename(&temp, &target) {
        if had_target {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_file(&temp);
        return Err(error.into());
    }
    if had_target {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn recover_registry_file(root: &Path) -> Result<()> {
    let target = registry_path(root);
    let backup = registry_backup_path(root);
    if !target.exists() && backup.exists() {
        fs::rename(backup, target)?;
    } else if target.exists() && backup.exists() {
        fs::remove_file(backup)?;
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&format!("{REGISTRY_FILE}.")) && name.ends_with(".tmp") {
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                fs::remove_file(entry.path())?;
            }
        }
    }
    Ok(())
}

fn recover_interrupted_installs(root: &Path) -> Result<()> {
    let backup_root = root.join(BACKUP_DIR);
    fs::create_dir_all(&backup_root)?;
    let mut entries = fs::read_dir(&backup_root)?
        .filter_map(std::result::Result::ok)
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(PluginError::UnsupportedFileType(entry.path()));
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some((id, _transaction)) = name.split_once("--") else {
            return Err(PluginError::CorruptRegistry(format!(
                "invalid backup directory `{name}`"
            )));
        };
        validate_plugin_id(id).map_err(|error| PluginError::CorruptRegistry(error.to_string()))?;
        let target = root.join(id);
        if target.exists() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::rename(entry.path(), target)?;
        }
    }
    Ok(())
}

fn cleanup_directory_contents(directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(PluginError::UnsupportedFileType(entry.path()));
        }
        if metadata.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else if metadata.is_file() {
            fs::remove_file(entry.path())?;
        } else {
            return Err(PluginError::UnsupportedFileType(entry.path()));
        }
    }
    Ok(())
}
