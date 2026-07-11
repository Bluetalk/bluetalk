use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tauri::{Emitter, Manager, WebviewWindow, WindowEvent};

use crate::{commands::require_main, error::Result};

const MAIN_WINDOW_LABEL: &str = "main";
const MAXIMIZED_EVENT: &str = "window:maximized";

#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<()> {
    require_main(&window)?;
    window.minimize()?;
    Ok(())
}

#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<bool> {
    require_main(&window)?;
    if window.is_maximized()? {
        window.unmaximize()?;
    } else {
        window.maximize()?;
    }
    emit_maximized(&window)
}

#[tauri::command]
pub fn window_close(window: WebviewWindow) -> Result<()> {
    require_main(&window)?;
    window.close()?;
    Ok(())
}

#[tauri::command]
pub fn window_is_maximized(window: WebviewWindow) -> Result<bool> {
    require_main(&window)?;
    window.is_maximized().map_err(Into::into)
}

/// Installs the native maximize/unmaximize event relay for changes caused by
/// window snapping, title-bar gestures, or operating-system shortcuts.
///
/// Call this exactly once for the configured `main` window during setup. The
/// command handlers above work without it and always emit after an explicit
/// `window_toggle_maximize` invocation.
pub fn install_main_window_event_forwarder(window: &WebviewWindow) -> Result<()> {
    require_main(window)?;

    let app = window.app_handle().clone();
    let last_value = Arc::new(AtomicBool::new(window.is_maximized()?));
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
            return;
        };
        let Ok(maximized) = window.is_maximized() else {
            return;
        };
        if last_value.swap(maximized, Ordering::Relaxed) != maximized {
            let _ = window.emit(MAXIMIZED_EVENT, maximized);
        }
    });

    Ok(())
}

fn emit_maximized(window: &WebviewWindow) -> Result<bool> {
    let maximized = window.is_maximized()?;
    window.emit(MAXIMIZED_EVENT, maximized)?;
    Ok(maximized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_identity_is_exact() {
        assert_eq!(MAIN_WINDOW_LABEL, "main");
        assert_ne!(MAIN_WINDOW_LABEL, "game-poker");
        assert_ne!(MAIN_WINDOW_LABEL, "Main");
    }
}
