//! Installation von Plugins (Verzeichnis/Payload) mit atomarem Cutover,
//! Paket-Kopie und Bundled-Seeding.

use super::*;
use super::registry::{StagingDirectory, copy_file_bounded, persist_registry};
use super::validation::{collision_key, validate_payload_path, validate_plugin_id};

impl PluginManager {
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

}
