use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::{
    commands::require_main,
    error::{AppError, Result},
    state::AppState,
};

const DEFAULT_TAIL_BYTES: usize = 120_000;
const MAX_TAIL_BYTES: usize = 1_000_000;

#[tauri::command]
pub async fn app_clear_cache(window: WebviewWindow, app: AppHandle) -> Result<Value> {
    require_main(&window)?;
    let cache_dir = app.path().app_cache_dir()?;
    tauri::async_runtime::spawn_blocking(move || clear_directory_contents(&cache_dir))
        .await
        .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))??;
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub async fn app_clear_messages(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Value> {
    require_main(&window)?;
    let database = state.database.clone();
    let deleted = tauri::async_runtime::spawn_blocking(move || database.clear_messages())
        .await
        .map_err(|error| AppError::Storage(error.to_string()))??;
    let payload = json!({"scope": "messages", "deleted": deleted});
    let _ = app.emit("app:data-cleared", payload.clone());
    Ok(json!({"ok": true, "deleted": deleted}))
}

#[tauri::command]
pub async fn app_wipe_all_data(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    peers: State<'_, std::sync::Arc<crate::peer_service::PeerService>>,
) -> Result<Value> {
    require_main(&window)?;
    let database = state.database.clone();
    let plugin_dir = state.plugin_dir.clone();
    let attachment_dir = state.attachment_dir.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        database.clear_all()?;
        clear_directory_contents(&plugin_dir)?;
        clear_directory_contents(&attachment_dir)?;
        Ok(())
    })
    .await
    .map_err(|error| AppError::Storage(error.to_string()))??;
    // A wipe also forgets who we are on the network: the identity seed is
    // regenerated so the app returns with a fresh peer id (v1 behaviour).
    peers.wipe_identity_and_reset().await?;
    let payload = json!({"scope": "all"});
    let _ = app.emit("app:data-cleared", payload);
    Ok(json!({"ok": true}))
}

#[tauri::command]
pub fn app_get_config_log_path(window: WebviewWindow, state: State<'_, AppState>) -> Result<Value> {
    require_main(&window)?;
    let path = latest_log_file(&state.log_dir);
    Ok(json!({
        "path": path.as_ref().map(|path| path.to_string_lossy().into_owned()),
        "logDir": state.log_dir.to_string_lossy(),
        "database": state.database_path.to_string_lossy(),
        "encrypted": true
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn app_read_config_tail(
    window: WebviewWindow,
    state: State<'_, AppState>,
    max_bytes: Option<usize>,
) -> Result<Value> {
    require_main(&window)?;
    let Some(path) = latest_log_file(&state.log_dir) else {
        return Ok(json!({"ok": false, "error": "No log file exists yet."}));
    };
    let allowed_root = state.log_dir.clone();
    let max_bytes = max_bytes
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .clamp(1_024, MAX_TAIL_BYTES);
    tauri::async_runtime::spawn_blocking(move || {
        read_redacted_tail(&allowed_root, &path, max_bytes)
    })
    .await
    .map_err(|error| AppError::Io(std::io::Error::other(error.to_string())))?
}

fn latest_log_file(log_dir: &Path) -> Option<PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(log_dir)
        .ok()?
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file() {
                return None;
            }
            let path = entry.path();
            let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
            if !matches!(extension.as_str(), "log" | "txt") {
                return None;
            }
            Some((metadata.modified().ok(), path))
        })
        .collect();
    files.sort_by_key(|(modified, _)| *modified);
    files.pop().map(|(_, path)| path)
}

fn read_redacted_tail(root: &Path, path: &Path, max_bytes: usize) -> Result<Value> {
    let canonical_root = root.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(AppError::PermissionDenied(
            "log path escaped the application log directory".into(),
        ));
    }
    let bytes = std::fs::read(&canonical_path)?;
    let start = bytes.len().saturating_sub(max_bytes);
    let text = String::from_utf8_lossy(&bytes[start..]);
    let redacted = redact_log_text(&text);
    Ok(json!({
        "ok": true,
        "path": canonical_path.to_string_lossy(),
        "truncated": start > 0,
        "text": redacted
    }))
}

fn redact_log_text(text: &str) -> String {
    let json_secret = regex::Regex::new(
        r#"(?i)("(?:apiToken|privateJwk|aesKeyB64|fileData|profilePicture|authorization)"\s*:\s*")[^"]*(")"#,
    )
    .expect("static redaction regex");
    let bearer = regex::Regex::new(r"(?i)Bearer\s+[A-Za-z0-9._~+/=-]{8,}")
        .expect("static bearer redaction regex");
    let redacted = json_secret.replace_all(text, "$1[redacted]$2");
    bearer
        .replace_all(&redacted, "Bearer [redacted]")
        .into_owned()
}

fn clear_directory_contents(directory: &Path) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    let canonical_root = directory.canonicalize()?;
    for entry in std::fs::read_dir(&canonical_root)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || metadata.is_file() {
            std::fs::remove_file(&path)?;
        } else if metadata.is_dir() {
            let canonical_child = path.canonicalize()?;
            if !canonical_child.starts_with(&canonical_root) || canonical_child == canonical_root {
                return Err(AppError::PermissionDenied(
                    "refused to clear a path outside app data".into(),
                ));
            }
            std::fs::remove_dir_all(&canonical_child)?;
        } else {
            return Err(AppError::PermissionDenied(
                "refused to remove a special filesystem entry".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logs_are_redacted() {
        let input =
            r#"Authorization: Bearer abcdefghijklmnop {"apiToken":"secret","message":"ok"}"#;
        let output = redact_log_text(input);
        assert!(!output.contains("abcdefghijklmnop"));
        assert!(!output.contains("\"secret\""));
        assert!(output.contains("\"message\":\"ok\""));
    }

    #[test]
    fn clear_directory_keeps_the_root() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("nested")).unwrap();
        std::fs::write(directory.path().join("nested/file"), b"x").unwrap();
        clear_directory_contents(directory.path()).unwrap();
        assert!(directory.path().is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
}
