//! HTTP: Infoseite, /healthz, /v1/info, WebSocket-Upgrade, Web-Hosting.

use std::net::SocketAddr;
use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{ConnectInfo, Request, State, ws::WebSocketUpgrade},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

use crate::proto::MAX_TEXT_BYTES;
use crate::ratelimit::IpGuard;
use crate::util::{client_ip, normalize_host};
use crate::{AppState, api, ws};

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
     <strong>BlueTalk Cloud</strong> die URL deines Servers ein.</p>
  <p><a href="https://github.com/Bluetalk/bluetalk">Quellcode auf GitHub</a></p>
</main>
</body>
</html>
"##;

const WEB_CSP: &str = "default-src 'self'; connect-src 'self' wss: https:; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const WEB_PERMISSIONS: &str = "microphone=(self)";

pub fn router(state: AppState) -> Router {
    let web_dir = state.config.web_dir.clone();
    let has_web = web_dir.join("index.html").is_file();
    let mut v1 = Router::new()
        .route("/info", get(info))
        .route("/ws", get(ws_upgrade));
    if state.config.accounts_enabled {
        v1 = v1
            .nest("/account", api::account_router())
            .nest("/sync", api::sync_router());
    }
    v1 = v1.fallback(v1_not_found);
    let mut app = Router::new()
        .route("/healthz", get(healthz))
        .route("/info", get(index))
        .nest("/v1", v1);
    if has_web {
        app = app.fallback_service(web_service(web_dir));
    } else {
        app = app.route("/", get(index));
    }
    app.with_state(state)
}

fn web_service(web_dir: PathBuf) -> Router<()> {
    let index = web_dir.join("index.html");
    let assets_dir = web_dir.join("assets");
    let rest = ServeDir::new(web_dir)
        .append_index_html_on_directories(true)
        .fallback(ServeFile::new(index));
    Router::new()
        .nest_service("/assets", ServeDir::new(assets_dir))
        .fallback_service(rest)
        .layer(middleware::from_fn(web_file_headers))
}

async fn v1_not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({"error": "not_found", "message": "not found"})),
    )
        .into_response()
}

async fn web_file_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_owned();
    let mut res = next.run(req).await;
    let is_success = res.status().is_success();
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(WEB_CSP) {
        headers.insert(header::CONTENT_SECURITY_POLICY, v);
    }
    if let Ok(v) = HeaderValue::from_str(WEB_PERMISSIONS) {
        headers.insert("permissions-policy", v);
    }
    let is_index = path == "/" || path == "/index.html" || path.ends_with("/index.html");
    if is_index {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    } else if path.starts_with("/assets/") && is_success {
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        );
    }
    res
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
