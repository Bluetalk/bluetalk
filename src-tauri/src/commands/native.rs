use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use crate::{
    commands::require_main,
    error::{AppError, Result},
    state::AppState,
};

const MAX_SAVE_BASE64_CHARS: usize = 12 * 1024 * 1024;
const MAX_NOTIFICATION_TEXT: usize = 4_096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePayload {
    #[serde(default)]
    default_filename: String,
    base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPayload {
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    allow_in_foreground: bool,
    #[serde(default)]
    silent: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFolderResult {
    ok: bool,
    path: Option<String>,
    canceled: bool,
}

#[tauri::command(rename_all = "camelCase")]
pub async fn file_save_as(
    window: WebviewWindow,
    app: AppHandle,
    payload: SavePayload,
) -> Result<Value> {
    crate::commands::require_main_or_docs(&window)?;
    if payload.base64.is_empty() || payload.base64.len() > MAX_SAVE_BASE64_CHARS {
        return Err(AppError::InvalidInput(
            "file payload is empty or too large".into(),
        ));
    }
    let data = STANDARD
        .decode(payload.base64.as_bytes())
        .map_err(|_| AppError::InvalidInput("file payload is not valid base64".into()))?;
    let file_name = safe_download_name(&payload.default_filename);
    let dialog = app.dialog().file().set_file_name(&file_name);
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    let Some(selected) = selected else {
        return Ok(json!({"ok": false, "canceled": true}));
    };
    let path = selected
        .into_path()
        .map_err(|error| AppError::InvalidInput(error.to_string()))?;
    tokio::fs::write(&path, data).await?;
    Ok(json!({"ok": true, "canceled": false, "path": path.to_string_lossy()}))
}

#[tauri::command]
pub async fn agent_pick_folder(window: WebviewWindow, app: AppHandle) -> Result<PickFolderResult> {
    require_main(&window)?;
    let dialog = app.dialog().file();
    let selected = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    match selected {
        Some(path) => {
            let path = path
                .into_path()
                .map_err(|error| AppError::InvalidInput(error.to_string()))?;
            Ok(PickFolderResult {
                ok: true,
                path: Some(path.to_string_lossy().into_owned()),
                canceled: false,
            })
        }
        None => Ok(PickFolderResult {
            ok: false,
            path: None,
            canceled: true,
        }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn notify_show(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    payload: NotificationPayload,
) -> Result<bool> {
    require_main(&window)?;
    let notifications_enabled = state
        .database
        .get("settings.windowsNotifications", json!(true))?
        .as_bool()
        .unwrap_or(true);
    let do_not_disturb = state
        .database
        .get("settings.doNotDisturb", json!(false))?
        .as_bool()
        .unwrap_or(false);
    let app_is_focused = app
        .webview_windows()
        .values()
        .any(|window| window.is_focused().unwrap_or(false));
    if !notifications_enabled || do_not_disturb || (app_is_focused && !payload.allow_in_foreground)
    {
        return Ok(false);
    }
    let title = truncate_text(
        if payload.title.trim().is_empty() {
            "BlueTalk"
        } else {
            payload.title.trim()
        },
        160,
    );
    let body = truncate_text(payload.body.trim(), MAX_NOTIFICATION_TEXT);
    let mut builder = app.notification().builder().title(title).body(body);
    if payload.silent {
        // No cross-platform silent flag exists in the desktop plugin. An empty sound name
        // suppresses custom sounds while leaving OS accessibility settings authoritative.
        builder = builder.sound("");
    }
    builder
        .show()
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?;
    Ok(true)
}

fn safe_download_name(value: &str) -> String {
    let base = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    let mut output: String = base
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .take(180)
        .collect();
    output = output.trim_matches([' ', '.']).to_owned();
    if output.is_empty() || is_windows_reserved_name(&output) {
        "file".into()
    } else {
        output
    }
}

fn is_windows_reserved_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names_drop_paths_and_windows_devices() {
        assert_eq!(safe_download_name("../../hello.txt"), "hello.txt");
        assert_eq!(safe_download_name("CON.txt"), "file");
        assert_eq!(safe_download_name("bad:name?.txt"), "bad_name_.txt");
    }
}
