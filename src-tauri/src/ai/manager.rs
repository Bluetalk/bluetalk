//! Portierung von BlueTalk v1 `ollama-manager.js` (Zustands-, Runtime-,
//! Server- und Download-Verwaltung). Chat/Agent-Loop siehe `chat.rs`.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Notify, oneshot};
use uuid::Uuid;

use crate::database::{BatchOptions, Database};

use super::{catalog, paths};

const RUNTIME_DIR_NAME: &str = "runtime";
pub const RUNTIME_DOWNLOAD_ABORT_KEY: &str = "__runtime_download__";
pub const MODEL_PULL_ABORT_KEY: &str = "__model_pull__";

fn platform_runtime_asset() -> &'static str {
    if cfg!(target_os = "windows") {
        "ollama-windows-amd64.zip"
    } else if cfg!(target_os = "macos") {
        "ollama-darwin.zip"
    } else {
        "ollama-linux-amd64.tgz"
    }
}

// ---------------------------------------------------------------------------
// CancelToken — Abbruch-Verwaltung für Chats und Downloads
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}

// ---------------------------------------------------------------------------
// Zustand (camelCase-Serialisierung, wie v1 _emptyState)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaState {
    pub runtime_mode: String,
    pub runtime_status: String,
    pub runtime_path: String,
    pub runtime_error: String,
    pub runtime_percent: u32,
    pub runtime_downloaded_bytes: u64,
    pub runtime_total_bytes: u64,
    pub server_running: bool,
    pub selected_model_tier: String,
    pub model_status: HashMap<String, String>,
    pub model_percent: HashMap<String, u32>,
    pub model_downloaded_bytes: HashMap<String, u64>,
    pub model_total_bytes: HashMap<String, u64>,
    pub model_progress_status: HashMap<String, String>,
    pub model_error: HashMap<String, String>,
    pub cloud_auth: bool,
    pub selected_cloud_model_id: String,
    pub setup_complete: bool,
    pub active_model: String,
}

impl OllamaState {
    fn empty(runtime_mode: &str) -> Self {
        let ids = catalog::tier_ids();
        let string_map =
            |v: &str| -> HashMap<String, String> { ids.iter().map(|id| (id.to_string(), v.to_string())).collect() };
        Self {
            runtime_mode: if runtime_mode.is_empty() {
                catalog::OLLAMA_DEFAULT_RUNTIME_MODE.to_string()
            } else {
                runtime_mode.to_string()
            },
            runtime_status: "missing".into(),
            runtime_path: String::new(),
            runtime_error: String::new(),
            runtime_percent: 0,
            runtime_downloaded_bytes: 0,
            runtime_total_bytes: catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES,
            server_running: false,
            selected_model_tier: String::new(),
            model_status: string_map("missing"),
            model_percent: ids.iter().map(|id| (id.to_string(), 0u32)).collect(),
            model_downloaded_bytes: ids.iter().map(|id| (id.to_string(), 0u64)).collect(),
            model_total_bytes: ids.iter().map(|id| (id.to_string(), 0u64)).collect(),
            model_progress_status: string_map(""),
            model_error: string_map(""),
            cloud_auth: false,
            selected_cloud_model_id: catalog::default_cloud_model_id().to_string(),
            setup_complete: false,
            active_model: String::new(),
        }
    }
}

struct Inner {
    runtime_mode: String,
    models_dir: PathBuf,
    models_dir_source: String,
    system_runtime_path: String,
    state: OllamaState,
}

struct ServerHandle {
    child: tokio::process::Child,
    mode: String,
}

/// Fortschritts-Update eines Modell-Pulls.
#[derive(Debug, Clone, Default)]
pub struct PullProgress {
    pub percent: Option<u32>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub status: Option<String>,
}

// ---------------------------------------------------------------------------
// OllamaManager
// ---------------------------------------------------------------------------

pub struct OllamaManager {
    pub app: AppHandle,
    pub database: Arc<Database>,
    #[allow(dead_code)]
    data_dir: PathBuf,
    base_dir: PathBuf,
    runtime_dir: PathBuf,
    http: reqwest::Client,
    inner: Mutex<Inner>,
    server: tokio::sync::Mutex<Option<ServerHandle>>,
    aborts: Mutex<HashMap<String, CancelToken>>,
    ask_registry: Mutex<HashMap<String, oneshot::Sender<String>>>,
    agent_replies: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    memory_cache: Mutex<HashMap<String, Map<String, Value>>>,
}

impl OllamaManager {
    pub fn new(app: AppHandle, database: Arc<Database>, data_dir: PathBuf) -> Arc<Self> {
        let base_dir = data_dir.join("ollama");
        let runtime_dir = base_dir.join(RUNTIME_DIR_NAME);

        let manager = Arc::new(Self {
            app,
            database,
            data_dir: data_dir.clone(),
            base_dir,
            runtime_dir,
            http: reqwest::Client::new(),
            inner: Mutex::new(Inner {
                runtime_mode: catalog::OLLAMA_DEFAULT_RUNTIME_MODE.to_string(),
                models_dir: paths::default_models_dir(&data_dir),
                models_dir_source: "userData".into(),
                system_runtime_path: String::new(),
                state: OllamaState::empty(catalog::OLLAMA_DEFAULT_RUNTIME_MODE),
            }),
            server: tokio::sync::Mutex::new(None),
            aborts: Mutex::new(HashMap::new()),
            ask_registry: Mutex::new(HashMap::new()),
            agent_replies: Mutex::new(HashMap::new()),
            memory_cache: Mutex::new(HashMap::new()),
        });

        manager.apply_runtime_mode();

        let init = manager.clone();
        tauri::async_runtime::spawn(async move {
            init.init().await;
        });

        manager
    }

