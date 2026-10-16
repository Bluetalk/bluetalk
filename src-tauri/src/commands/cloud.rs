use std::sync::Arc;

use serde_json::Value;
use tauri::{State, WebviewWindow};

use crate::{
    cloud::CloudService,
    commands::require_main,
    error::Result,
};

#[tauri::command]
pub async fn cloud_get_status(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
) -> Result<Value> {
    require_main(&window)?;
    Ok(cloud.status())
}

#[tauri::command]
pub async fn cloud_set_config(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
    config: Value,
) -> Result<Value> {
    require_main(&window)?;
    cloud.set_config(&config)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cloud_post_mail(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
    peer_id: String,
    body: Value,
    id: Option<String>,
) -> Result<Value> {
    require_main(&window)?;
    cloud.post_mail(&peer_id, body, id).await
}

#[tauri::command]
pub async fn cloud_drain_mail(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
) -> Result<Value> {
    require_main(&window)?;
    Ok(cloud.drain_mail())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn cloud_ack_mail(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
    ids: Vec<String>,
) -> Result<bool> {
    require_main(&window)?;
    cloud.ack_mail(ids);
    Ok(true)
}

#[tauri::command]
pub async fn cloud_refresh_watch(
    window: WebviewWindow,
    cloud: State<'_, Arc<CloudService>>,
) -> Result<bool> {
    require_main(&window)?;
    cloud.refresh_watch();
    Ok(true)
}
