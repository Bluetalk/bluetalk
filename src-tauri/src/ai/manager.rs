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
}

mod abort;
mod agent;
mod config;
mod download;
mod refresh;
mod server;
