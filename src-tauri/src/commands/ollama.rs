//! Tauri-Commands für das Ollama/KI-Subsystem. Namen und Parameterformen
//! entsprechen exakt der Frontend-Bridge (`src/bridge/bluetalkBridge.js`).
//!
//! Der `OllamaManager` wird als eigenes managed State-Objekt bezogen
//! (`app.manage(OllamaManager::new(...))` im Setup, Typ `Arc<OllamaManager>`).

use std::sync::Arc;

use serde_json::Value;
use tauri::{State, WebviewWindow};

use crate::{
    ai::{self, OllamaManager},
    commands::require_main,
    error::Result,
};

type Manager<'a> = State<'a, Arc<OllamaManager>>;

#[tauri::command]
pub async fn ollama_get_state(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    manager.refresh_state().await;
    Ok(manager.state_value())
}

#[tauri::command]
pub async fn ollama_get_model_catalog(window: WebviewWindow) -> Result<Value> {
    require_main(&window)?;
    Ok(ai::catalog::model_catalog_json())
}

#[tauri::command]
pub async fn ollama_download_runtime(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.download_runtime().await)
}

#[tauri::command]
pub async fn ollama_select_runtime_mode(
    window: WebviewWindow,
    manager: Manager<'_>,
    mode: String,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.select_runtime_mode(&mode).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_select_model_tier(
    window: WebviewWindow,
    manager: Manager<'_>,
    tier_id: String,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.select_model_tier(&tier_id).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_select_cloud_model(
    window: WebviewWindow,
    manager: Manager<'_>,
    cloud_model_id: String,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.select_cloud_model(&cloud_model_id).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_download_model(
    window: WebviewWindow,
    manager: Manager<'_>,
    tier_id: String,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.download_model(&tier_id).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_delete_model(
    window: WebviewWindow,
    manager: Manager<'_>,
    tier_id: String,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.delete_model(&tier_id).await)
}

#[tauri::command]
pub async fn ollama_open_models_dir(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.open_models_dir().await)
}

#[tauri::command]
pub async fn ollama_get_storage_paths(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.get_storage_paths().await)
}

#[tauri::command]
pub async fn ollama_chat(
    window: WebviewWindow,
    manager: Manager<'_>,
    payload: Value,
) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(ai::chat::chat(manager, payload).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_abort_chat(
    window: WebviewWindow,
    manager: Manager<'_>,
    request_id: String,
) -> Result<Value> {
    require_main(&window)?;
    Ok(manager.abort_chat(&request_id))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_clear_agent_context(
    window: WebviewWindow,
    manager: Manager<'_>,
    peer_id: String,
) -> Result<Value> {
    require_main(&window)?;
    Ok(manager.clear_agent_context(&peer_id))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn ollama_reply_ask_user(
    window: WebviewWindow,
    manager: Manager<'_>,
    request_id: String,
    answer: Option<String>,
) -> Result<Value> {
    require_main(&window)?;
    Ok(manager.reply_ask_user(&request_id, answer.unwrap_or_default()))
}

#[tauri::command]
pub async fn ollama_start_cloud_sign_in(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.start_cloud_sign_in().await)
}

#[tauri::command]
pub async fn ollama_confirm_cloud_auth(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.confirm_cloud_auth().await)
}

#[tauri::command]
pub async fn ollama_reset_and_delete(window: WebviewWindow, manager: Manager<'_>) -> Result<Value> {
    require_main(&window)?;
    let manager = manager.inner().clone();
    Ok(manager.reset_and_delete().await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn agent_send_message_reply(
    window: WebviewWindow,
    manager: Manager<'_>,
    request_id: String,
    result: Value,
) -> Result<Value> {
    require_main(&window)?;
    Ok(manager.agent_reply(&request_id, result))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn agent_connect_peer_reply(
    window: WebviewWindow,
    manager: Manager<'_>,
    request_id: String,
    result: Value,
) -> Result<Value> {
    require_main(&window)?;
    Ok(manager.agent_reply(&request_id, result))
}
