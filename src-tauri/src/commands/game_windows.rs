use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};

use parking_lot::RwLock;
use serde_json::Value;
use tauri::{
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    webview::PageLoadEvent,
};

use crate::{
    commands::require_main,
    error::{AppError, Result},
};

const MAIN_WINDOW_LABEL: &str = "main";
const MAX_STATE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ACTION_BYTES: usize = 1024 * 1024;
const MAX_PRESENCE_BYTES: usize = 128 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct AuxiliarySpec {
    game: &'static str,
    label: &'static str,
    route: &'static str,
    event_prefix: &'static str,
    title: &'static str,
    width: u32,
    height: u32,
    min_width: u32,
    min_height: u32,
}

const AUXILIARY_SPECS: [AuxiliarySpec; 6] = [
    AuxiliarySpec {
        game: "poker",
        label: "game-poker",
        route: "/poker-game",
        event_prefix: "poker",
        title: "BlueTalk Poker",
        width: 1280,
        height: 820,
        min_width: 720,
        min_height: 480,
    },
    AuxiliarySpec {
        game: "uno",
        label: "game-uno",
        route: "/uno-game",
        event_prefix: "uno",
        title: "BlueTalk UNO",
        width: 1280,
        height: 820,
        min_width: 720,
        min_height: 480,
    },
    AuxiliarySpec {
        game: "connect-four",
        label: "game-connect-four",
        route: "/connect-four-game",
        event_prefix: "connect-four",
        title: "BlueTalk Vier gewinnt",
        width: 900,
        height: 780,
        min_width: 640,
        min_height: 520,
    },
    AuxiliarySpec {
        game: "chess",
        label: "game-chess",
        route: "/chess-game",
        event_prefix: "chess",
        title: "BlueTalk Schach",
        width: 960,
        height: 820,
        min_width: 640,
        min_height: 520,
    },
    AuxiliarySpec {
        game: "ticTacToe",
        label: "game-tic-tac-toe",
        route: "/tic-tac-toe-game",
        event_prefix: "ticTacToe",
        title: "BlueTalk Tic-Tac-Toe",
        width: 900,
        height: 780,
        min_width: 640,
        min_height: 520,
    },
    AuxiliarySpec {
        game: "docs",
        label: "docs",
        route: "/docs-editor",
        event_prefix: "docs",
        title: "BlueTalk Dokumente",
        width: 1060,
        height: 760,
        min_width: 640,
        min_height: 480,
    },
];

static LAST_STATES: OnceLock<RwLock<HashMap<&'static str, Value>>> = OnceLock::new();

