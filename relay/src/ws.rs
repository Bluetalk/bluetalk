//! Eine WebSocket-Verbindung: Auth, Reader, Steuer-/Datenkanal, Backpressure.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt, stream::SplitSink};
use rand::RngCore;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::time::MissedTickBehavior;

use crate::AppState;
use crate::auth::verify_auth;
use crate::mailbox::PostOutcome;
use crate::proto::{
    AUTH_TIMEOUT_SECS, BYTE_BURST, BYTE_RATE, CONTROL_RATE, MAX_WATCH, OPEN_TIMEOUT_SECS,
    OUTBOUND_CONTROL_CAP, OUTBOUND_DATA_CAP, Outbound, WS_IDLE_SECS, WS_PING_SECS, error, hello,
    mail, open_failed, post_failed, posted, ready,
};
use crate::ratelimit::{IpGuard, TokenBucket};
use crate::util::{parse_peer_id, short_id, unix_ms, valid_mail_id, valid_name};

enum Session {
    WaitAuth { nonce: String },
    Ready { peer_id: String, generation: u64 },
}

pub async fn handle_socket(socket: WebSocket, state: AppState, host: String, _ip_guard: IpGuard) {
    let (mut writer, mut reader) = socket.split();
    let (control_tx, mut control_rx) = mpsc::channel::<Outbound>(OUTBOUND_CONTROL_CAP);
    let (data_tx, mut data_rx) = mpsc::channel::<Outbound>(OUTBOUND_DATA_CAP);
    let writer_task = tokio::spawn(async move {
        let mut ping = tokio::time::interval(Duration::from_secs(WS_PING_SECS));
        ping.set_missed_tick_behavior(MissedTickBehavior::Delay);
        ping.tick().await;
        let mut control_open = true;
        let mut data_open = true;
        loop {
            tokio::select! {
                biased;
                msg = control_rx.recv(), if control_open => {
                    let Some(msg) = msg else {
                        control_open = false;
                        if !data_open {
                            break;
                        }
                        continue;
                    };
                    if !write_out(&mut writer, msg).await {
                        break;
                    }
                }
                msg = data_rx.recv(), if data_open => {
                    let Some(msg) = msg else {
                        data_open = false;
                        if !control_open {
                            break;
                        }
                        continue;
                    };
                    if !write_out(&mut writer, msg).await {
                        break;
                    }
                }
                _ = ping.tick() => {
                    if writer.send(Message::Ping(Bytes::new())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let mut nonce = [0u8; 32];
    if getrandom::fill(&mut nonce).is_err() {
        rand::rng().fill_bytes(&mut nonce);
    }
    let nonce_b64 = BASE64.encode(nonce);
    if control_tx
        .send(Outbound::json(hello(&nonce_b64, env!("CARGO_PKG_VERSION"))))
        .await
        .is_err()
    {
        writer_task.abort();
        return;
    }

    let last_activity = Arc::new(AtomicU64::new(unix_ms() as u64));
    let (cancel_tx, mut cancel_rx) = watch::channel(false);
    let mut session = Session::WaitAuth {
        nonce: nonce_b64.clone(),
    };
    let mut control = TokenBucket::new(CONTROL_RATE, CONTROL_RATE);
    let mut bytes = TokenBucket::new(BYTE_RATE, BYTE_BURST);
    let auth_deadline = Instant::now() + Duration::from_secs(AUTH_TIMEOUT_SECS);
    let mut idle = tokio::time::interval(Duration::from_secs(5));
    idle.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = cancel_rx.changed() => {
                if *cancel_rx.borrow() {
                    break;
                }
            }
            _ = idle.tick() => {
                if matches!(session, Session::WaitAuth { .. }) {
                    if Instant::now() >= auth_deadline {
                        let _ = enqueue(&control_tx, Outbound::json(error("auth_timeout")));
                        let _ = enqueue(&control_tx, Outbound::Close);
                        break;
                    }
                } else {
                    let last = last_activity.load(Ordering::Relaxed) as i64;
                    if unix_ms().saturating_sub(last) > (WS_IDLE_SECS * 1000) as i64 {
                        tracing::debug!("idle timeout");
                        let _ = enqueue(&control_tx, Outbound::Close);
                        break;
                    }
                }
            }
            incoming = reader.next() => {
                let Some(frame) = incoming else { break; };
                let Ok(frame) = frame else { break; };
                last_activity.store(unix_ms() as u64, Ordering::Relaxed);
                match frame {
                    Message::Ping(p) => {
                        if !enqueue(&control_tx, Outbound::Pong(p)) {
                            break;
                        }
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                    Message::Text(text) => {
                        if !on_text(
                            &state,
                            &control_tx,
                            &data_tx,
                            &mut session,
                            &mut control,
                            &cancel_tx,
                            &host,
                            text.as_str(),
                        )
                        .await
                        {
                            break;
                        }
                    }
                    Message::Binary(bin) => {
                        if let Session::Ready { peer_id, generation } = &session {
                            let wait = bytes.take_or_wait(bin.len() as f64);
                            if !wait.is_zero() {
                                tokio::time::sleep(wait).await;
                            }
                            if let Some((id, payload)) = crate::tunnel::decode_frame(&bin) {
                                state.hub.forward_binary(peer_id, *generation, id, payload).await;
                            }
                        }
                    }
                }
            }
        }
    }

    if let Session::Ready {
        peer_id,
        generation,
    } = &session
    {
        tracing::info!(peer = %short_id(peer_id), "getrennt");
        state.hub.unregister(peer_id, *generation);
    }
    drop(control_tx);
    drop(data_tx);
    let _ = writer_task.await;
}

async fn write_out(writer: &mut SplitSink<WebSocket, Message>, msg: Outbound) -> bool {
    let result = match msg {
        Outbound::Text(s) => writer.send(Message::Text(s.into())).await,
        Outbound::Binary(b) => writer.send(Message::Binary(b)).await,
        Outbound::Pong(p) => writer.send(Message::Pong(p)).await,
        Outbound::Close => {
            let _ = writer.send(Message::Close(None)).await;
            return false;
        }
    };
    result.is_ok()
}

/// false = Steuerkanal voll/tot → Verbindung schließen.
fn enqueue(tx: &mpsc::Sender<Outbound>, msg: Outbound) -> bool {
    tx.try_send(msg).is_ok()
}

#[allow(clippy::too_many_arguments)]
async fn on_text(
    state: &AppState,
    control_tx: &mpsc::Sender<Outbound>,
    data_tx: &mpsc::Sender<Outbound>,
    session: &mut Session,
    control: &mut TokenBucket,
    cancel_tx: &watch::Sender<bool>,
    host: &str,
    text: &str,
) -> bool {
    let parsed: Result<Value, _> = serde_json::from_str(text);
    let Ok(v) = parsed else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };
    let Some(t) = v.get("t").and_then(|x| x.as_str()) else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };

    if matches!(session, Session::WaitAuth { .. }) && t != "auth" && t != "ping" {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    }

    if t != "auth" && !control.try_take(1.0) {
        return enqueue(control_tx, Outbound::json(error("rate")));
    }

    match t {
        "ping" => {
            let n = v.get("n").cloned().unwrap_or(json!(0));
            enqueue(control_tx, Outbound::json(crate::proto::pong(&n)))
        }
        "auth" => handle_auth(state, control_tx, data_tx, session, cancel_tx, host, &v).await,
        "watch" => {
            let Session::Ready {
                peer_id,
                generation,
            } = session
            else {
                return true;
            };
            handle_watch(state, control_tx, peer_id, *generation, &v)
        }
        "open" => {
            let Session::Ready {
                peer_id,
                generation,
            } = session
            else {
                return true;
            };
            handle_open(state, control_tx, peer_id, *generation, &v)
        }
        "accept" => {
            let Session::Ready {
                peer_id,
                generation,
            } = session
            else {
                return true;
            };
            let Some(tid) = tunnel_id(&v) else {
                return enqueue(control_tx, Outbound::json(error("invalid")));
            };
            if state.hub.accept_tunnel(peer_id, *generation, tid).is_err() {
                return enqueue(control_tx, Outbound::json(error("invalid")));
            }
            true
        }
        "reject" => {
            let Session::Ready {
                peer_id,
                generation,
            } = session
            else {
                return true;
            };
            let Some(tid) = tunnel_id(&v) else {
                return enqueue(control_tx, Outbound::json(error("invalid")));
            };
            if state.hub.reject_tunnel(peer_id, *generation, tid).is_err() {
                return enqueue(control_tx, Outbound::json(error("invalid")));
            }
            true
        }
        "close" => {
            let Session::Ready {
                peer_id,
                generation,
            } = session
            else {
                return true;
            };
            if let Some(tid) = tunnel_id(&v) {
                state.hub.close_tunnel(peer_id, *generation, tid, "remote");
            }
            true
        }
        "post" => {
            let Session::Ready {
                peer_id,
                generation: _,
            } = session
            else {
                return true;
            };
            handle_post(state, control_tx, peer_id, &v).await
        }
        "ack" => {
            let Session::Ready { peer_id, .. } = session else {
                return true;
            };
            let ids = v
                .get("ids")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            state.mailbox.ack(peer_id, ids).await;
            true
        }
        _ => enqueue(control_tx, Outbound::json(error("unknown_type"))),
    }
}

async fn handle_auth(
    state: &AppState,
    control_tx: &mpsc::Sender<Outbound>,
    data_tx: &mpsc::Sender<Outbound>,
    session: &mut Session,
    cancel_tx: &watch::Sender<bool>,
    host: &str,
    v: &Value,
) -> bool {
    let Session::WaitAuth { nonce } = session else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };
    let nonce_b64 = nonce.clone();
    if host.is_empty() {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    }
    let Some(pk) = v.get("publicKey").and_then(|x| x.as_str()) else {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    };
    let Some(sig) = v.get("signature").and_then(|x| x.as_str()) else {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    };
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    if !valid_name(&name) {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    }
    let Ok(peer_id) = verify_auth(pk, sig, &nonce_b64, host) else {
        let _ = enqueue(control_tx, Outbound::json(error("auth_failed")));
        let _ = enqueue(control_tx, Outbound::Close);
        return false;
    };
    let registered = state.hub.register(
        peer_id.clone(),
        name,
        control_tx.clone(),
        data_tx.clone(),
        cancel_tx.clone(),
    );
    if control_tx
        .send(Outbound::json(ready(&peer_id)))
        .await
        .is_err()
    {
        state.hub.unregister(&peer_id, registered.generation);
        return false;
    }
    tracing::info!(peer = %short_id(&peer_id), "bereit");
    let pending = state.mailbox.list(&peer_id).await;
    for row in pending {
        let msg = mail(&row.id, &row.from, row.ts, &row.body);
        if control_tx.send(Outbound::json(msg)).await.is_err() {
            state.hub.unregister(&peer_id, registered.generation);
            return false;
        }
        if !row.pushed {
            state.mailbox.mark_pushed(&row.from, &row.id).await;
        }
    }
    *session = Session::Ready {
        peer_id,
        generation: registered.generation,
    };
    true
}

fn handle_watch(
    state: &AppState,
    control_tx: &mpsc::Sender<Outbound>,
    peer_id: &str,
    generation: u64,
    v: &Value,
) -> bool {
    let Some(arr) = v.get("peers").and_then(|x| x.as_array()) else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };
    if arr.len() > MAX_WATCH {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    }
    let peers: Vec<String> = arr
        .iter()
        .filter_map(|x| x.as_str())
        .filter_map(parse_peer_id)
        .filter(|p| p != peer_id)
        .collect();
    let snapshot = state.hub.set_watch(peer_id, generation, peers);
    for msg in snapshot {
        if !enqueue(control_tx, msg) {
            return false;
        }
    }
    true
}

fn handle_open(
    state: &AppState,
    control_tx: &mpsc::Sender<Outbound>,
    peer_id: &str,
    generation: u64,
    v: &Value,
) -> bool {
    let Some(tid) = tunnel_id(v) else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };
    let Some(to_raw) = v.get("to").and_then(|x| x.as_str()) else {
        return enqueue(control_tx, Outbound::json(open_failed(tid, "invalid")));
    };
    let Some(to) = parse_peer_id(to_raw) else {
        return enqueue(control_tx, Outbound::json(open_failed(tid, "invalid")));
    };
    match state.hub.open_tunnel(peer_id, generation, tid, &to) {
        Ok(()) => {
            let hub = state.hub.clone();
            let from = peer_id.to_string();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(OPEN_TIMEOUT_SECS)).await;
                hub.fail_open(&from, tid, generation, "timeout");
            });
            true
        }
        Err(code) => enqueue(control_tx, Outbound::json(open_failed(tid, code))),
    }
}

