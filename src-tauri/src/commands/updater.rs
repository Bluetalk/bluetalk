use std::sync::Arc;

use tauri::{State, WebviewWindow};

use crate::{commands::require_main, error::Result, state::AppState, updater::UpdateState};

#[tauri::command]
pub fn updater_get_state(window: WebviewWindow, state: State<'_, AppState>) -> Result<UpdateState> {
    require_main(&window)?;
    Ok(state.updater.get_state())
}

#[tauri::command]
pub async fn updater_check(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState> {
    require_main(&window)?;
    Arc::clone(&state.updater).check().await
}

#[tauri::command]
pub async fn updater_download(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState> {
    require_main(&window)?;
    Arc::clone(&state.updater).download().await
}

#[tauri::command]
pub async fn updater_install(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<UpdateState> {
    require_main(&window)?;
    Arc::clone(&state.updater).install().await
}
