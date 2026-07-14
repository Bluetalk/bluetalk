//! KV-Helfer, Runtime-Modus/-Verzeichnisse und Zustands-Zugriff (state,
//! state_value, broadcast). Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    // -- KV-Helfer ----------------------------------------------------------

    pub fn kv_get(&self, key: &str, default: Value) -> Value {
        self.database
            .get(key, default.clone())
            .unwrap_or(default)
    }

    pub fn kv_get_string(&self, key: &str, default: &str) -> String {
        match self.kv_get(key, json!(default)) {
            Value::String(s) => s,
            other => other.as_str().map(str::to_string).unwrap_or_else(|| default.to_string()),
        }
    }

    pub fn kv_get_bool(&self, key: &str, default: bool) -> bool {
        self.kv_get(key, json!(default)).as_bool().unwrap_or(default)
    }

    pub fn kv_set(&self, key: &str, value: Value) {
        if let Err(error) = self.database.set(key, value) {
            log::warn!("[ollama] KV-Set fehlgeschlagen ({key}): {error}");
        }
    }

    pub fn kv_delete(&self, key: &str) {
        if let Err(error) = self.database.delete(key) {
            log::warn!("[ollama] KV-Delete fehlgeschlagen ({key}): {error}");
        }
    }

    // -- Runtime-Modus / Verzeichnisse ---------------------------------------

    pub fn runtime_mode(&self) -> String {
        self.inner.lock().runtime_mode.clone()
    }

    pub fn is_system_runtime(&self) -> bool {
        self.runtime_mode() == catalog::OLLAMA_RUNTIME_MODE_SYSTEM
    }

    pub fn runtime_port(&self) -> u16 {
        if self.is_system_runtime() {
            catalog::OLLAMA_SYSTEM_PORT
        } else {
            catalog::OLLAMA_DEFAULT_PORT
        }
    }

    pub fn api_base(&self) -> String {
        format!("http://127.0.0.1:{}", self.runtime_port())
    }

    pub(super) fn apply_runtime_mode(&self) {
        let stored = self.kv_get_string("aiChat.ollamaRuntimeMode", "");
        let mode = catalog::resolve_runtime_mode(&stored).to_string();
        let resolved = if mode == catalog::OLLAMA_RUNTIME_MODE_SYSTEM {
            paths::resolve_system_ollama_models_dir()
        } else {
            paths::resolve_ollama_models_dir(&self.data_dir)
        };
        let mut inner = self.inner.lock();
        inner.runtime_mode = mode.clone();
        inner.models_dir = resolved.dir;
        inner.models_dir_source = resolved.source;
        inner.state.runtime_mode = mode;
    }

    pub(super) async fn prepare_models_dir(&self) -> Result<(), String> {
        let preferred = paths::resolve_ollama_models_dir(&self.data_dir);
        let fallback = paths::ResolvedModelsDir {
            dir: paths::default_models_dir(&self.data_dir),
            source: "userData-fallback".into(),
        };
        let mut candidates: Vec<paths::ResolvedModelsDir> = Vec::new();
        let public_fallback = if cfg!(windows) && preferred.source == "windows-safe" {
            Some(paths::ResolvedModelsDir {
                dir: paths::windows_public_models_dir(),
                source: "windows-public".into(),
            })
        } else {
            None
        };
        for candidate in [Some(preferred), public_fallback, Some(fallback)].into_iter().flatten() {
            let resolved = paths::absolute_lexical(&candidate.dir);
            if candidates
                .iter()
                .any(|entry| paths::absolute_lexical(&entry.dir) == resolved)
            {
                continue;
            }
            candidates.push(candidate);
        }

        let mut last_error = String::from("Modellordner konnte nicht angelegt werden.");
        for candidate in candidates {
            match tokio::fs::create_dir_all(&candidate.dir).await {
                Ok(()) => {
                    let mut inner = self.inner.lock();
                    inner.models_dir = candidate.dir;
                    inner.models_dir_source = candidate.source;
                    return Ok(());
                }
                Err(error) => {
                    last_error = error.to_string();
                }
            }
        }
        Err(last_error)
    }

    pub fn models_dir(&self) -> PathBuf {
        self.inner.lock().models_dir.clone()
    }

    // -- Zustand / Broadcast --------------------------------------------------

    pub fn state(&self) -> OllamaState {
        self.inner.lock().state.clone()
    }

    pub fn state_value(&self) -> Value {
        serde_json::to_value(self.state()).unwrap_or_else(|_| json!({}))
    }

    /// Wendet einen Patch auf den Zustand an und sendet `ollama:state` ans
    /// Main-Fenster (wie v1 `_broadcast`).
    pub fn broadcast<F: FnOnce(&mut OllamaState)>(&self, patch: F) {
        let state = {
            let mut inner = self.inner.lock();
            patch(&mut inner.state);
            inner.state.clone()
        };
        let _ = self.app.emit_to("main", "ollama:state", state);
    }
}
