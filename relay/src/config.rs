//! Konfiguration aus Umgebungsvariablen (siehe PROTOCOL.md).

use std::path::PathBuf;

use crate::util::normalize_host;

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
        Self {
            port,
            data_dir,
            public_host,
            trust_proxy,
            client_ip_header,
            max_connections_per_ip,
        }
    }
}