    async fn init(&self) {
        self.apply_runtime_mode();
        if !self.is_system_runtime() {
            let _ = self.prepare_models_dir().await;
        }
        let _ = tokio::fs::create_dir_all(&self.runtime_dir).await;
        let _ = self.refresh_state().await;
    }

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

    fn apply_runtime_mode(&self) {
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

    async fn prepare_models_dir(&self) -> Result<(), String> {
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

    // -- Runtime-Binary / Server ----------------------------------------------

    fn ollama_binary_path(&self) -> String {
        let win_exe = self.runtime_dir.join("ollama.exe");
        let unix_bin = self.runtime_dir.join("ollama");
        if cfg!(windows) && win_exe.exists() {
            return win_exe.to_string_lossy().to_string();
        }
        if !cfg!(windows) && unix_bin.exists() {
            return unix_bin.to_string_lossy().to_string();
        }
        String::new()
    }

    async fn detect_system_ollama(&self) -> String {
        let finder = if cfg!(windows) { "where" } else { "which" };
        let mut command = tokio::process::Command::new(finder);
        command.arg("ollama");
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let output = tokio::time::timeout(Duration::from_secs(4), command.output()).await;
        match output {
            Ok(Ok(output)) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout);
                stdout
                    .lines()
                    .next()
                    .map(|line| line.trim().to_string())
                    .unwrap_or_default()
            }
            _ => String::new(),
        }
    }

    pub async fn runtime_binary_path(&self) -> String {
        if !self.is_system_runtime() {
            return self.ollama_binary_path();
        }
        let bin = self.detect_system_ollama().await;
        self.inner.lock().system_runtime_path = bin.clone();
        bin
    }