async fn handle_post(
    state: &AppState,
    control_tx: &mpsc::Sender<Outbound>,
    from: &str,
    v: &Value,
) -> bool {
    let Some(id) = v.get("id").and_then(|x| x.as_str()) else {
        return enqueue(control_tx, Outbound::json(error("invalid")));
    };
    if !valid_mail_id(id) {
        return enqueue(control_tx, Outbound::json(post_failed(id, "invalid")));
    }
    let Some(to_raw) = v.get("to").and_then(|x| x.as_str()) else {
        return enqueue(control_tx, Outbound::json(post_failed(id, "invalid")));
    };
    let Some(to) = parse_peer_id(to_raw) else {
        return enqueue(control_tx, Outbound::json(post_failed(id, "invalid")));
    };
    if to == from {
        return enqueue(control_tx, Outbound::json(post_failed(id, "invalid")));
    }
    let Some(body) = v.get("body") else {
        return enqueue(control_tx, Outbound::json(post_failed(id, "invalid")));
    };
    match state.mailbox.post(from, id, &to, body).await {
        PostOutcome::Failed(code) => enqueue(control_tx, Outbound::json(post_failed(id, code))),
        PostOutcome::Duplicate { status } => {
            enqueue(control_tx, Outbound::json(posted(id, status)))
        }
        PostOutcome::Stored => {
            let mut status = "stored";
            let row_ts = unix_ms();
            let msg = Outbound::json(mail(id, from, row_ts, body));
            if state.hub.deliver_control(&to, msg).await {
                state.mailbox.mark_pushed(from, id).await;
                status = "delivered";
            }
            enqueue(control_tx, Outbound::json(posted(id, status)))
        }
    }
}

fn tunnel_id(v: &Value) -> Option<u32> {
    let n = v.get("tunnel")?;
    let id = n.as_u64()?;
    if id == 0 || id > u32::MAX as u64 {
        return None;
    }
    Some(id as u32)
}
