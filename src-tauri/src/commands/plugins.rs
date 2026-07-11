//! Tauri command layer for the plugin system.
//!
//! Thin wrappers around [`PluginService`]: every command is gated to the
//! trusted main window and delegates the blocking work to a background
//! thread, mirroring `commands/storage.rs`.
//!
//! Design note — `plugins_invoke_command` / `plugins_send_to_main`: BlueTalk
//! v2 has no main-process plugin runtime (third-party code is never executed
//! in a privileged context). `pluginRuntime.js` still exposes both APIs to
//! plugin UI code, so the commands answer without crashing:
//! `plugins_invoke_command` returns the structured
//! `{ ok: false, error: "plugin_main_runtime_not_available" }` shape the
//! renderer uses for command results, and `plugins_send_to_main` is a logged
//! no-op that resolves to `true`.

use std::sync::Arc;

use serde_json::{Value, json};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    commands::require_main,
    error::{AppError, Result},
    plugin_service::{InstallPayload, PluginService},
};

async fn blocking<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Plugin(format!("background plugin task failed: {error}")))?
}

#[tauri::command]
pub async fn plugins_list(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.list()).await
}

#[tauri::command]
pub async fn plugins_rescan(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.rescan()).await
}

#[tauri::command]
pub async fn plugins_reseed_bundled(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
) -> Result<bool> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.reseed_bundled()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn plugins_set_enabled(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
    id: String,
    enabled: bool,
) -> Result<bool> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.set_enabled(&id, enabled)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn plugins_grant_permissions(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
    id: String,
    permissions: Vec<String>,
) -> Result<Value> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.grant_permissions(&id, permissions)).await
}

#[tauri::command]
pub async fn plugins_open_dir(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
) -> Result<bool> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.open_dir()).await
}

#[tauri::command]
pub async fn plugins_install_from_dialog(
    window: WebviewWindow,
    app: AppHandle,
    service: State<'_, Arc<PluginService>>,
) -> Result<Value> {
    require_main(&window)?;
    let dialog = app.dialog().file();
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    let Some(selected) = selected else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = selected
        .into_path()
        .map_err(|error| AppError::InvalidInput(error.to_string()))?;
    let service = service.inner().clone();
    blocking(move || Ok(service.install_from_picked_directory(&path))).await
}

#[tauri::command]
pub async fn plugins_install(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
    payload: InstallPayload,
) -> Result<Value> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || Ok(service.install(payload))).await
}

#[tauri::command]
pub async fn plugins_uninstall(
    window: WebviewWindow,
    service: State<'_, Arc<PluginService>>,
    id: String,
) -> Result<bool> {
    require_main(&window)?;
    let service = service.inner().clone();
    blocking(move || service.uninstall(&id)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn plugins_invoke_command(
    window: WebviewWindow,
    id: String,
    command_id: String,
    args: Option<Value>,
) -> Result<Value> {
    require_main(&window)?;
    let _ = args;
    log::debug!(
        "plugins_invoke_command(`{id}`, `{command_id}`): no main-process plugin runtime in v2"
    );
    Ok(json!({ "ok": false, "error": "plugin_main_runtime_not_available" }))
}

#[tauri::command]
pub async fn plugins_send_to_main(
    window: WebviewWindow,
    id: String,
    payload: Option<Value>,
) -> Result<bool> {
    require_main(&window)?;
    let _ = payload;
    log::debug!("plugins_send_to_main(`{id}`): no-op, no main-process plugin runtime in v2");
    Ok(true)
}