    fn runtime_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("OLLAMA_HOST".to_string(), format!("127.0.0.1:{}", self.runtime_port())),
            ("OLLAMA_ORIGINS".to_string(), "*".to_string()),
        ];
        if !self.is_system_runtime() {
            env.push((
                "OLLAMA_MODELS".to_string(),
                self.models_dir().to_string_lossy().to_string(),
            ));
        }
        env
    }

    async fn runtime_looks_ready(&self) -> bool {
        if self.is_system_runtime() && self.ping_server().await {
            return true;
        }
        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return false;
        }
        // Für BlueTalk-Runtime reicht die Existenz-Prüfung (siehe binary_path);
        // für System-Ollama genügt der gefundene Pfad.
        true
    }

    pub async fn ping_server(&self) -> bool {
        let url = format!("{}/api/tags", self.api_base());
        match self
            .http
            .get(&url)
            .timeout(Duration::from_millis(1500))
            .send()
            .await
        {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn ensure_server_running(&self) -> bool {
        {
            let mut guard = self.server.lock().await;
            if let Some(handle) = guard.as_mut() {
                let same_mode = handle.mode == self.runtime_mode();
                match handle.child.try_wait() {
                    Ok(None) if same_mode => return true,
                    Ok(None) => {
                        let _ = handle.child.start_kill();
                        *guard = None;
                    }
                    _ => {
                        *guard = None;
                    }
                }
            }
        }

        if self.ping_server().await {
            self.broadcast(|s| s.server_running = true);
            return true;
        }

        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return false;
        }
        if !self.is_system_runtime() && self.prepare_models_dir().await.is_err() {
            return false;
        }

        let mut command = tokio::process::Command::new(&bin);
        command.arg("serve");
        for (key, value) in self.runtime_env() {
            command.env(key, value);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        match command.spawn() {
            Ok(child) => {
                let mut guard = self.server.lock().await;
                *guard = Some(ServerHandle {
                    child,
                    mode: self.runtime_mode(),
                });
            }
            Err(error) => {
                log::warn!("[ollama] Serverstart fehlgeschlagen: {error}");
                return false;
            }
        }

        for _ in 0..40 {
            if self.ping_server().await {
                self.broadcast(|s| s.server_running = true);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        false
    }

    pub async fn stop_server(&self) {
        let mut guard = self.server.lock().await;
        if let Some(mut handle) = guard.take() {
            let _ = handle.child.start_kill();
        }
        drop(guard);
        self.broadcast(|s| s.server_running = false);
    }

    async fn list_local_models(&self) -> HashSet<String> {
        let url = format!("{}/api/tags", self.api_base());
        let response = self
            .http
            .get(&url)
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        let mut names = HashSet::new();
        if let Ok(response) = response
            && response.status().is_success()
            && let Ok(body) = response.json::<Value>().await
            && let Some(models) = body.get("models").and_then(Value::as_array)
        {
            for model in models {
                if let Some(name) = model.get("name").and_then(Value::as_str)
                    && !name.is_empty()
                {
                    names.insert(name.to_string());
                }
            }
        }
        names
    }

    // -- refresh_state ---------------------------------------------------------

    fn refresh_model_statuses(&self, local_models: &HashSet<String>, cloud_auth: bool) -> HashMap<String, String> {
        let current = self.state().model_status;
        let mut model_status = current.clone();
        for tier in catalog::AI_MODEL_TIERS {
            if tier.id == "cloud" {
                model_status.insert(
                    tier.id.to_string(),
                    if cloud_auth { "ready" } else { "missing" }.to_string(),
                );
                continue;
            }
            if current.get(tier.id).map(String::as_str) == Some("downloading") {
                continue;
            }
            let has_model = local_models.contains(tier.model);
            model_status.insert(
                tier.id.to_string(),
                if has_model { "ready" } else { "missing" }.to_string(),
            );
        }
        model_status
    }

    fn compute_setup_complete(
        &self,
        runtime_status: &str,
        selected_model_tier: &str,
        model_status: &HashMap<String, String>,
        cloud_auth: bool,
    ) -> bool {
        if runtime_status != "ready" {
            return false;
        }
        if selected_model_tier.is_empty() || !catalog::is_valid_model_tier(selected_model_tier) {
            return false;
        }
        let Some(tier) = catalog::get_model_tier(selected_model_tier) else {
            return false;
        };
        if tier.requires_auth {
            return cloud_auth && model_status.get("cloud").map(String::as_str) == Some("ready");
        }
        model_status.get(selected_model_tier).map(String::as_str) == Some("ready")
    }

    pub async fn refresh_state(&self) -> OllamaState {
        self.apply_runtime_mode();
        let stored_tier = self.kv_get_string("aiChat.selectedModelTier", "");
        let runtime_ready = self.runtime_looks_ready().await;
        let mut runtime_status = if runtime_ready { "ready" } else { "missing" }.to_string();
        let runtime_path = if runtime_ready {
            self.runtime_binary_path().await
        } else {
            String::new()
        };
        let mut runtime_error = String::new();
        let mut server_running = false;

        if self.state().runtime_status == "downloading" {
            runtime_status = "downloading".into();
        }

        if runtime_ready && runtime_status != "downloading" {
            server_running = self.ensure_server_running().await;
            if !server_running {
                runtime_status = "error".into();
                runtime_error = if self.is_system_runtime() {
                    "Eigener Ollama-Server ist nicht erreichbar. Starte Ollama oder wechsle zu BlueTalk-Ollama."
                } else {
                    "BlueTalk-Ollama konnte nicht gestartet werden."
                }
                .to_string();
            }
        }

        let cloud_auth = self.kv_get_bool("aiChat.cloudAuth", false);
        let stored_cloud_id = self.kv_get_string("aiChat.selectedCloudModelId", "");
        let selected_cloud_model_id = catalog::resolve_cloud_model_id(&stored_cloud_id).to_string();
        if selected_cloud_model_id != stored_cloud_id {
            self.kv_set("aiChat.selectedCloudModelId", json!(selected_cloud_model_id.clone()));
        }

        let local_models = if runtime_status == "ready" {
            self.list_local_models().await
        } else {
            HashSet::new()
        };
        let model_status = self.refresh_model_statuses(&local_models, cloud_auth);

        let selected_model_tier = stored_tier;
        let setup_complete =
            self.compute_setup_complete(&runtime_status, &selected_model_tier, &model_status, cloud_auth);
        if setup_complete != self.kv_get_bool("aiChat.setupComplete", false) {
            self.kv_set("aiChat.setupComplete", json!(setup_complete));
        }

        let runtime_mode = self.runtime_mode();
        let active_model =
            catalog::resolve_active_model_name(&selected_model_tier, &selected_cloud_model_id);
        self.broadcast(move |s| {
            s.runtime_mode = runtime_mode;
            s.runtime_status = runtime_status.clone();
            s.runtime_path = runtime_path;
            s.runtime_error = if runtime_status == "error" {
                if runtime_error.is_empty() {
                    s.runtime_error.clone()
                } else {
                    runtime_error
                }
            } else {
                String::new()
            };
            s.server_running = server_running;
            s.selected_model_tier = selected_model_tier;
            s.model_status = model_status;
            s.cloud_auth = cloud_auth;
            s.selected_cloud_model_id = selected_cloud_model_id;
            s.setup_complete = setup_complete;
            s.active_model = active_model;
        });

        self.state()
    }

    // -- Abort-Verwaltung -------------------------------------------------------

    pub fn register_abort(&self, key: &str) -> CancelToken {
        let token = CancelToken::new();
        self.aborts.lock().insert(key.to_string(), token.clone());
        token
    }

    pub fn remove_abort(&self, key: &str) {
        self.aborts.lock().remove(key);
    }

    fn cancel_abort(&self, key: &str) -> bool {
        if let Some(token) = self.aborts.lock().remove(key) {
            token.cancel();
            true
        } else {
            false
        }
    }

    fn cancel_all(&self) {
        let tokens: Vec<CancelToken> = self.aborts.lock().drain().map(|(_, token)| token).collect();
        for token in tokens {
            token.cancel();
        }
        self.ask_registry.lock().clear();
        self.agent_replies.lock().clear();
    }

    pub fn abort_chat(&self, request_id: &str) -> Value {
        if request_id.is_empty() {
            return json!({"ok": false, "error": "missing_request_id"});
        }
        let cancelled = self.cancel_abort(request_id);
        // Auch eine offene ask_user-Anfrage sofort abbrechen, damit der
        // Agent-Loop nicht an einem wartenden Dialog hängen bleibt.
        let ask = self.ask_registry.lock().remove(request_id).is_some();
        if !cancelled && !ask {
            return json!({"ok": false, "error": "not_found"});
        }
        json!({"ok": true})
    }

    // -- Runtime-Download ---------------------------------------------------------

    pub async fn download_runtime(&self) -> Value {
        self.apply_runtime_mode();
        if self.is_system_runtime() {
            self.broadcast(|s| {
                s.runtime_status = "error".into();
                s.runtime_error = "Im eigenen Ollama-Modus verwaltet BlueTalk die Runtime nicht.".into();
            });
            let state = self.refresh_state().await;
            return json!({"ok": false, "state": state});
        }
        if self.state().runtime_status == "downloading" {
            return json!({"ok": true, "state": self.state()});
        }
        if self.runtime_looks_ready().await {
            let state = self.refresh_state().await;
            return json!({"ok": true, "state": state});
        }

        let asset = platform_runtime_asset();
        let url = format!("https://github.com/ollama/ollama/releases/latest/download/{asset}");
        let archive_path = self.base_dir.join(asset);

        self.broadcast(|s| {
            s.runtime_status = "downloading".into();
            s.runtime_error = String::new();
            s.runtime_percent = 0;
            s.runtime_downloaded_bytes = 0;
            s.runtime_total_bytes = catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES;
        });

        let cancel = self.register_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        let result: Result<(), String> = async {
            tokio::fs::create_dir_all(&self.base_dir)
                .await
                .map_err(|e| e.to_string())?;
            self.download_file(&url, &archive_path, &cancel).await?;
            self.extract_archive(&archive_path, &self.runtime_dir.clone()).await?;
            let _ = tokio::fs::remove_file(&archive_path).await;

            if !self.runtime_looks_ready().await {
                return Err("Ollama konnte nach dem Entpacken nicht gefunden werden.".into());
            }
            if !self.ensure_server_running().await {
                return Err("Ollama konnte nicht gestartet werden.".into());
            }
            Ok(())
        }
        .await;
        self.remove_abort(RUNTIME_DOWNLOAD_ABORT_KEY);

        match result {
            Ok(()) => {
                let runtime_path = self.ollama_binary_path();
                self.broadcast(move |s| {
                    s.runtime_status = "ready".into();
                    s.runtime_path = runtime_path;
                    s.runtime_percent = 100;
                    s.runtime_error = String::new();
                });
            }
            Err(error) => {
                self.broadcast(move |s| {
                    s.runtime_status = "error".into();
                    s.runtime_error = if error.is_empty() {
                        "Download fehlgeschlagen".into()
                    } else {
                        error
                    };
                });
            }
        }

        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    async fn download_file(
        &self,
        url: &str,
        dest: &std::path::Path,
        cancel: &CancelToken,
    ) -> Result<(), String> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Download fehlgeschlagen (HTTP {}).", response.status().as_u16()));
        }
        let total_bytes = response.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut file = tokio::fs::File::create(dest).await.map_err(|e| e.to_string())?;
        let mut response = response;

        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
                _ = cancel.cancelled() => return Err("Download abgebrochen".into()),
            };
            let Some(chunk) = chunk else { break };
            downloaded += chunk.len() as u64;
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .map_err(|e| e.to_string())?;
            let percent = if total_bytes > 0 {
                ((downloaded as f64 / total_bytes as f64) * 100.0).round().min(100.0) as u32
            } else {
                ((downloaded as f64 / (catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES as f64 / 100.0)).round() as u32)
                    .min(99)
            };
            let total_for_state = if total_bytes > 0 {
                total_bytes
            } else {
                catalog::OLLAMA_RUNTIME_DISCLAIMER_BYTES
            };
            self.broadcast(move |s| {
                s.runtime_status = "downloading".into();
                s.runtime_percent = percent;
                s.runtime_downloaded_bytes = downloaded;
                s.runtime_total_bytes = total_for_state;
            });
        }
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|e| e.to_string())?;

        let final_total = if total_bytes > 0 { total_bytes } else { downloaded };
        self.broadcast(move |s| {
            s.runtime_percent = 100;
            s.runtime_downloaded_bytes = final_total;
            s.runtime_total_bytes = final_total;
        });
        Ok(())
    }

    async fn extract_archive(&self, archive_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
        tokio::fs::create_dir_all(dest_dir)
            .await
            .map_err(|e| e.to_string())?;
        let archive = archive_path.to_string_lossy().to_string();
        let dest = dest_dir.to_string_lossy().to_string();

        if cfg!(windows) && archive.ends_with(".zip") {
            let script = format!(
                "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                archive.replace('\'', "''"),
                dest.replace('\'', "''")
            );
            let mut command = tokio::process::Command::new("powershell.exe");
            command.arg("-NoProfile").arg("-Command").arg(script);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let output = command.output().await.map_err(|e| e.to_string())?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(if stderr.is_empty() {
                    format!("Entpacken fehlgeschlagen (Code {:?})", output.status.code())
                } else {
                    stderr
                });
            }
            return Ok(());
        }

        if archive.ends_with(".tgz") || archive.ends_with(".tar.gz") {
            let output = tokio::process::Command::new("tar")
                .args(["-xzf", &archive, "-C", &dest])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return Ok(());
        }

        if archive.ends_with(".zip") {
            let output = tokio::process::Command::new("unzip")
                .args(["-o", &archive, "-d", &dest])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
            }
            return Ok(());
        }

        Err(format!(
            "Unbekanntes Archivformat: {}",
            archive_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        ))
    }

    // -- Modi / Auswahl -----------------------------------------------------------

    pub async fn select_runtime_mode(&self, mode: &str) -> Value {
        let next_mode = catalog::resolve_runtime_mode(mode).to_string();
        if next_mode == self.runtime_mode() {
            let state = self.refresh_state().await;
            return json!({"ok": true, "state": state});
        }

        self.cancel_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        self.cancel_abort(MODEL_PULL_ABORT_KEY);
        self.cancel_all();
        self.stop_server().await;

        self.kv_set("aiChat.ollamaRuntimeMode", json!(next_mode));
        self.apply_runtime_mode();
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    pub async fn select_model_tier(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let requires_auth = catalog::get_model_tier(tier_id).map(|t| t.requires_auth).unwrap_or(false);
        if requires_auth && !self.state().cloud_auth {
            return json!({"ok": false, "error": "cloud_auth_required", "state": self.state()});
        }
        self.kv_set("aiChat.selectedModelTier", json!(tier_id));
        self.refresh_state().await;
        json!({"ok": true, "state": self.state()})
    }

    pub async fn select_cloud_model(&self, cloud_model_id: &str) -> Value {
        if !catalog::is_valid_cloud_model(cloud_model_id) {
            return json!({"ok": false, "error": "invalid_cloud_model", "state": self.state()});
        }
        self.kv_set("aiChat.selectedCloudModelId", json!(cloud_model_id));
        self.refresh_state().await;
        json!({"ok": true, "state": self.state()})
    }

    // -- Modell-Download / -Löschung -------------------------------------------------

    pub async fn download_model(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let Some(tier) = catalog::get_model_tier(tier_id) else {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        };
        if tier.requires_auth && !self.state().cloud_auth {
            return json!({"ok": false, "error": "cloud_auth_required", "state": self.state()});
        }
        if self.state().runtime_status != "ready" {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }
        if tier_id == "cloud" {
            self.kv_set("aiChat.selectedModelTier", json!("cloud"));
            self.refresh_state().await;
            return json!({"ok": true, "state": self.state()});
        }
        {
            let status = self.state().model_status.get(tier_id).cloned().unwrap_or_default();
            if status == "ready" || status == "downloading" {
                return json!({"ok": true, "state": self.state()});
            }
        }

        self.kv_set("aiChat.selectedModelTier", json!(tier_id));
        self.ensure_server_running().await;

        let tier_key = tier_id.to_string();
        {
            let tier_key = tier_key.clone();
            self.broadcast(move |s| {
                s.model_status.insert(tier_key.clone(), "downloading".into());
                s.model_percent.insert(tier_key.clone(), 0);
                s.model_downloaded_bytes.insert(tier_key.clone(), 0);
                s.model_total_bytes.insert(tier_key.clone(), 0);
                s.model_progress_status
                    .insert(tier_key.clone(), "download_starting".into());
                s.model_error.insert(tier_key, String::new());
            });
        }

        let cancel = self.register_abort(MODEL_PULL_ABORT_KEY);
        let pull_result = self
            .pull_model(tier.model, &cancel, |progress| {
                let tier_key = tier_key.clone();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "downloading".into());
                    if let Some(percent) = progress.percent {
                        s.model_percent.insert(tier_key.clone(), percent);
                    }
                    if let Some(downloaded) = progress.downloaded_bytes {
                        s.model_downloaded_bytes.insert(tier_key.clone(), downloaded);
                    }
                    if let Some(total) = progress.total_bytes {
                        s.model_total_bytes.insert(tier_key.clone(), total);
                    }
                    if let Some(status) = progress.status.clone() {
                        s.model_progress_status.insert(tier_key.clone(), status);
                    }
                });
            })
            .await;
        self.remove_abort(MODEL_PULL_ABORT_KEY);

        match pull_result {
            Ok(()) => {
                let final_total = self
                    .state()
                    .model_total_bytes
                    .get(tier_id)
                    .copied()
                    .unwrap_or(0);
                let tier_key = tier_id.to_string();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "ready".into());
                    s.model_percent.insert(tier_key.clone(), 100);
                    s.model_downloaded_bytes.insert(tier_key.clone(), final_total);
                    s.model_progress_status.insert(tier_key.clone(), "success".into());
                    s.model_error.insert(tier_key, String::new());
                });
                let state = self.refresh_state().await;
                json!({"ok": true, "state": state})
            }
            Err(error) => {
                let tier_key = tier_id.to_string();
                let message = error.clone();
                self.broadcast(move |s| {
                    s.model_status.insert(tier_key.clone(), "error".into());
                    s.model_error.insert(
                        tier_key,
                        if message.is_empty() {
                            "Modell-Download fehlgeschlagen".into()
                        } else {
                            message
                        },
                    );
                });
                json!({"ok": false, "error": error, "state": self.state()})
            }
        }
    }

    async fn pull_model<F: Fn(PullProgress)>(
        &self,
        model_name: &str,
        cancel: &CancelToken,
        on_progress: F,
    ) -> Result<(), String> {
        let url = format!("{}/api/pull", self.api_base());
        let response = self
            .http
            .post(&url)
            .json(&json!({"name": model_name, "stream": true}))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            let trimmed = body.trim();
            return Err(if trimmed.is_empty() {
                format!("Pull fehlgeschlagen (HTTP {status})")
            } else {
                trimmed.to_string()
            });
        }

        let mut response = response;
        let mut buffer = String::new();
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
                _ = cancel.cancelled() => return Err("Modell-Download abgebrochen".into()),
            };
            let Some(chunk) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(position) = buffer.find('\n') {
                let line = buffer[..position].trim().to_string();
                buffer.drain(..=position);
                if line.is_empty() {
                    continue;
                }
                let Ok(event) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let status = event
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let completed = event.get("completed").and_then(Value::as_u64);
                let total = event.get("total").and_then(Value::as_u64);
                if let (Some(completed), Some(total)) = (completed, total)
                    && total > 0
                {
                    let downloaded = completed.min(total);
                    on_progress(PullProgress {
                        percent: Some(((downloaded as f64 / total as f64) * 100.0).round().min(100.0) as u32),
                        downloaded_bytes: Some(downloaded),
                        total_bytes: Some(total),
                        status: Some(status.clone()),
                    });
                } else if !status.is_empty() {
                    on_progress(PullProgress {
                        status: Some(status.clone()),
                        ..Default::default()
                    });
                }
                if status == "success" {
                    on_progress(PullProgress {
                        percent: Some(100),
                        status: Some("success".into()),
                        ..Default::default()
                    });
                }
                if let Some(error) = event.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
            }
        }
        Ok(())
    }

    pub async fn delete_model(&self, tier_id: &str) -> Value {
        if !catalog::is_valid_model_tier(tier_id) {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        }
        let Some(tier) = catalog::get_model_tier(tier_id) else {
            return json!({"ok": false, "error": "invalid_tier", "state": self.state()});
        };
        if !tier.local {
            return json!({"ok": false, "error": "not_local_model", "state": self.state()});
        }
        if self.state().runtime_status != "ready" {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }

        self.ensure_server_running().await;
        let url = format!("{}/api/delete", self.api_base());
        let response = self
            .http
            .delete(&url)
            .timeout(Duration::from_secs(8))
            .json(&json!({"name": tier.model}))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                let body = response.text().await.unwrap_or_default();
                if !body.contains("not found") && !body.contains("model not found") {
                    return json!({
                        "ok": false,
                        "error": if body.trim().is_empty() { "delete_failed".to_string() } else { body.trim().to_string() },
                        "state": self.state(),
                    });
                }
            }
            Err(error) => {
                let message = error.to_string();
                if !message.contains("not found") {
                    return json!({"ok": false, "error": message, "state": self.state()});
                }
            }
        }

        let tier_key = tier_id.to_string();
        self.broadcast(move |s| {
            s.model_status.insert(tier_key.clone(), "missing".into());
            s.model_percent.insert(tier_key.clone(), 0);
            s.model_downloaded_bytes.insert(tier_key.clone(), 0);
            s.model_total_bytes.insert(tier_key.clone(), 0);
            s.model_progress_status.insert(tier_key, String::new());
        });
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    // -- Verzeichnisse / Pfade -----------------------------------------------------

    pub async fn open_models_dir(&self) -> Value {
        let models_dir = self.models_dir();
        if !self.is_system_runtime() {
            let _ = tokio::fs::create_dir_all(&models_dir).await;
        }
        let path_string = models_dir.to_string_lossy().to_string();
        match tauri_plugin_opener::open_path(path_string.clone(), None::<&str>) {
            Ok(()) => json!({"ok": true, "error": "", "path": path_string}),
            Err(error) => json!({"ok": false, "error": error.to_string(), "path": path_string}),
        }
    }

    pub async fn get_storage_paths(&self) -> Value {
        let (runtime_mode, models_dir, models_dir_source, state_runtime_path) = {
            let inner = self.inner.lock();
            (
                inner.runtime_mode.clone(),
                inner.models_dir.to_string_lossy().to_string(),
                inner.models_dir_source.clone(),
                inner.state.runtime_path.clone(),
            )
        };
        let runtime_path = if !state_runtime_path.is_empty() {
            state_runtime_path
        } else if self.is_system_runtime() {
            self.runtime_binary_path().await
        } else {
            self.ollama_binary_path()
        };
        json!({
            "runtimeMode": runtime_mode,
            "baseDir": self.base_dir.to_string_lossy(),
            "runtimeDir": self.runtime_dir.to_string_lossy(),
            "modelsDir": models_dir,
            "modelsDirSource": models_dir_source,
            "modelsEnvVariable": paths::BLUETALK_OLLAMA_MODELS_ENV,
            "serverPort": self.runtime_port(),
            "runtimePath": runtime_path,
        })
    }

    // -- Cloud ---------------------------------------------------------------------

    pub async fn start_cloud_sign_in(&self) -> Value {
        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }
        self.ensure_server_running().await;

        let mut command = tokio::process::Command::new(&bin);
        command.arg("signin");
        for (key, value) in self.runtime_env() {
            command.env(key, value);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);

        match command.spawn() {
            Ok(_child) => json!({"ok": true, "state": self.state()}),
            Err(error) => json!({"ok": false, "error": error.to_string(), "state": self.state()}),
        }
    }

    pub async fn confirm_cloud_auth(&self) -> Value {
        self.kv_set("aiChat.cloudAuth", json!(true));
        self.broadcast(|s| {
            s.cloud_auth = true;
            s.model_status.insert("cloud".into(), "ready".into());
        });
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    // -- ask_user-Flow ----------------------------------------------------------------

    /// Führt eine ask_user-Anfrage aus: Event an das Main-Fenster, Antwort via
    /// `ollama_reply_ask_user`, Timeout 3 Minuten, abbruchbar über abort_chat.
    pub async fn run_ask_user(&self, peer_id: &str, request_id: &str, question: &str) -> Value {
        let (tx, rx) = oneshot::channel::<String>();
        self.ask_registry.lock().insert(request_id.to_string(), tx);

        let emitted = self
            .app
            .emit_to(
                "main",
                "ollama:ask-user",
                json!({"peerId": peer_id, "requestId": request_id, "question": question}),
            )
            .is_ok();
        if !emitted {
            self.ask_registry.lock().remove(request_id);
            return json!({
                "ok": true,
                "pending_user": true,
                "answered": false,
                "question": question,
                "note": "Kein interaktiver Dialog verfügbar.",
            });
        }

        let outcome = tokio::time::timeout(Duration::from_secs(180), rx).await;
        self.ask_registry.lock().remove(request_id);

        match outcome {
            Ok(Ok(answer)) => {
                let text: String = answer.trim().chars().take(8000).collect();
                json!({
                    "ok": true,
                    "answered": !text.is_empty(),
                    "question": question,
                    "answer": text,
                })
            }
            Ok(Err(_)) => json!({
                "ok": true,
                "answered": false,
                "question": question,
                "answer": "",
                "note": "Abgebrochen.",
            }),
            Err(_) => json!({
                "ok": true,
                "answered": false,
                "question": question,
                "answer": "",
                "note": "Zeitüberschreitung.",
            }),
        }
    }

    pub fn reply_ask_user(&self, request_id: &str, answer: String) -> Value {
        let sender = self.ask_registry.lock().remove(request_id);
        match sender {
            Some(sender) => {
                let _ = sender.send(answer);
                json!({"ok": true})
            }
            None => json!({"ok": false, "error": "not_found"}),
        }
    }

    // -- Agent-Renderer-Brücke (send message / connect peer) -----------------------------

    async fn request_agent_reply(&self, event: &str, mut payload: Map<String, Value>, timeout: Duration) -> Value {
        let request_id = Uuid::new_v4().to_string();
        payload.insert("requestId".into(), json!(request_id));
        let (tx, rx) = oneshot::channel::<Value>();
        self.agent_replies.lock().insert(request_id.clone(), tx);

        if self
            .app
            .emit_to("main", event, Value::Object(payload))
            .is_err()
        {
            self.agent_replies.lock().remove(&request_id);
            return json!({"ok": false, "error": "renderer_unavailable"});
        }

        let outcome = tokio::time::timeout(timeout, rx).await;
        self.agent_replies.lock().remove(&request_id);
        match outcome {
            Ok(Ok(result)) => {
                if result.is_object() {
                    result
                } else {
                    json!({"ok": false, "error": "invalid_reply"})
                }
            }
            Ok(Err(_)) => json!({"ok": false, "error": "reply_channel_closed"}),
            Err(_) => {
                if event == "agent:connect-peer" {
                    json!({"ok": false, "error": "connect_timeout"})
                } else {
                    json!({"ok": false, "error": "send_timeout"})
                }
            }
        }
    }

    pub async fn request_agent_send_message(
        &self,
        peer_id: &str,
        content: &str,
        reply_to: Option<Value>,
    ) -> Value {
        let mut payload = Map::new();
        payload.insert("peerId".into(), json!(peer_id));
        payload.insert("content".into(), json!(content));
        payload.insert("replyTo".into(), reply_to.unwrap_or(Value::Null));
        self.request_agent_reply("agent:send-message", payload, Duration::from_secs(30))
            .await
    }

    pub async fn request_agent_connect_peer(&self, address: &str) -> Value {
        let mut payload = Map::new();
        payload.insert("address".into(), json!(address));
        self.request_agent_reply("agent:connect-peer", payload, Duration::from_secs(45))
            .await
    }

    pub fn agent_reply(&self, request_id: &str, result: Value) -> Value {
        let sender = self.agent_replies.lock().remove(request_id);
        match sender {
            Some(sender) => {
                let _ = sender.send(result);
                json!({"ok": true})
            }
            None => json!({"ok": false, "error": "not_found"}),
        }
    }

    // -- Agent-Memory -----------------------------------------------------------------

    fn load_agent_memory(&self, peer_id: &str) -> Map<String, Value> {
        {
            let cache = self.memory_cache.lock();
            if let Some(bag) = cache.get(peer_id) {
                return bag.clone();
            }
        }
        let stored = self.kv_get(&format!("aiChat.memory.{peer_id}"), json!({}));
        let bag = stored.as_object().cloned().unwrap_or_default();
        self.memory_cache.lock().insert(peer_id.to_string(), bag.clone());
        bag
    }

    fn store_agent_memory(&self, peer_id: &str, bag: Map<String, Value>) {
        self.memory_cache.lock().insert(peer_id.to_string(), bag.clone());
        self.kv_set(&format!("aiChat.memory.{peer_id}"), Value::Object(bag));
    }

    /// Führt eine memory-Tool-Aktion aus (get/set/delete/list) und persistiert.
    pub fn memory_op(&self, peer_id: &str, action: &str, key: &str, value: &str) -> Value {
        let mut bag = self.load_agent_memory(peer_id);
        let action = action.to_lowercase();
        let key = key.trim();
        match action.as_str() {
            "list" => {
                let keys: Vec<String> = bag.keys().cloned().collect();
                json!({"ok": true, "keys": keys})
            }
            "get" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                json!({"ok": true, "key": key, "value": bag.get(key).cloned().unwrap_or(Value::Null)})
            }
            "set" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                let capped: String = value.chars().take(20000).collect();
                bag.insert(key.to_string(), json!(capped));
                self.store_agent_memory(peer_id, bag);
                json!({"ok": true, "key": key})
            }
            "delete" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                bag.remove(key);
                self.store_agent_memory(peer_id, bag);
                json!({"ok": true, "key": key})
            }
            other => json!({"ok": false, "error": format!("unknown_action: {other}")}),
        }
    }

    /// Löscht den persistenten Agent-Kontext (memory-Tool) für einen KI-Chat.
    pub fn clear_agent_context(&self, peer_id: &str) -> Value {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_ai_chat"});
        }
        self.memory_cache.lock().remove(peer_id);
        self.kv_delete(&format!("aiChat.memory.{peer_id}"));
        json!({"ok": true})
    }

    // -- Agent-Konfiguration -------------------------------------------------------------

    /// Sucht den Agent-Eintrag (aiChat.agents) für eine Peer-ID.
    pub fn get_agent(&self, peer_id: &str) -> Option<Value> {
        let agents = self.kv_get("aiChat.agents", json!([]));
        agents.as_array().and_then(|list| {
            list.iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(peer_id))
                .cloned()
        })
    }

    /// Anzeige-Label eines Kontakts (nickname > name > peerId).
    pub fn contact_label(&self, peer_id: &str) -> String {
        let contacts = self.kv_get("contacts", json!([]));
        if let Some(list) = contacts.as_array() {
            for contact in list {
                if contact.get("id").and_then(Value::as_str) == Some(peer_id) {
                    if let Some(nickname) = contact.get("nickname").and_then(Value::as_str)
                        && !nickname.is_empty()
                    {
                        return nickname.to_string();
                    }
                    if let Some(name) = contact.get("name").and_then(Value::as_str)
                        && !name.is_empty()
                    {
                        return name.to_string();
                    }
                }
            }
        }
        peer_id.to_string()
    }

    // -- Reset ---------------------------------------------------------------------------

    pub async fn reset_and_delete(&self) -> Value {
        self.cancel_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        self.cancel_abort(MODEL_PULL_ABORT_KEY);
        self.cancel_all();
        self.stop_server().await;

        // KI-Chat-Nachrichten löschen (alle Peers mit __ai_chat__-Prefix).
        if let Ok(meta) = self.database.get_message_meta() {
            for peer_id in meta.keys() {
                if catalog::is_ai_chat_peer_id(peer_id) {
                    let _ = self.database.delete_chat(peer_id);
                }
            }
        }

        self.kv_delete("aiChat.agents");
        self.kv_delete("aiChat.selectedModelTier");
        self.kv_delete("aiChat.setupComplete");
        self.kv_delete("aiChat.cloudAuth");
        self.kv_delete("aiChat.selectedCloudModelId");
        self.kv_delete("aiChat.memory");
        self.memory_cache.lock().clear();

        let _ = tokio::fs::remove_dir_all(&self.base_dir).await;
        let (models_dir, models_dir_source) = {
            let inner = self.inner.lock();
            (inner.models_dir.clone(), inner.models_dir_source.clone())
        };
        let can_delete_external = models_dir_source != paths::BLUETALK_OLLAMA_MODELS_ENV
            && paths::is_bluetalk_managed_models_dir(&models_dir);
        if !paths::is_same_or_inside_path(&models_dir, &self.base_dir) && can_delete_external {
            let _ = tokio::fs::remove_dir_all(&models_dir).await;
        }
        if !self.is_system_runtime() {
            let _ = self.prepare_models_dir().await;
        }
        let _ = tokio::fs::create_dir_all(&self.runtime_dir).await;

        let runtime_mode = self.runtime_mode();
        let empty = OllamaState::empty(&runtime_mode);
        {
            let mut inner = self.inner.lock();
            inner.state = empty;
        }
        let state = self.state();
        let _ = self.app.emit_to("main", "ollama:state", state.clone());
        json!({"ok": true, "state": state})
    }

    // -- Nachrichten-Zugriff für Chat-History / Tools --------------------------------------

    pub fn message_batch(&self, peer_id: &str, skip: usize, limit: usize) -> (Vec<Value>, usize, bool, usize) {
        match self.database.get_message_batch(
            peer_id,
            BatchOptions {
                skip,
                limit: Some(limit),
            },
        ) {
            Ok(batch) => (batch.messages, batch.total, batch.has_more, batch.remaining),
            Err(_) => (Vec::new(), 0, false, 0),
        }
    }
}
