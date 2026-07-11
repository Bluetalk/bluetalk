use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    database::Database,
    error::{AppError, Result},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub supported: bool,
    pub status: String,
    pub message: String,
    pub error_message: String,
    pub current_version: String,
    pub available_version: String,
    pub downloaded_version: String,
    pub release_name: String,
    pub release_date: i64,
    pub auto_update_enabled: bool,
    pub auto_download_updates: bool,
    pub percent: f64,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub bytes_per_second: u64,
    pub last_checked_at: i64,
}

struct PendingUpdate {
    update: Update,
    bytes: Option<Vec<u8>>,
}

pub struct UpdaterService {
    app: AppHandle,
    database: Arc<Database>,
    state: Mutex<UpdateState>,
    pending: Mutex<Option<PendingUpdate>>,
    operation: AsyncMutex<()>,
}

impl UpdaterService {
    pub fn new(app: AppHandle, database: Arc<Database>) -> Arc<Self> {
        let supported = !tauri::is_dev()
            && std::env::var_os("PORTABLE_EXECUTABLE_FILE").is_none()
            && std::env::var_os("PORTABLE_EXECUTABLE_DIR").is_none();
        let (auto_update_enabled, auto_download_updates) = preferences(&database);
        let unsupported_message = if supported {
            String::new()
        } else if tauri::is_dev() {
            "Auto updates are only available in packaged builds.".to_owned()
        } else {
            "Portable builds cannot self-update. Install the BlueTalk setup release.".to_owned()
        };
        Arc::new(Self {
            state: Mutex::new(UpdateState {
                supported,
                status: if supported { "idle" } else { "unsupported" }.into(),
                message: unsupported_message,
                error_message: String::new(),
                current_version: app.package_info().version.to_string(),
                available_version: String::new(),
                downloaded_version: String::new(),
                release_name: String::new(),
                release_date: 0,
                auto_update_enabled,
                auto_download_updates,
                percent: 0.0,
                downloaded_bytes: 0,
                total_bytes: 0,
                bytes_per_second: 0,
                last_checked_at: 0,
            }),
            app,
            database,
            pending: Mutex::new(None),
            operation: AsyncMutex::new(()),
        })
    }

    pub fn get_state(&self) -> UpdateState {
        let (auto_update_enabled, auto_download_updates) = preferences(&self.database);
        let mut state = self.state.lock();
        state.auto_update_enabled = auto_update_enabled;
        state.auto_download_updates = auto_download_updates;
        state.clone()
    }

    pub async fn check(self: &Arc<Self>) -> Result<UpdateState> {
        let _operation = self.operation.lock().await;
        self.ensure_supported()?;
        self.patch(|state| {
            state.status = "checking".into();
            state.message = "Checking for updates…".into();
            state.error_message.clear();
            state.last_checked_at = now_millis();
            state.percent = 0.0;
            state.downloaded_bytes = 0;
            state.total_bytes = 0;
            state.bytes_per_second = 0;
        });

        let update = match self.app.updater() {
            Ok(updater) => updater.check().await,
            Err(error) => return self.fail(error.to_string()),
        };

        match update {
            Ok(Some(update)) => {
                let release_date = update
                    .date
                    .map(|date| (date.unix_timestamp_nanos() / 1_000_000) as i64)
                    .unwrap_or_default();
                let available_version = update.version.clone();
                *self.pending.lock() = Some(PendingUpdate {
                    update,
                    bytes: None,
                });
                self.patch(|state| {
                    state.status = "available".into();
                    state.message = format!("BlueTalk {available_version} is available.");
                    state.available_version = available_version.clone();
                    state.release_name = available_version.clone();
                    state.release_date = release_date;
                });
                Ok(self.get_state())
            }
            Ok(None) => {
                *self.pending.lock() = None;
                self.patch(|state| {
                    state.status = "idle".into();
                    state.message = "BlueTalk is up to date.".into();
                    state.available_version.clear();
                    state.downloaded_version.clear();
                    state.release_name.clear();
                    state.release_date = 0;
                });
                Ok(self.get_state())
            }
            Err(error) => self.fail(error.to_string()),
        }
    }

