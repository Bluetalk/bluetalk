//! WebSocket-Schleife: Auth, Watch, Ping, Tunnel und Postfach.

use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use super::{
    CloudShared, ConnCmd, WsOut,
    config::{CloudConfig, MAX_MAIL_BODY_BYTES, MAX_WATCH_PEERS, auth_host},
    mailbox::MailItem,
    status::CloudState,
    tunnel,
};
use crate::{
    error::{AppError, Result},
    peer_service::PeerService,
};

const PING_INTERVAL: Duration = Duration::from_secs(20);
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const INBOUND_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const BACKOFF_MIN_MS: u64 = 1_000;
const BACKOFF_MAX_MS: u64 = 60_000;
const MAX_TUNNELS: usize = 64;
const MAX_PENDING_OPENS: usize = 8;

pub(super) async fn run(
    app: AppHandle,
    peers: Arc<PeerService>,
    shared: Arc<Mutex<CloudShared>>,
    mut cmd_rx: mpsc::Receiver<ConnCmd>,
    mut shutdown: watch::Receiver<bool>,
) {
    let mut backoff_ms = BACKOFF_MIN_MS;
    loop {
        if *shutdown.borrow() {
            break;
        }
        let config = { shared.lock().config.clone() };
        if !config.enabled {
            set_state(&app, &shared, CloudState::Disabled, None);
            tokio::select! {
                _ = shutdown.changed() => break,
                cmd = cmd_rx.recv() => match cmd {
                    None | Some(ConnCmd::Shutdown) => break,
                    Some(ConnCmd::Reconfigure) => continue,
                    Some(other) => fail_cmd(other, "Cloud ist ausgeschaltet."),
                },
            }
            continue;
        }

        set_state(&app, &shared, CloudState::Connecting, None);
        match run_session(
            &app,
            &peers,
            &shared,
            &config,
            &mut cmd_rx,
            &mut shutdown,
        )
        .await
        {
            SessionEnd::Shutdown => break,
            SessionEnd::Reconfigure => {
                backoff_ms = BACKOFF_MIN_MS;
            }
            SessionEnd::Disconnected(error) => {
                log::info!("cloud relay disconnected: {error}");
                let next_state = if !config.enabled {
                    CloudState::Disabled
                } else if error.contains("auth_failed") || error.contains("auth_timeout") {
                    CloudState::Error
                } else {
                    CloudState::Offline
                };
                set_state(&app, &shared, next_state, Some(error));
                let jitter = u64::from(rand::random::<u16>()) % (backoff_ms / 4).max(1);
                let wait = Duration::from_millis(backoff_ms + jitter);
                backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
                tokio::select! {
                    _ = shutdown.changed() => break,
                    _ = tokio::time::sleep(wait) => {}
                    cmd = cmd_rx.recv() => match cmd {
                        None | Some(ConnCmd::Shutdown) => break,
                        Some(ConnCmd::Reconfigure) => {
                            backoff_ms = BACKOFF_MIN_MS;
                        }
                        Some(other) => fail_cmd(other, "Cloud ist offline."),
                    },
                }
            }
        }
    }
    set_state(&app, &shared, CloudState::Offline, None);
}

enum SessionEnd {
    Shutdown,
    Reconfigure,
    Disconnected(String),
}

struct PendingOpen {
    peer_id: String,
    reply: oneshot::Sender<Result<Value>>,
}

struct LiveTunnel {
    peer_id: String,
    inbound: mpsc::Sender<Vec<u8>>,
    close: watch::Sender<bool>,
}

