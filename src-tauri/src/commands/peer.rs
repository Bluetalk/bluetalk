use std::{sync::Arc, time::Duration};

use serde_json::{Value, json};
use tauri::{State, WebviewWindow};

use crate::{
    commands::require_main,
    error::Result,
    peer_service::{PeerService, normalize_connect_address},
};

const NETWORK_TEST_HOST: &str = "portquiz.net";
const NETWORK_TEST_PORTS: [u16; 9] = [443, 8443, 8080, 3000, 5000, 9090, 8888, 4443, 80];
const PORT_TEST_TIMEOUT: Duration = Duration::from_millis(1_800);

#[tauri::command]
pub async fn peer_get_info(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Value> {
    crate::commands::require_app_window(&window)?;
    Ok(peers.get_info().await)
}

#[tauri::command]
pub async fn peer_connect(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    address: Value,
) -> Result<Value> {
    require_main(&window)?;
    match peers.connect(&address).await {
        Ok(peer) => Ok(json!({ "ok": true, "peer": peer })),
        Err(error) => Ok(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[tauri::command]
pub async fn peer_normalize_address(window: WebviewWindow, raw: String) -> Result<Value> {
    require_main(&window)?;
    match normalize_connect_address(&raw) {
        Ok(normalized) => Ok(json!({ "ok": true, "normalized": normalized })),
        Err(error) => Ok(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[tauri::command]
pub async fn peer_reconnect_contacts(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Value> {
    require_main(&window)?;
    peers.reconnect_contacts().await;
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn peer_reset_all_connections(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Value> {
    require_main(&window)?;
    peers.reset_all_connections().await?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn peer_disconnect(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    peer_id: String,
) -> Result<bool> {
    require_main(&window)?;
    peers.disconnect(&peer_id).await?;
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn peer_send(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    peer_id: String,
    data: Value,
) -> Result<bool> {
    require_main(&window)?;
    peers.send(&peer_id, data).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn peer_send_many(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    peer_ids: Vec<String>,
    data: Value,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    peers.send_many(&peer_ids, data).await
}

#[tauri::command]
pub async fn peer_broadcast(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    data: Value,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    peers.broadcast(data).await
}

#[tauri::command]
pub async fn peer_get_peers(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    Ok(peers.peers_snapshot().await)
}

#[tauri::command]
pub async fn peer_refresh_discovery(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<()> {
    require_main(&window)?;
    peers.refresh_discovery().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn file_host(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    file_meta: Value,
) -> Result<Value> {
    require_main(&window)?;
    peers.host_file(file_meta).await
}

#[tauri::command]
pub async fn file_get_hosted(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Vec<Value>> {
    require_main(&window)?;
    Ok(peers.hosted_files())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn file_request(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
    peer_id: String,
    file_id: String,
) -> Result<Value> {
    require_main(&window)?;
    peers.request_file(&peer_id, &file_id).await
}

/// Probes outbound TCP reachability against a public echo host, mirroring the
/// v1 diagnosis (`portquiz.net`, 1.8 s timeout per port).
#[tauri::command]
pub async fn network_test_ports(window: WebviewWindow) -> Result<Value> {
    require_main(&window)?;
    let mut probes = Vec::new();
    for port in NETWORK_TEST_PORTS {
        probes.push(async move {
            let target = format!("{NETWORK_TEST_HOST}:{port}");
            let open = match tokio::time::timeout(
                PORT_TEST_TIMEOUT,
                tokio::net::TcpStream::connect(&target),
            )
            .await
            {
                Ok(Ok(_)) => true,
                _ => false,
            };
            json!({ "port": port, "open": open })
        });
    }
    let checks: Vec<Value> = futures_join_all(probes).await;
    let open_count = checks
        .iter()
        .filter(|check| check["open"] == Value::Bool(true))
        .count();
    let recommended = checks
        .iter()
        .find(|check| check["open"] == Value::Bool(true))
        .and_then(|check| check["port"].as_u64());
    Ok(json!({
        "host": NETWORK_TEST_HOST,
        "testedAt": chrono::Utc::now().timestamp_millis(),
        "checks": checks,
        "recommendedPort": recommended,
        "summary": {
            "openCount": open_count,
            "blockedCount": checks.len() - open_count,
        },
    }))
}

#[tauri::command]
pub async fn network_doctor(
    window: WebviewWindow,
    peers: State<'_, Arc<PeerService>>,
) -> Result<Value> {
    require_main(&window)?;
    let peer_info = peers.get_info().await;
    let port_probe = network_probe_summary().await;

    let mut issues: Vec<Value> = Vec::new();
    let mut fixes: Vec<Value> = Vec::new();

    let listen_port = peer_info["port"].as_u64().unwrap_or(0);
    if listen_port == 0 {
        issues.push(json!({
            "code": "no_listen_ports",
            "message": "Es konnte kein Netzwerk-Port geöffnet werden.",
        }));
        fixes.push(json!("Firewall-Einstellungen prüfen und BlueTalk neu starten."));
    }
    let has_lan_ipv4 = peer_info["addresses"]
        .as_array()
        .map(|addresses| !addresses.is_empty())
        .unwrap_or(false);
    if !has_lan_ipv4 {
        issues.push(json!({
            "code": "no_lan_ipv4",
            "message": "Keine lokale IPv4-Adresse gefunden.",
        }));
        fixes.push(json!("Mit einem Netzwerk (WLAN/LAN) verbinden."));
    }
    if port_probe["summary"]["openCount"].as_u64() == Some(0) {
        issues.push(json!({
            "code": "outbound_probe_blocked",
            "message": "Ausgehende Verbindungen scheinen blockiert zu sein.",
        }));
        fixes.push(json!("Netzwerk-Administrator kontaktieren oder anderes Netzwerk testen."));
    }

    Ok(json!({
        "checkedAt": chrono::Utc::now().timestamp_millis(),
        "portProbe": port_probe,
        "peerInfo": peer_info,
        "apiPort": Value::Null,
        "issues": issues,
        "fixes": fixes,
    }))
}

/// The v1 local REST API server was removed in v2 to shrink the attack
/// surface; this endpoint reports that state instead of credentials.
#[tauri::command]
pub async fn network_get_api_access(window: WebviewWindow) -> Result<Value> {
    require_main(&window)?;
    Ok(json!({
        "host": "127.0.0.1",
        "port": Value::Null,
        "token": Value::Null,
        "enabled": false,
        "reason": "api_server_removed_in_v2",
    }))
}

async fn network_probe_summary() -> Value {
    let mut checks = Vec::new();
    for port in NETWORK_TEST_PORTS {
        let target = format!("{NETWORK_TEST_HOST}:{port}");
        let open = matches!(
            tokio::time::timeout(PORT_TEST_TIMEOUT, tokio::net::TcpStream::connect(&target)).await,
            Ok(Ok(_))
        );
        checks.push(json!({ "port": port, "open": open }));
    }
    let open_count = checks
        .iter()
        .filter(|check| check["open"] == Value::Bool(true))
        .count();
    json!({
        "host": NETWORK_TEST_HOST,
        "checks": checks,
        "summary": { "openCount": open_count, "blockedCount": checks.len() - open_count },
    })
}

/// Minimal concurrent join to avoid pulling in the `futures` crate.
async fn futures_join_all<F>(futures: Vec<F>) -> Vec<F::Output>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send + 'static,
{
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        if let Ok(value) = handle.await {
            results.push(value);
        }
    }
    results
}
