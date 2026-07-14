//! Aktivieren/Deaktivieren, Berechtigungen, Deinstallation und Installation
//! (Verzeichnis/Payload).

use super::*;

impl PluginService {
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
}