    pub async fn download(self: &Arc<Self>) -> Result<UpdateState> {
        let _operation = self.operation.lock().await;
        self.ensure_supported()?;
        let update = self
            .pending
            .lock()
            .as_ref()
            .map(|pending| pending.update.clone())
            .ok_or_else(|| AppError::Update("there is no pending update".into()))?;
        let version = update.version.clone();
        self.patch(|state| {
            state.status = "downloading".into();
            state.message = format!("Downloading BlueTalk {version}…");
            state.error_message.clear();
            state.downloaded_bytes = 0;
            state.total_bytes = 0;
            state.percent = 0.0;
        });

        let service = self.clone();
        let started_at = std::time::Instant::now();
        let bytes = update
            .download(
                move |chunk_length, total| {
                    service.patch(|state| {
                        state.downloaded_bytes =
                            state.downloaded_bytes.saturating_add(chunk_length as u64);
                        state.total_bytes = total.unwrap_or_default();
                        state.percent = if state.total_bytes > 0 {
                            state.downloaded_bytes as f64 * 100.0 / state.total_bytes as f64
                        } else {
                            0.0
                        };
                        let elapsed = started_at.elapsed().as_secs_f64();
                        state.bytes_per_second = if elapsed > 0.0 {
                            (state.downloaded_bytes as f64 / elapsed) as u64
                        } else {
                            0
                        };
                    });
                },
                || {},
            )
            .await
            .map_err(|error| AppError::Update(error.to_string()));

        match bytes {
            Ok(bytes) => {
                if let Some(pending) = self.pending.lock().as_mut() {
                    pending.bytes = Some(bytes);
                }
                self.patch(|state| {
                    state.status = "downloaded".into();
                    state.message = format!("BlueTalk {version} is ready to install.");
                    state.downloaded_version = version.clone();
                    state.percent = 100.0;
                    state.bytes_per_second = 0;
                });
                Ok(self.get_state())
            }
            Err(error) => self.fail(error.to_string()),
        }
    }

    pub async fn install(self: &Arc<Self>) -> Result<UpdateState> {
        let _operation = self.operation.lock().await;
        self.ensure_supported()?;
        let (update, bytes) = {
            let pending = self.pending.lock();
            let pending = pending
                .as_ref()
                .ok_or_else(|| AppError::Update("there is no pending update".into()))?;
            let bytes = pending
                .bytes
                .clone()
                .ok_or_else(|| AppError::Update("the update has not been downloaded".into()))?;
            (pending.update.clone(), bytes)
        };
        let version = update.version.clone();
        self.patch(|state| {
            state.status = "installing".into();
            state.message = format!("Installing BlueTalk {version}…");
            state.error_message.clear();
        });

        if let Err(error) = update.install(&bytes) {
            return self.fail(error.to_string());
        }
        self.patch(|state| {
            state.status = "installed".into();
            state.message = format!("BlueTalk {version} was installed. Restarting…");
        });
        let _state = self.get_state();
        self.app.restart();
    }

    fn ensure_supported(&self) -> Result<()> {
        if self.state.lock().supported {
            Ok(())
        } else {
            Err(AppError::Update(self.state.lock().message.clone()))
        }
    }

    fn fail<T>(&self, message: String) -> Result<T> {
        self.patch(|state| {
            state.status = "error".into();
            state.error_message = message.clone();
            state.message = "The update operation failed.".into();
            state.bytes_per_second = 0;
        });
        Err(AppError::Update(message))
    }

    fn patch(&self, mutate: impl FnOnce(&mut UpdateState)) {
        let snapshot = {
            let mut state = self.state.lock();
            mutate(&mut state);
            state.clone()
        };
        let _ = self.app.emit("updater:state", snapshot);
    }
}

fn preferences(database: &Database) -> (bool, bool) {
    let enabled = database
        .get("settings.autoUpdateEnabled", json!(true))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    let download = database
        .get("settings.autoDownloadUpdates", json!(true))
        .ok()
        .and_then(|value| value.as_bool())
        .unwrap_or(true);
    (enabled, download)
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
