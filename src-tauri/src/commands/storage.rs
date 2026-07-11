use std::collections::BTreeMap;

use serde_json::Value;
use tauri::{State, WebviewWindow};

use crate::{
    commands::require_main,
    database::{BatchOptions, MessageBatch, MessageMeta},
    error::{AppError, Result},
    state::AppState,
};

async fn blocking<T, F>(operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Storage(format!("background storage task failed: {error}")))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn store_get(
    window: WebviewWindow,
    state: State<'_, AppState>,
    key: String,
    default_value: Option<Value>,
) -> Result<Value> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.get(&key, default_value.unwrap_or(Value::Null))).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn store_set(
    window: WebviewWindow,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<bool> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.set(&key, value)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn store_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    key: String,
) -> Result<bool> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.delete(&key)).await
}

#[tauri::command]
pub async fn messages_get_meta(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<BTreeMap<String, MessageMeta>> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.get_message_meta()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn messages_get_batch(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
    options: Option<BatchOptions>,
) -> Result<MessageBatch> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.get_message_batch(&peer_id, options.unwrap_or_default())).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn messages_append(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
    message: Value,
) -> Result<MessageMeta> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.append_message(&peer_id, message)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn messages_patch(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
    message_id: String,
    patch: Value,
) -> Result<bool> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.patch_message(&peer_id, &message_id, patch)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn messages_delete_message(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
    message_id: String,
) -> Result<bool> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.delete_message(&peer_id, &message_id)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn messages_delete_chat(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
) -> Result<bool> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.delete_chat(&peer_id)).await
}

#[tauri::command]
pub async fn library_list_media(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.list_library_media()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn library_get_media_data(
    window: WebviewWindow,
    state: State<'_, AppState>,
    peer_id: String,
    message_id: String,
) -> Result<Value> {
    require_main(&window)?;
    let database = state.database.clone();
    blocking(move || database.get_library_media_data(&peer_id, &message_id)).await
}