async fn run_session(
    app: &AppHandle,
    peers: &Arc<PeerService>,
    shared: &Arc<Mutex<CloudShared>>,
    config: &CloudConfig,
    cmd_rx: &mut mpsc::Receiver<ConnCmd>,
    shutdown: &mut watch::Receiver<bool>,
) -> SessionEnd {
    let url = match config.parsed_url() {
        Ok(url) => url,
        Err(error) => return SessionEnd::Disconnected(error.to_string()),
    };
    let host = auth_host(&url);
    let identity = match peers.network_identity() {
        Ok(identity) => identity,
        Err(error) => return SessionEnd::Disconnected(error.to_string()),
    };

    let (ws, _) = match tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(url.as_str()),
    )
    .await
    {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return SessionEnd::Disconnected(error.to_string()),
        Err(_) => return SessionEnd::Disconnected("Relay-Verbindung zeitüberschritten.".to_owned()),
    };
    let (mut sink, mut stream) = ws.split();
    let (ws_tx, mut ws_rx) = mpsc::channel::<WsOut>(64);
    let writer = tokio::spawn(async move {
        while let Some(out) = ws_rx.recv().await {
            let message = match out {
                WsOut::Json(value) => match serde_json::to_string(&value) {
                    Ok(text) => Message::Text(text.into()),
                    Err(_) => continue,
                },
                WsOut::Binary { tunnel_id, payload } => {
                    Message::Binary(tunnel::encode_frame(tunnel_id, &payload).into())
                }
                WsOut::Pong(payload) => Message::Pong(payload.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let hello = match recv_json(&mut stream, HELLO_TIMEOUT).await {
        Ok(value) => value,
        Err(error) => {
            writer.abort();
            return SessionEnd::Disconnected(error);
        }
    };
    if hello.get("t").and_then(Value::as_str) != Some("hello") {
        writer.abort();
        return SessionEnd::Disconnected("unerwartete Relay-Begrüßung".to_owned());
    }
    let nonce = hello
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if nonce.is_empty() {
        writer.abort();
        return SessionEnd::Disconnected("Relay-Nonce fehlt".to_owned());
    }
    let signature = identity.sign_relay_auth(nonce, &host);
    let name: String = peers.display_name().chars().take(64).collect();
    let auth = json!({
        "t": "auth",
        "publicKey": BASE64.encode(identity.public_key_bytes()),
        "signature": BASE64.encode(signature),
        "name": name,
        "client": format!("BlueTalk/{}", env!("CARGO_PKG_VERSION")),
    });
    if ws_tx.send(WsOut::Json(auth)).await.is_err() {
        writer.abort();
        return SessionEnd::Disconnected("Auth konnte nicht gesendet werden".to_owned());
    }
    let ready = match recv_json(&mut stream, HELLO_TIMEOUT).await {
        Ok(value) => value,
        Err(error) => {
            writer.abort();
            return SessionEnd::Disconnected(error);
        }
    };
    if ready.get("t").and_then(Value::as_str) != Some("ready") {
        let code = ready
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("auth_failed");
        writer.abort();
        return SessionEnd::Disconnected(format!("Anmeldung fehlgeschlagen ({code})"));
    }
    let peer_id = ready
        .get("peerId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();

    {
        let mut guard = shared.lock();
        guard.snapshot.peer_id = peer_id.clone();
        guard.snapshot.connected_at = Some(chrono::Utc::now().timestamp_millis());
        guard.snapshot.last_error = None;
        guard.snapshot.latency_ms = None;
        guard.snapshot.online_peers.clear();
        guard.snapshot.tunnels = 0;
        guard.snapshot.state = CloudState::Online;
        guard.snapshot.enabled = true;
        guard.snapshot.relay_url = config.relay_url.clone();
        guard.mail.clear_in_flight();
    }
    emit_status(app, shared);
    let reconnect_peers = peers.clone();
    tauri::async_runtime::spawn(async move {
        reconnect_peers.reconnect_contacts().await;
    });

    if send_watch(&ws_tx, peers).await.is_err() {
        writer.abort();
        return SessionEnd::Disconnected("Watch konnte nicht gesendet werden".to_owned());
    }

    let mut tunnels: HashMap<u32, LiveTunnel> = HashMap::new();
    let mut pending_open: HashMap<u32, PendingOpen> = HashMap::new();
    let mut pending_post: HashMap<String, oneshot::Sender<Result<Value>>> = HashMap::new();
    let mut opening_peers: HashSet<String> = HashSet::new();
    let (ended_tx, mut ended_rx) = mpsc::channel::<u32>(64);
    let mut next_tunnel_id: u32 = 1;
    let mut ping_n: u32 = 1;
    let mut ping_sent: Option<(u32, Instant)> = None;
    let mut ping_tick = tokio::time::interval(PING_INTERVAL);
    ping_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping_tick.tick().await;

    let end = loop {
        tokio::select! {
            _ = shutdown.changed() => break SessionEnd::Shutdown,
            cmd = cmd_rx.recv() => match cmd {
                None | Some(ConnCmd::Shutdown) => break SessionEnd::Shutdown,
                Some(ConnCmd::Reconfigure) => break SessionEnd::Reconfigure,
                Some(ConnCmd::RefreshWatch) => {
                    let _ = send_watch(&ws_tx, peers).await;
                }
                Some(ConnCmd::Ack { ids }) => {
                    if !ids.is_empty() {
                        let _ = ws_tx.send(WsOut::Json(json!({ "t": "ack", "ids": ids }))).await;
                    }
                }
                Some(ConnCmd::Post { id, to, body, reply }) => {
                    handle_post(&ws_tx, &mut pending_post, id, to, body, reply).await;
                }
                Some(ConnCmd::Open { peer_id: target, reply }) => {
                    if peers.has_peer(&target).await {
                        if let Some(info) = peers.peer_snapshot(&target).await {
                            let _ = reply.send(Ok(info));
                            continue;
                        }
                    }
                    start_open(
                        &ws_tx,
                        &tunnels,
                        &mut pending_open,
                        &mut opening_peers,
                        &mut next_tunnel_id,
                        target,
                        reply,
                    );
                }
            },
            _ = ping_tick.tick() => {
                ping_n = ping_n.wrapping_add(1).max(1);
                ping_sent = Some((ping_n, Instant::now()));
                let _ = ws_tx.send(WsOut::Json(json!({ "t": "ping", "n": ping_n }))).await;
            }
            Some(id) = ended_rx.recv() => {
                forget_local_tunnel(shared, &mut tunnels, id);
                emit_status(app, shared);
            }
            incoming = stream.next() => match incoming {
                None => break SessionEnd::Disconnected("Relay hat die Verbindung geschlossen.".to_owned()),
                Some(Err(error)) => break SessionEnd::Disconnected(error.to_string()),
                Some(Ok(Message::Ping(payload))) => {
                    let _ = ws_tx.send(WsOut::Pong(payload.to_vec())).await;
                }
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) => {
                    break SessionEnd::Disconnected("Relay hat die Verbindung geschlossen.".to_owned());
                }
                Some(Ok(Message::Binary(data))) => {
                    handle_binary(app, shared, &mut tunnels, data.as_ref()).await;
                }
                Some(Ok(Message::Text(text))) => {
                    let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                    match value.get("t").and_then(Value::as_str).unwrap_or("") {
                        "pong" => {
                            if let Some((n, sent_at)) = ping_sent {
                                if value.get("n").and_then(Value::as_u64) == Some(u64::from(n)) {
                                    let latency = sent_at.elapsed().as_millis() as u64;
                                    ping_sent = None;
                                    shared.lock().snapshot.latency_ms = Some(latency);
                                    emit_status(app, shared);
                                }
                            }
                        }
                        "presence" => {
                            let auto_target = handle_presence(
                                app,
                                peers,
                                shared,
                                &peer_id,
                                &value,
                            );
                            if let Some(target) = auto_target {
                                if tunnels.values().any(|tunnel| tunnel.peer_id == target)
                                    || opening_peers.contains(&target)
                                    || peers.has_peer(&target).await
                                {
                                    continue;
                                }
                                let (reply_tx, _reply_rx) = oneshot::channel();
                                start_open(
                                    &ws_tx,
                                    &tunnels,
                                    &mut pending_open,
                                    &mut opening_peers,
                                    &mut next_tunnel_id,
                                    target,
                                    reply_tx,
                                );
                            }
                        }
                        "incoming" => {
                            let from = value
                                .get("from")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            let already = !from.is_empty() && peers.has_peer(&from).await;
                            if already {
                                if let Some(id) = value.get("tunnel").and_then(Value::as_u64) {
                                    let _ = ws_tx.try_send(WsOut::Json(
                                        json!({ "t": "reject", "tunnel": id as u32 }),
                                    ));
                                }
                            } else {
                                handle_incoming(
                                    app,
                                    peers,
                                    shared,
                                    &ws_tx,
                                    &mut tunnels,
                                    ended_tx.clone(),
                                    &host,
                                    &value,
                                );
                            }
                        }
                        "opened" => {
                            handle_opened(
                                app,
                                peers,
                                shared,
                                &ws_tx,
                                &mut tunnels,
                                &mut pending_open,
                                &mut opening_peers,
                                ended_tx.clone(),
                                &host,
                                &value,
                            );
                        }
                        "open_failed" => {
                            handle_open_failed(&mut pending_open, &mut opening_peers, &value);
                        }
                        "closed" => {
                            if let Some(id) = value.get("tunnel").and_then(Value::as_u64) {
                                close_local_tunnel(shared, &mut tunnels, id as u32);
                                emit_status(app, shared);
                            }
                        }
                        "mail" => handle_mail(app, shared, &value),
                        "posted" => handle_posted(&mut pending_post, &value),
                        "post_failed" => handle_post_failed(&mut pending_post, &value),
                        "error" => {
                            let code = value.get("code").and_then(Value::as_str).unwrap_or("error");
                            if matches!(code, "replaced" | "auth_failed" | "auth_timeout") {
                                break SessionEnd::Disconnected(code.to_owned());
                            }
                            log::debug!("cloud relay error: {code}");
                        }
                        _ => {}
                    }
                }
            },
        }
    };

    for (_, tunnel) in tunnels.drain() {
        let _ = tunnel.close.send(true);
    }
    for (_, pending) in pending_open.drain() {
        opening_peers.remove(&pending.peer_id);
        let _ = pending.reply.send(Err(AppError::Network(
            "Cloud-Tunnel wurde unterbrochen.".to_owned(),
        )));
    }
    for (_, reply) in pending_post.drain() {
        let _ = reply.send(Err(AppError::Network(
            "Cloud-Postfach wurde unterbrochen.".to_owned(),
        )));
    }
    {
        let mut guard = shared.lock();
        guard.snapshot.tunnels = 0;
        guard.snapshot.online_peers.clear();
        guard.snapshot.connected_at = None;
        guard.snapshot.latency_ms = None;
    }
    writer.abort();
    let _ = writer.await;
    end
}

async fn recv_json<S>(stream: &mut S, limit: Duration) -> std::result::Result<Value, String>
where
    S: StreamExt<Item = std::result::Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let next = tokio::time::timeout(limit, stream.next())
            .await
            .map_err(|_| "Relay antwortet nicht.".to_owned())?;
        match next {
            None => return Err("Relay hat die Verbindung geschlossen.".to_owned()),
            Some(Err(error)) => return Err(error.to_string()),
            Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
            Some(Ok(Message::Close(_))) => {
                return Err("Relay hat die Verbindung geschlossen.".to_owned());
            }
            Some(Ok(Message::Binary(_))) => {}
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(text.as_str())
                    .map_err(|_| "ungültige Relay-Nachricht".to_owned());
            }
        }
    }
}

async fn send_watch(ws_tx: &mpsc::Sender<WsOut>, peers: &PeerService) -> std::result::Result<(), ()> {
    let mut ids = peers.watch_peer_ids();
    ids.truncate(MAX_WATCH_PEERS);
    ws_tx
        .send(WsOut::Json(json!({ "t": "watch", "peers": ids })))
        .await
        .map_err(|_| ())
}

async fn handle_post(
    ws_tx: &mpsc::Sender<WsOut>,
    pending_post: &mut HashMap<String, oneshot::Sender<Result<Value>>>,
    id: String,
    to: String,
    body: Value,
    reply: oneshot::Sender<Result<Value>>,
) {
    let encoded = match serde_json::to_vec(&body) {
        Ok(bytes) if bytes.len() <= MAX_MAIL_BODY_BYTES => bytes,
        Ok(_) => {
            let _ = reply.send(Err(AppError::InvalidInput(
                "Nachricht ist zu groß für das Postfach.".to_owned(),
            )));
            return;
        }
        Err(error) => {
            let _ = reply.send(Err(error.into()));
            return;
        }
    };
    drop(encoded);
    pending_post.insert(id.clone(), reply);
    if ws_tx
        .send(WsOut::Json(json!({ "t": "post", "id": id, "to": to, "body": body })))
        .await
        .is_err()
    {
        if let Some(reply) = pending_post.remove(&id) {
            let _ = reply.send(Err(AppError::Network(
                "Cloud-Postfach ist nicht erreichbar.".to_owned(),
            )));
        }
    }
}

fn start_open(
    ws_tx: &mpsc::Sender<WsOut>,
    tunnels: &HashMap<u32, LiveTunnel>,
    pending_open: &mut HashMap<u32, PendingOpen>,
    opening_peers: &mut HashSet<String>,
    next_tunnel_id: &mut u32,
    target: String,
    reply: oneshot::Sender<Result<Value>>,
) {
    if pending_open.len() >= MAX_PENDING_OPENS || tunnels.len() >= MAX_TUNNELS {
        let _ = reply.send(Err(AppError::Network(
            "Zu viele Cloud-Tunnel.".to_owned(),
        )));
        return;
    }
    if tunnels.values().any(|tunnel| tunnel.peer_id == target) || opening_peers.contains(&target)
    {
        let _ = reply.send(Err(AppError::Conflict(
            "Cloud-Tunnel zu diesem Peer läuft bereits.".to_owned(),
        )));
        return;
    }
    let id = alloc_tunnel_id(next_tunnel_id, tunnels, pending_open);
    opening_peers.insert(target.clone());
    pending_open.insert(
        id,
        PendingOpen {
            peer_id: target.clone(),
            reply,
        },
    );
    if ws_tx
        .try_send(WsOut::Json(json!({ "t": "open", "tunnel": id, "to": target })))
        .is_err()
    {
        if let Some(pending) = pending_open.remove(&id) {
            opening_peers.remove(&pending.peer_id);
            let _ = pending.reply.send(Err(AppError::Network(
                "Cloud-Tunnel konnte nicht geöffnet werden.".to_owned(),
            )));
        }
    }
}

fn alloc_tunnel_id(
    next_tunnel_id: &mut u32,
    tunnels: &HashMap<u32, LiveTunnel>,
    pending_open: &HashMap<u32, PendingOpen>,
) -> u32 {
    for _ in 0..u32::MAX {
        let id = *next_tunnel_id;
        *next_tunnel_id = next_tunnel_id.wrapping_add(1).max(1);
        if id != 0 && !tunnels.contains_key(&id) && !pending_open.contains_key(&id) {
            return id;
        }
    }
    1
}

fn handle_opened(
    app: &AppHandle,
    peers: &Arc<PeerService>,
    shared: &Arc<Mutex<CloudShared>>,
    ws_tx: &mpsc::Sender<WsOut>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    pending_open: &mut HashMap<u32, PendingOpen>,
    opening_peers: &mut HashSet<String>,
    ended_tx: mpsc::Sender<u32>,
    host: &str,
    value: &Value,
) {
    let Some(id) = value.get("tunnel").and_then(Value::as_u64) else {
        return;
    };
    let tunnel_id = id as u32;
    let Some(pending) = pending_open.remove(&tunnel_id) else {
        return;
    };
    opening_peers.remove(&pending.peer_id);
    attach_tunnel(
        app,
        peers,
        shared,
        ws_tx,
        tunnels,
        ended_tx,
        tunnel_id,
        pending.peer_id,
        host,
        true,
        Some(pending.reply),
    );
}

fn handle_open_failed(
    pending_open: &mut HashMap<u32, PendingOpen>,
    opening_peers: &mut HashSet<String>,
    value: &Value,
) {
    let Some(id) = value.get("tunnel").and_then(Value::as_u64) else {
        return;
    };
    if let Some(pending) = pending_open.remove(&(id as u32)) {
        opening_peers.remove(&pending.peer_id);
        let code = value.get("code").and_then(Value::as_str).unwrap_or("failed");
        let _ = pending.reply.send(Err(AppError::Network(format!(
            "Cloud-Tunnel fehlgeschlagen ({code})"
        ))));
    }
}

fn handle_incoming(
    app: &AppHandle,
    peers: &Arc<PeerService>,
    shared: &Arc<Mutex<CloudShared>>,
    ws_tx: &mpsc::Sender<WsOut>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    ended_tx: mpsc::Sender<u32>,
    host: &str,
    value: &Value,
) {
    let Some(id) = value.get("tunnel").and_then(Value::as_u64) else {
        return;
    };
    let tunnel_id = id as u32;
    let from = value
        .get("from")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if from.is_empty() || peers.is_blocked(&from) {
        let _ = ws_tx.try_send(WsOut::Json(json!({ "t": "reject", "tunnel": tunnel_id })));
        return;
    }
    if tunnels.len() >= MAX_TUNNELS {
        let _ = ws_tx.try_send(WsOut::Json(json!({ "t": "reject", "tunnel": tunnel_id })));
        return;
    }
    let _ = ws_tx.try_send(WsOut::Json(json!({ "t": "accept", "tunnel": tunnel_id })));
    attach_tunnel(
        app,
        peers,
        shared,
        ws_tx,
        tunnels,
        ended_tx,
        tunnel_id,
        from,
        host,
        false,
        None,
    );
}

fn attach_tunnel(
    app: &AppHandle,
    peers: &Arc<PeerService>,
    shared: &Arc<Mutex<CloudShared>>,
    ws_tx: &mpsc::Sender<WsOut>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    ended_tx: mpsc::Sender<u32>,
    tunnel_id: u32,
    peer_id: String,
    host: &str,
    initiator: bool,
    reply: Option<oneshot::Sender<Result<Value>>>,
) {
    let (peer_half, relay_half) = tunnel::new_duplex();
    let bridge = tunnel::spawn_bridge(tunnel_id, relay_half, ws_tx.clone(), ended_tx);
    let close_on_fail = bridge.close.clone();
    tunnels.insert(
        tunnel_id,
        LiveTunnel {
            peer_id: peer_id.clone(),
            inbound: bridge.inbound,
            close: bridge.close,
        },
    );
    shared.lock().snapshot.tunnels = tunnels.len();
    emit_status(app, shared);

    let peers = peers.clone();
    let remote = format!("relay://{host}");
    tauri::async_runtime::spawn(async move {
        let outcome = if initiator {
            peers
                .connect_relay_stream(peer_half, remote, Some(peer_id.as_str()))
                .await
        } else {
            peers.accept_relay_stream(peer_half, remote).await
        };
        if outcome.is_err() {
            let _ = close_on_fail.send(true);
        }
        if let Some(reply) = reply {
            let _ = reply.send(outcome);
        } else if let Err(error) = outcome {
            log::debug!("inbound cloud tunnel handshake failed: {error}");
        }
    });
}

async fn handle_binary(
    app: &AppHandle,
    shared: &Arc<Mutex<CloudShared>>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    data: &[u8],
) {
    let Some((tunnel_id, payload)) = tunnel::decode_frame(data) else {
        return;
    };
    if payload.len() > super::config::MAX_TUNNEL_PAYLOAD {
        close_local_tunnel(shared, tunnels, tunnel_id);
        emit_status(app, shared);
        return;
    }
    let Some(inbound) = tunnels.get(&tunnel_id).map(|tunnel| tunnel.inbound.clone()) else {
        return;
    };
    match tokio::time::timeout(INBOUND_SEND_TIMEOUT, inbound.send(payload.to_vec())).await {
        Ok(Ok(())) => {}
        Ok(Err(_)) | Err(_) => {
            // Empfänger weg oder Queue voll: schließen, sonst bricht der Record-Stream.
            close_local_tunnel(shared, tunnels, tunnel_id);
            emit_status(app, shared);
        }
    }
}

fn close_local_tunnel(
    shared: &Arc<Mutex<CloudShared>>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    tunnel_id: u32,
) {
    if let Some(tunnel) = tunnels.remove(&tunnel_id) {
        let _ = tunnel.close.send(true);
    }
    shared.lock().snapshot.tunnels = tunnels.len();
}

fn forget_local_tunnel(
    shared: &Arc<Mutex<CloudShared>>,
    tunnels: &mut HashMap<u32, LiveTunnel>,
    tunnel_id: u32,
) {
    tunnels.remove(&tunnel_id);
    shared.lock().snapshot.tunnels = tunnels.len();
}

fn handle_presence(
    app: &AppHandle,
    peers: &Arc<PeerService>,
    shared: &Arc<Mutex<CloudShared>>,
    our_id: &str,
    value: &Value,
) -> Option<String> {
    let Some(peer_id) = value.get("peerId").and_then(Value::as_str) else {
        return None;
    };
    let online = value.get("online").and_then(Value::as_bool).unwrap_or(false);
    {
        let mut guard = shared.lock();
        if online {
            if !guard.snapshot.online_peers.iter().any(|id| id == peer_id) {
                guard.snapshot.online_peers.push(peer_id.to_owned());
            }
        } else {
            guard.snapshot.online_peers.retain(|id| id != peer_id);
        }
    }
    emit_status(app, shared);
    let _ = app.emit("cloud:presence", json!({ "peerId": peer_id, "online": online }));

    if !online || peers.is_blocked(peer_id) || our_id >= peer_id {
        return None;
    }
    Some(peer_id.to_owned())
}

fn handle_mail(app: &AppHandle, shared: &Arc<Mutex<CloudShared>>, value: &Value) {
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(from) = value.get("from").and_then(Value::as_str) else {
        return;
    };
    let ts = value.get("ts").and_then(Value::as_i64).unwrap_or(0);
    let body = value.get("body").cloned().unwrap_or(Value::Null);
    shared.lock().mail.push(MailItem {
        id: id.to_owned(),
        from: from.to_owned(),
        ts,
        body,
    });
    let _ = app.emit("cloud:mail", json!({ "id": id, "from": from, "ts": ts }));
}

fn handle_posted(
    pending_post: &mut HashMap<String, oneshot::Sender<Result<Value>>>,
    value: &Value,
) {
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(reply) = pending_post.remove(id) {
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("stored");
        let _ = reply.send(Ok(json!({ "status": status })));
    }
}

fn handle_post_failed(
    pending_post: &mut HashMap<String, oneshot::Sender<Result<Value>>>,
    value: &Value,
) {
    let Some(id) = value.get("id").and_then(Value::as_str) else {
        return;
    };
    if let Some(reply) = pending_post.remove(id) {
        let code = value.get("code").and_then(Value::as_str).unwrap_or("failed");
        let _ = reply.send(Err(AppError::Network(format!(
            "Postfach abgelehnt ({code})"
        ))));
    }
}

fn fail_cmd(cmd: ConnCmd, message: &str) {
    match cmd {
        ConnCmd::Open { reply, .. } | ConnCmd::Post { reply, .. } => {
            let _ = reply.send(Err(AppError::Network(message.to_owned())));
        }
        _ => {}
    }
}

fn set_state(
    app: &AppHandle,
    shared: &Arc<Mutex<CloudShared>>,
    state: CloudState,
    error: Option<String>,
) {
    {
        let mut guard = shared.lock();
        guard.snapshot.state = state;
        if state != CloudState::Online {
            guard.snapshot.connected_at = None;
            guard.snapshot.tunnels = 0;
            guard.snapshot.online_peers.clear();
        }
        if let Some(error) = error {
            guard.snapshot.last_error = Some(error);
        }
        if state == CloudState::Online {
            guard.snapshot.last_error = None;
        }
        if state == CloudState::Disabled {
            guard.snapshot.last_error = None;
        }
    }
    emit_status(app, shared);
}

fn emit_status(app: &AppHandle, shared: &Arc<Mutex<CloudShared>>) {
    let value = shared.lock().snapshot.to_value();
    let _ = app.emit("cloud:status", value);
}
