//! HTTP: Infoseite, /healthz, /v1/info, WebSocket-Upgrade.

use std::net::SocketAddr;

use axum::{
    Json, Router,
    extract::{ConnectInfo, State, ws::WebSocketUpgrade},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde_json::json;

use crate::proto::MAX_TEXT_BYTES;
use crate::ratelimit::IpGuard;
use crate::util::{client_ip, normalize_host};
use crate::{AppState, ws};

const INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>BlueTalk Cloud Relay</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, sans-serif;
    background: #0e1116;
    color: #e6edf3;
  }
  main { max-width: 40rem; margin: 12vh auto; padding: 0 1.5rem; }
  h1 { font-size: 1.45rem; font-weight: 600; letter-spacing: -0.02em; }
  p { line-height: 1.55; color: #b6c2cf; }
  a { color: #6cb6ff; }
  .kicker { font-size: 0.78rem; color: #8b9eb0; letter-spacing: 0.04em; text-transform: uppercase; }
</style>
</head>
<body>
<main>
  <p class="kicker">BlueTalk Cloud Relay</p>
  <h1>Offener Nachrichten-Vermittler</h1>
  <p>Dieser Server vermittelt Ende-zu-Ende-verschlüsselte Cloud-Nachrichten
     zwischen BlueTalk-Clients. Er sieht keinen Klartext — nur Peer-IDs,
     Größen, Zeitpunkte und IP-Adressen.</p>
  <p>Du kannst diesen Relay selbst hosten. In der BlueTalk-App trägst du unter
     <strong>Cloud-Nachrichten</strong> die URL deines Servers ein.</p>
  <p><a href="https://github.com/Bluetalk/bluetalk">Quellcode auf GitHub</a></p>
</main>
</body>
</html>
"##;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/healthz", get(healthz))
        .route("/v1/info", get(info))
        .route("/v1/ws", get(ws_upgrade))
        .with_state(state)
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn healthz() -> &'static str {
    "ok"
}

async fn info(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "name": "BlueTalk Cloud Relay",
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": 1,
        "online": state.hub.online_count(),
    }))
}

async fn ws_upgrade(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let ip = client_ip(
        &headers,
        addr,
        state.config.trust_proxy,
        state.config.client_ip_header.as_deref(),
    );
    let Some(guard) = IpGuard::new(state.ips.clone(), ip) else {
        return (StatusCode::TOO_MANY_REQUESTS, "rate").into_response();
    };
    let host = state.config.public_host.clone().unwrap_or_else(|| {
        headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .map(normalize_host)
            .unwrap_or_default()
    });
    ws.max_message_size(MAX_TEXT_BYTES)
        .max_frame_size(MAX_TEXT_BYTES)
        .on_upgrade(move |socket| ws::handle_socket(socket, state, host, guard))
}
