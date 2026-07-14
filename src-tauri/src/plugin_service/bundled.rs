//! Bundled-Plugin-Seeding, Rescan und Legacy-Paket-Kopie.

use super::*;
use super::helpers::{legacy_should_update, read_lenient_manifest};

impl PluginService {
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

}