/// MUSS async sein: Ein synchroner Command läuft auf dem Main-Thread, und
/// WebviewWindow-Erstellung braucht den Event-Loop — auf Windows deadlockt das
/// die ganze App (inkl. Asset-Auslieferung an alle Fenster).
#[tauri::command(rename_all = "camelCase")]
pub async fn game_window_open(
    window: WebviewWindow,
    app: AppHandle,
    game: String,
    route: String,
) -> Result<bool> {
    require_main(&window)?;
    let spec = spec_for_game(&game)?;
    require_route(spec, &route)?;

    if let Some(existing) = app.get_webview_window(spec.label) {
        existing.show()?;
        existing.unminimize()?;
        existing.set_focus()?;
        replay_cached_state(&existing, spec)?;
        emit_maximized(&existing, spec)?;
        return Ok(false);
    }

    let page_load_spec = spec;
    let navigation_spec = spec;
    let created =
        WebviewWindowBuilder::new(&app, spec.label, WebviewUrl::App(auxiliary_app_path(spec)))
            .title(spec.title)
            .inner_size(f64::from(spec.width), f64::from(spec.height))
            .min_inner_size(f64::from(spec.min_width), f64::from(spec.min_height))
            .center()
            .decorations(false)
            .resizable(true)
            .maximizable(true)
            .minimizable(true)
            .closable(true)
            .visible(false)
            .on_navigation(move |url| trusted_navigation(url, navigation_spec.route))
            .on_page_load(move |loaded_window, payload| {
                if matches!(payload.event(), PageLoadEvent::Finished) {
                    let _ = replay_cached_state(&loaded_window, page_load_spec);
                    let _ = emit_maximized(&loaded_window, page_load_spec);
                    let _ = loaded_window.show();
                    let _ = loaded_window.set_focus();
                }
            })
            .build()?;

    install_auxiliary_window_event_forwarder(&created, spec);

    // Sicherheitsnetz: Falls `PageLoadEvent::Finished` nie eintrifft (z. B.
    // Ladefehler), darf das Fenster nicht unsichtbar hängen bleiben.
    let fallback = created.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        if matches!(fallback.is_visible(), Ok(false)) {
            let _ = fallback.show();
            let _ = fallback.set_focus();
        }
    });

    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_close(window: WebviewWindow, app: AppHandle, game: String) -> Result<bool> {
    let spec = spec_for_game(&game)?;
    require_lifecycle_caller(window.label(), spec)?;
    let Some(target) = app.get_webview_window(spec.label) else {
        return Ok(false);
    };
    target.close()?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_minimize(window: WebviewWindow, app: AppHandle, game: String) -> Result<()> {
    let spec = spec_for_game(&game)?;
    require_lifecycle_caller(window.label(), spec)?;
    target_window(&app, spec)?.minimize()?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_maximize(window: WebviewWindow, app: AppHandle, game: String) -> Result<bool> {
    let spec = spec_for_game(&game)?;
    require_lifecycle_caller(window.label(), spec)?;
    let target = target_window(&app, spec)?;
    if target.is_maximized()? {
        target.unmaximize()?;
    } else {
        target.maximize()?;
    }
    emit_maximized(&target, spec)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_is_maximized(
    window: WebviewWindow,
    app: AppHandle,
    game: String,
) -> Result<bool> {
    let spec = spec_for_game(&game)?;
    require_lifecycle_caller(window.label(), spec)?;
    target_window(&app, spec)?
        .is_maximized()
        .map_err(Into::into)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_push_state(
    window: WebviewWindow,
    app: AppHandle,
    game: String,
    payload: Value,
) -> Result<bool> {
    require_main(&window)?;
    let spec = spec_for_game(&game)?;
    validate_payload_size(&payload, MAX_STATE_BYTES, "game state")?;
    states().write().insert(spec.game, payload.clone());
    emit_if_open(&app, spec, &state_event(spec), payload)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_send_action(
    window: WebviewWindow,
    app: AppHandle,
    game: String,
    payload: Value,
) -> Result<bool> {
    let spec = spec_for_game(&game)?;
    require_matching_auxiliary(window.label(), spec)?;
    validate_payload_size(&payload, MAX_ACTION_BYTES, "game action")?;

    let main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| AppError::NotReady("the main window is not available".into()))?;
    main.emit(&action_event(spec), payload)?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn game_window_push_presence(
    window: WebviewWindow,
    app: AppHandle,
    game: String,
    payload: Value,
) -> Result<bool> {
    require_main(&window)?;
    let spec = spec_for_game(&game)?;
    if spec.game != "docs" {
        return Err(AppError::PermissionDenied(
            "presence relay is restricted to the documents window".into(),
        ));
    }
    validate_payload_size(&payload, MAX_PRESENCE_BYTES, "document presence")?;
    emit_if_open(&app, spec, "docs:presence", payload)
}

fn states() -> &'static RwLock<HashMap<&'static str, Value>> {
    LAST_STATES.get_or_init(|| RwLock::new(HashMap::new()))
}

fn spec_for_game(game: &str) -> Result<AuxiliarySpec> {
    AUXILIARY_SPECS
        .iter()
        .copied()
        .find(|spec| spec.game == game)
        .ok_or_else(|| AppError::InvalidInput(format!("unsupported auxiliary window '{game}'")))
}

fn require_route(spec: AuxiliarySpec, route: &str) -> Result<()> {
    if route != spec.route {
        return Err(AppError::PermissionDenied(format!(
            "route '{route}' is not valid for '{}'",
            spec.game
        )));
    }
    Ok(())
}

fn require_lifecycle_caller(caller_label: &str, spec: AuxiliarySpec) -> Result<()> {
    if caller_label == MAIN_WINDOW_LABEL || caller_label == spec.label {
        return Ok(());
    }
    Err(AppError::PermissionDenied(format!(
        "window '{caller_label}' cannot manage '{}'",
        spec.game
    )))
}

fn require_matching_auxiliary(caller_label: &str, spec: AuxiliarySpec) -> Result<()> {
    if caller_label == spec.label {
        return Ok(());
    }
    Err(AppError::PermissionDenied(format!(
        "window '{caller_label}' cannot send actions for '{}'",
        spec.game
    )))
}

fn target_window(app: &AppHandle, spec: AuxiliarySpec) -> Result<WebviewWindow> {
    app.get_webview_window(spec.label)
        .ok_or_else(|| AppError::NotFound(format!("window '{}' is not open", spec.label)))
}

fn auxiliary_app_path(spec: AuxiliarySpec) -> PathBuf {
    format!("index.html#{}", spec.route).into()
}

fn state_event(spec: AuxiliarySpec) -> String {
    format!("{}:state", spec.event_prefix)
}

fn action_event(spec: AuxiliarySpec) -> String {
    format!("{}:fromChild", spec.event_prefix)
}

fn maximized_event(spec: AuxiliarySpec) -> String {
    format!("{}:windowMaximized", spec.event_prefix)
}

fn emit_if_open(app: &AppHandle, spec: AuxiliarySpec, event: &str, payload: Value) -> Result<bool> {
    let Some(target) = app.get_webview_window(spec.label) else {
        return Ok(false);
    };
    target.emit(event, payload)?;
    Ok(true)
}

fn replay_cached_state(window: &WebviewWindow, spec: AuxiliarySpec) -> Result<bool> {
    let Some(payload) = states().read().get(spec.game).cloned() else {
        return Ok(false);
    };
    window.emit(&state_event(spec), payload)?;
    Ok(true)
}

fn emit_maximized(window: &WebviewWindow, spec: AuxiliarySpec) -> Result<bool> {
    let maximized = window.is_maximized()?;
    window.emit(&maximized_event(spec), maximized)?;
    Ok(maximized)
}

fn install_auxiliary_window_event_forwarder(window: &WebviewWindow, spec: AuxiliarySpec) {
    let app = window.app_handle().clone();
    let last_value = Arc::new(AtomicBool::new(window.is_maximized().unwrap_or(false)));
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Resized(_)) {
            return;
        }

        let Some(window) = app.get_webview_window(spec.label) else {
            return;
        };
        let Ok(maximized) = window.is_maximized() else {
            return;
        };
        if last_value.swap(maximized, Ordering::Relaxed) != maximized {
            let _ = window.emit(&maximized_event(spec), maximized);
        }
    });
}

fn validate_payload_size(payload: &Value, limit: usize, description: &str) -> Result<()> {
    let bytes = serde_json::to_vec(payload)?;
    if bytes.len() > limit {
        return Err(AppError::InvalidInput(format!(
            "{description} exceeds the {limit}-byte limit"
        )));
    }
    Ok(())
}

fn trusted_navigation(url: &Url, expected_route: &str) -> bool {
    let trusted_origin = match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), _) => true,
        ("http" | "https", Some("tauri.localhost"), _) => true,
        #[cfg(debug_assertions)]
        ("http", Some("127.0.0.1" | "localhost"), Some(5173)) => true,
        _ => false,
    };
    if !trusted_origin {
        return false;
    }

    url.fragment()
        .is_some_and(|fragment| fragment == expected_route)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_names_map_to_fixed_labels_routes_and_events() {
        let poker = spec_for_game("poker").unwrap();
        assert_eq!(poker.label, "game-poker");
        assert_eq!(poker.route, "/poker-game");
        assert_eq!(state_event(poker), "poker:state");

        let tic_tac_toe = spec_for_game("ticTacToe").unwrap();
        assert_eq!(tic_tac_toe.label, "game-tic-tac-toe");
        assert_eq!(maximized_event(tic_tac_toe), "ticTacToe:windowMaximized");

        assert!(spec_for_game("tic-tac-toe").is_err());
        assert!(spec_for_game("../poker").is_err());
    }

    #[test]
    fn routes_cannot_be_substituted() {
        let poker = spec_for_game("poker").unwrap();
        assert!(require_route(poker, "/poker-game").is_ok());
        assert!(require_route(poker, "/docs-editor").is_err());
        assert!(require_route(poker, "https://example.com").is_err());
    }

    #[test]
    fn lifecycle_and_action_callers_are_isolated() {
        let poker = spec_for_game("poker").unwrap();
        assert!(require_lifecycle_caller("main", poker).is_ok());
        assert!(require_lifecycle_caller("game-poker", poker).is_ok());
        assert!(require_lifecycle_caller("game-chess", poker).is_err());

        assert!(require_matching_auxiliary("game-poker", poker).is_ok());
        assert!(require_matching_auxiliary("main", poker).is_err());
        assert!(require_matching_auxiliary("game-chess", poker).is_err());
    }

    #[test]
    fn navigation_is_pinned_to_local_origin_and_expected_hash() {
        assert!(trusted_navigation(
            &Url::parse("tauri://localhost/#/poker-game").unwrap(),
            "/poker-game"
        ));
        assert!(trusted_navigation(
            &Url::parse("http://tauri.localhost/#/docs-editor").unwrap(),
            "/docs-editor"
        ));
        assert!(!trusted_navigation(
            &Url::parse("https://example.com/#/poker-game").unwrap(),
            "/poker-game"
        ));
        assert!(!trusted_navigation(
            &Url::parse("tauri://localhost/#/chess-game").unwrap(),
            "/poker-game"
        ));
    }

    #[test]
    fn oversized_payloads_are_rejected() {
        let small = Value::String("ok".into());
        assert!(validate_payload_size(&small, 16, "test").is_ok());

        let large = Value::String("x".repeat(64));
        assert!(validate_payload_size(&large, 16, "test").is_err());
    }

    #[test]
    fn app_path_contains_only_the_whitelisted_hash_route() {
        let docs = spec_for_game("docs").unwrap();
        assert_eq!(
            auxiliary_app_path(docs).to_string_lossy(),
            "index.html#/docs-editor"
        );
    }
}
