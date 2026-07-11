//! System tray and minimize-to-tray behaviour (v1 parity).

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use tauri::{
    AppHandle, Manager, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};

use crate::{database::Database, error::Result};

/// Set when the user chooses "Quit" so the close-to-tray interception lets the
/// window actually close.
static QUITTING: AtomicBool = AtomicBool::new(false);

pub fn mark_quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

pub fn setup(app: &AppHandle, database: Arc<Database>) -> Result<()> {
    let open_item = MenuItem::with_id(app, "open", "BlueTalk öffnen", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;

    let mut builder = TrayIconBuilder::with_id("bluetalk-tray")
        .tooltip("BlueTalk - P2P Chat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                mark_quitting();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;

    install_close_to_tray(app, database);
    Ok(())
}

fn install_close_to_tray(app: &AppHandle, database: Arc<Database>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::CloseRequested { .. }) {
            return;
        }
        if QUITTING.load(Ordering::SeqCst) {
            return;
        }
        let minimize_to_tray = database
            .get("settings.minimizeToTray", serde_json::json!(true))
            .ok()
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        if minimize_to_tray {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = handle.hide();
            }
        }
    });
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
