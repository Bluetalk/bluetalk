//! BlueTalk Cloud Relay: dummer, zugangsgeschützter Vermittler.
//!
//! Der Relay sieht nie Klartext — nur Peer-IDs, Größen, Zeitpunkte und IPs.
//! Protokoll: `PROTOCOL.md`.

mod accounts;
mod api;
mod auth;
mod config;
mod db;
mod http;
mod hub;
mod mailbox;
mod proto;
mod ratelimit;
mod tunnel;
mod util;
mod ws;

pub use config::Config;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use tokio::net::TcpListener;
use tracing::info;

use crate::{
    accounts::AccountStore,
    hub::Hub,
    mailbox::Mailbox,
    ratelimit::{IpLimiter, WindowLimiter},
};

/// Gemeinsamer Zustand aller HTTP-/WebSocket-Verbindungen.
#[derive(Clone)]
pub struct AppState {
    pub(crate) config: Arc<Config>,
    pub(crate) hub: Arc<Hub>,
    pub(crate) mailbox: Mailbox,
    pub(crate) accounts: AccountStore,
    pub(crate) ips: Arc<IpLimiter>,
    pub(crate) windows: Arc<WindowLimiter>,
}

/// Startet den Relay auf `0.0.0.0:PORT` und wartet auf SIGTERM/Ctrl-C.
pub async fn run(config: Config) -> std::io::Result<()> {
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    let listener = TcpListener::bind(addr).await?;
    info!(%addr, "relay lauscht");
    serve_listener(listener, config).await
}

/// Startet den Relay auf einem bereits gebundenen Listener (Tests).
pub async fn serve_listener(listener: TcpListener, config: Config) -> std::io::Result<()> {
    let state = build_state(config)?;
    spawn_mail_cleanup(state.mailbox.clone());
    let app = http::router(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
}

/// Wie [`serve_listener`], aber ohne Prozess-Shutdown — für Integrationstests.
pub async fn serve_listener_until_cancelled(
    listener: TcpListener,
    config: Config,
    cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let state = build_state(config)?;
    spawn_mail_cleanup(state.mailbox.clone());
    let app = http::router(state);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let mut cancel = cancel;
        loop {
            if *cancel.borrow() {
                break;
            }
            if cancel.changed().await.is_err() {
                break;
            }
        }
    })
    .await
}

fn build_state(config: Config) -> std::io::Result<AppState> {
    std::fs::create_dir_all(&config.data_dir)?;
    let db_path: PathBuf = config.data_dir.join("relay.db");
    let mailbox = Mailbox::open(&db_path).map_err(std::io::Error::other)?;
    let accounts = AccountStore::open(&db_path).map_err(std::io::Error::other)?;
    let ips = Arc::new(IpLimiter::new(config.max_connections_per_ip));
    Ok(AppState {
        config: Arc::new(config),
        hub: Hub::new(),
        mailbox,
        accounts,
        ips,
        windows: Arc::new(WindowLimiter::new()),
    })
}

fn spawn_mail_cleanup(mailbox: Mailbox) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            mailbox.cleanup().await;
        }
    });
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    info!("shutdown");
}

/// Einfacher HTTP-GET gegen `/healthz` (Docker-HEALTHCHECK, kein curl).
pub fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
        Ok(s) => s,
        Err(_) => return 1,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return 1;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    if text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200") {
        0
    } else {
        1
    }
}
