//! Konfiguration aus Umgebungsvariablen (siehe PROTOCOL.md / ACCOUNTS.md).

use std::path::PathBuf;

use crate::util::normalize_host;

pub const DEFAULT_SYNC_QUOTA_BYTES: i64 = 256 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub data_dir: PathBuf,
    /// Erwarteter Host in der Auth-Signatur; `None` = Host-Header der Verbindung.
    pub public_host: Option<String>,
    /// `TRUST_PROXY=1`: letztes `X-Forwarded-For`-Element (nächster Proxy).
    pub trust_proxy: bool,
    /// Exakter Header für die Client-IP (z. B. `cf-connecting-ip`); hat Vorrang.
    pub client_ip_header: Option<String>,
    pub max_connections_per_ip: u32,
    /// Gebautes BlueTalk Web; fehlt `index.html` → Infoseite unter `/`.
    pub web_dir: PathBuf,
    pub sync_quota_bytes: i64,
    pub accounts_enabled: bool,
}

impl Config {
    pub fn from_env() -> Self {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080);
        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/data"));
        let public_host = std::env::var("PUBLIC_HOST")
            .ok()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty())
            .map(|h| normalize_host(&h));
        let trust_proxy = matches!(
            std::env::var("TRUST_PROXY").ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE") | Some("yes")
        );
        let client_ip_header = std::env::var("CLIENT_IP_HEADER")
            .ok()
            .map(|h| h.trim().to_string())
            .filter(|h| !h.is_empty());
        let max_connections_per_ip = std::env::var("MAX_CONNECTIONS_PER_IP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(32)
            .max(1);
        let web_dir = std::env::var("WEB_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/srv/web"));
        let sync_quota_bytes = std::env::var("SYNC_QUOTA_BYTES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_SYNC_QUOTA_BYTES)
            .max(0);
        let accounts_enabled = env_flag("ACCOUNTS_ENABLED", true);
        Self {
            port,
            data_dir,
            public_host,
            trust_proxy,
            client_ip_header,
            max_connections_per_ip,
            web_dir,
            sync_quota_bytes,
            accounts_enabled,
        }
    }

    pub fn test(data_dir: PathBuf, port: u16) -> Self {
        Self {
            port,
            data_dir,
            public_host: None,
            trust_proxy: false,
            client_ip_header: None,
            max_connections_per_ip: 32,
            web_dir: PathBuf::from("/nonexistent-bluetalk-web"),
            sync_quota_bytes: DEFAULT_SYNC_QUOTA_BYTES,
            accounts_enabled: true,
        }
    }
}

fn env_flag(name: &str, default: bool) -> bool {
    match std::env::var(name)
        .ok()
        .as_deref()
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("1") | Some("true") | Some("yes") => true,
        Some("0") | Some("false") | Some("no") => false,
        _ => default,
    }
}
