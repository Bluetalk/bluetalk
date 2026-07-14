//! Registry-Persistenz (atomar), Wiederherstellung unterbrochener
//! Installationen, Staging-Verzeichnisse und begrenztes Datei-Kopieren.

use super::*;
use super::validation::{validate_payload_path, validate_permission_name, validate_plugin_id};

pub(super) fn ensure_regular_entry(root: &Path, raw: &str, limits: &PluginLimits) -> Result<()> {
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

pub(super) fn copy_file_bounded(
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

pub(super) struct StagingDirectory {
    container: PathBuf,
    plugin: PathBuf,
}

impl StagingDirectory {
    pub(super) fn create(root: &Path) -> Result<Self> {
        let container = root.join(STAGING_DIR).join(Uuid::new_v4().to_string());
        let plugin = container.join("plugin");
        fs::create_dir_all(&plugin)?;
        Ok(Self { container, plugin })
    }

    pub(super) fn plugin_path(&self) -> &Path {
        &self.plugin
    }
}

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.container);
    }
}

pub(super) fn ensure_root_directory(root: &Path) -> Result<()> {
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

pub(super) fn load_registry(root: &Path) -> Result<PersistedRegistry> {
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

pub(super) fn persist_registry(root: &Path, registry: &PersistedRegistry) -> Result<()> {
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

pub(super) fn recover_registry_file(root: &Path) -> Result<()> {
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

pub(super) fn recover_interrupted_installs(root: &Path) -> Result<()> {
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

pub(super) fn cleanup_directory_contents(directory: &Path) -> Result<()> {
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
