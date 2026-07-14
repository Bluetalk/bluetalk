//! Lebenszyklus & Berechtigungen: Grants setzen, gewähren/entziehen,
//! aktivieren/deaktivieren, deinstallieren, Bundled-Entfernung.

use super::*;
use super::registry::persist_registry;
use super::validation::validate_plugin_id;

impl PluginManager {
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
}
