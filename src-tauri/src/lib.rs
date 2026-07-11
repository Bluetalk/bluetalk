mod ai;
mod commands;
mod crypto;
mod database;
mod error;
mod migration;
mod peer_service;
mod plugin_manager;
mod plugin_service;
mod state;
mod tray;
mod updater;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let state = state::AppState::initialize(app.handle())?;
            let database = state.database.clone();
            let peers = peer_service::PeerService::initialize(
                app.handle().clone(),
                state.database.clone(),
                state.data_dir.clone(),
            );
            let ollama = ai::OllamaManager::new(
                app.handle().clone(),
                state.database.clone(),
                state.data_dir.clone(),
            );
            app.manage(ollama);

            let plugin_manager = plugin_manager::PluginManager::new(
                state.plugin_dir.clone(),
                semver::Version::new(2, 0, 0),
                plugin_manager::PluginLimits::default(),
                plugin_manager::PermissionRegistry::default(),
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            let plugin_service = plugin_service::PluginService::new(
                app.handle().clone(),
                plugin_manager,
                state.database.clone(),
            );
            app.manage(state);
            app.manage(peers);
            app.manage(plugin_service.clone());
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = plugin_service.seed_bundled_startup() {
                    log::warn!("plugin seeding failed: {error}");
                }
            });

            tray::setup(app.handle(), database)?;
            if let Some(main_window) = app.get_webview_window("main") {
                commands::window::install_main_window_event_forwarder(&main_window)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::storage::store_get,
            commands::storage::store_set,
            commands::storage::store_delete,
            commands::storage::messages_get_meta,
            commands::storage::messages_get_batch,
            commands::storage::messages_append,
            commands::storage::messages_patch,
            commands::storage::messages_delete_message,
            commands::storage::messages_delete_chat,
            commands::storage::library_list_media,
            commands::storage::library_get_media_data,
            commands::native::file_save_as,
            commands::native::notify_show,
            commands::native::agent_pick_folder,
            commands::maintenance::app_clear_cache,
            commands::maintenance::app_clear_messages,
            commands::maintenance::app_wipe_all_data,
            commands::maintenance::app_get_config_log_path,
            commands::maintenance::app_read_config_tail,
            commands::updater::updater_get_state,
            commands::updater::updater_check,
            commands::updater::updater_download,
            commands::updater::updater_install,
            commands::window::window_minimize,
            commands::window::window_toggle_maximize,
            commands::window::window_close,
            commands::window::window_is_maximized,
            commands::game_windows::game_window_open,
            commands::game_windows::game_window_close,
            commands::game_windows::game_window_minimize,
            commands::game_windows::game_window_maximize,
            commands::game_windows::game_window_is_maximized,
            commands::game_windows::game_window_push_state,
            commands::game_windows::game_window_send_action,
            commands::game_windows::game_window_push_presence,
            commands::peer::peer_get_info,
            commands::peer::peer_connect,
            commands::peer::peer_normalize_address,
            commands::peer::peer_reconnect_contacts,
            commands::peer::peer_reset_all_connections,
            commands::peer::peer_disconnect,
            commands::peer::peer_send,
            commands::peer::peer_send_many,
            commands::peer::peer_broadcast,
            commands::peer::peer_get_peers,
            commands::peer::peer_refresh_discovery,
            commands::peer::file_host,
            commands::peer::file_get_hosted,
            commands::peer::file_request,
            commands::peer::network_test_ports,
            commands::peer::network_doctor,
            commands::peer::network_get_api_access,
            commands::plugins::plugins_list,
            commands::plugins::plugins_rescan,
            commands::plugins::plugins_reseed_bundled,
            commands::plugins::plugins_set_enabled,
            commands::plugins::plugins_grant_permissions,
            commands::plugins::plugins_open_dir,
            commands::plugins::plugins_install_from_dialog,
            commands::plugins::plugins_install,
            commands::plugins::plugins_uninstall,
            commands::plugins::plugins_invoke_command,
            commands::plugins::plugins_send_to_main,
            commands::ollama::ollama_get_state,
            commands::ollama::ollama_get_model_catalog,
            commands::ollama::ollama_download_runtime,
            commands::ollama::ollama_select_runtime_mode,
            commands::ollama::ollama_select_model_tier,
            commands::ollama::ollama_select_cloud_model,
            commands::ollama::ollama_download_model,
            commands::ollama::ollama_delete_model,
            commands::ollama::ollama_open_models_dir,
            commands::ollama::ollama_get_storage_paths,
            commands::ollama::ollama_chat,
            commands::ollama::ollama_abort_chat,
            commands::ollama::ollama_clear_agent_context,
            commands::ollama::ollama_reply_ask_user,
            commands::ollama::ollama_start_cloud_sign_in,
            commands::ollama::ollama_confirm_cloud_auth,
            commands::ollama::ollama_reset_and_delete,
            commands::ollama::agent_send_message_reply,
            commands::ollama::agent_connect_peer_reply,
        ])
        .build(tauri::generate_context!())
        .expect("BlueTalk failed to start")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Peers receive a close frame instead of a dead socket.
                if let Some(peers) =
                    app_handle.try_state::<std::sync::Arc<peer_service::PeerService>>()
                {
                    let peers = peers.inner().clone();
                    tauri::async_runtime::block_on(async move {
                        peers.shutdown().await;
                    });
                }
            }
        });
}
