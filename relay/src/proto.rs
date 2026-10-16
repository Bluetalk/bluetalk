//! JSON-Steuernachrichten und Ausgangs-Queue-Typen.

use bytes::Bytes;
use serde_json::{Value, json};

use crate::util::unix_ms;

/// Textframes max. 1,25 MiB, Binär-Payload max. 64 KiB, Postfach-Body 1 MiB (PROTOCOL.md).
pub const MAX_TEXT_BYTES: usize = (5 * 1024 * 1024) / 4;
pub const MAX_FRAME_PAYLOAD: usize = 65_536;
pub const MAX_MAIL_BODY: usize = 1024 * 1024;
pub const MAX_TUNNELS: usize = 64;
pub const MAX_PENDING_OPENS: usize = 8;
pub const MAX_WATCH: usize = 2000;
pub const OUTBOUND_CONTROL_CAP: usize = 256;
pub const OUTBOUND_DATA_CAP: usize = 64;
pub const AUTH_TIMEOUT_SECS: u64 = 10;
pub const OPEN_TIMEOUT_SECS: u64 = 15;
pub const FORWARD_TIMEOUT_SECS: u64 = 10;
pub const CONTROL_PUSH_TIMEOUT_MS: u64 = 2000;
pub const WS_PING_SECS: u64 = 25;
pub const WS_IDLE_SECS: u64 = 60;
pub const CONTROL_RATE: f64 = 50.0;
pub const BYTE_RATE: f64 = 4.0 * 1024.0 * 1024.0;
pub const BYTE_BURST: f64 = 16.0 * 1024.0 * 1024.0;
pub const PROTOCOL: u32 = 1;

/// Nachrichten an den WebSocket-Writer (begrenzte mpsc-Queue).
#[derive(Debug)]
pub enum Outbound {
    Text(String),
    Binary(Bytes),
    Pong(Bytes),
    Close,
}

impl Outbound {
    pub fn json(value: Value) -> Self {
        Self::Text(value.to_string())
    }
}

pub fn hello(nonce_b64: &str, version: &str) -> Value {
    json!({
        "t": "hello",
        "v": PROTOCOL,
        "nonce": nonce_b64,
        "server": format!("bluetalk-relay/{version}"),
    })
}

pub fn ready(peer_id: &str) -> Value {
    json!({
        "t": "ready",
        "peerId": peer_id,
        "time": unix_ms(),
        "limits": {
            "maxFrame": MAX_FRAME_PAYLOAD,
            "maxMailBody": MAX_MAIL_BODY,
            "maxTunnels": MAX_TUNNELS,
        },
    })
}

pub fn error(code: &str) -> Value {
    json!({ "t": "error", "code": code })
}

pub fn presence(peer_id: &str, online: bool) -> Value {
    json!({ "t": "presence", "peerId": peer_id, "online": online })
}

pub fn incoming(tunnel: u32, from: &str, name: &str) -> Value {
    json!({ "t": "incoming", "tunnel": tunnel, "from": from, "name": name })
}

pub fn opened(tunnel: u32) -> Value {
    json!({ "t": "opened", "tunnel": tunnel })
}

pub fn open_failed(tunnel: u32, code: &str) -> Value {
    json!({ "t": "open_failed", "tunnel": tunnel, "code": code })
}

pub fn closed(tunnel: u32, code: &str) -> Value {
    json!({ "t": "closed", "tunnel": tunnel, "code": code })
}

pub fn posted(id: &str, status: &str) -> Value {
    json!({ "t": "posted", "id": id, "status": status })
}

pub fn post_failed(id: &str, code: &str) -> Value {
    json!({ "t": "post_failed", "id": id, "code": code })
}

pub fn mail(id: &str, from: &str, ts: i64, body: &Value) -> Value {
    json!({ "t": "mail", "id": id, "from": from, "ts": ts, "body": body })
}

pub fn pong(n: &Value) -> Value {
    json!({ "t": "pong", "n": n, "time": unix_ms() })
}
