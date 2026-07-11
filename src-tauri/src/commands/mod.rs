pub mod game_windows;
pub mod maintenance;
pub mod native;
pub mod ollama;
pub mod peer;
pub mod plugins;
pub mod storage;
pub mod updater;
pub mod window;

use crate::error::{AppError, Result};

pub fn require_main(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() != "main" {
        return Err(AppError::PermissionDenied(format!(
            "window '{}' cannot use this command",
            window.label()
        )));
    }
    Ok(())
}

const APP_WINDOW_LABELS: [&str; 7] = [
    "main",
    "game-poker",
    "game-uno",
    "game-connect-four",
    "game-chess",
    "game-tic-tac-toe",
    "docs",
];

/// For read-only commands the isolated game/document windows may also call
/// (v1 exposed `peer.getInfo` through the game preload).
pub fn require_app_window(window: &tauri::WebviewWindow) -> Result<()> {
    if !APP_WINDOW_LABELS.contains(&window.label()) {
        return Err(AppError::PermissionDenied(format!(
            "window '{}' cannot use this command",
            window.label()
        )));
    }
    Ok(())
}

/// The docs editor window exports documents via the save dialog (v1 parity).
pub fn require_main_or_docs(window: &tauri::WebviewWindow) -> Result<()> {
    if window.label() != "main" && window.label() != "docs" {
        return Err(AppError::PermissionDenied(format!(
            "window '{}' cannot use this command",
            window.label()
        )));
    }
    Ok(())
}
