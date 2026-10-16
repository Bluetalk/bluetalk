//! `settings.cloud` aus der verschlüsselten DB.

use serde_json::{Value, json};
use url::Url;

use crate::{
    database::Database,
    error::{AppError, Result},
};

pub const DEFAULT_RELAY_URL: &str = "wss://bt.henny.dev/v1/ws";
pub const MAX_MAIL_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_TUNNEL_PAYLOAD: usize = 64 * 1024;
pub const DUPLEX_BUFFER: usize = 256 * 1024;
pub const MAX_WATCH_PEERS: usize = 2_000;

#[derive(Debug, Clone)]
pub struct CloudConfig {
    pub enabled: bool,
    pub relay_url: String,
}

impl Default for CloudConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            relay_url: DEFAULT_RELAY_URL.to_owned(),
        }
    }
}

impl CloudConfig {
    pub fn from_value(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(defaults.enabled),
            relay_url: value
                .get("relayUrl")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .unwrap_or(&defaults.relay_url)
                .to_owned(),
        }
    }

    pub fn load(database: &Database) -> Self {
        let stored = database
            .get("settings.cloud", json!({}))
            .unwrap_or(json!({}));
        Self::from_value(&stored)
    }

    pub fn save(&self, database: &Database) -> Result<()> {
        database.set(
            "settings.cloud",
            json!({
                "enabled": self.enabled,
                "relayUrl": self.relay_url,
            }),
        )?;
        Ok(())
    }

    pub fn parsed_url(&self) -> Result<Url> {
        parse_relay_url(&self.relay_url)
    }
}

pub fn parse_relay_url(raw: &str) -> Result<Url> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        return Err(AppError::InvalidInput(
            "Relay-URL fehlt oder ist zu lang.".to_owned(),
        ));
    }
    let url = Url::parse(trimmed).map_err(|_| {
        AppError::InvalidInput("Relay-URL ist ungültig.".to_owned())
    })?;
    match url.scheme() {
        "wss" => {}
        "ws" => {
            let host = url.host_str().unwrap_or("");
            if host != "localhost" && host != "127.0.0.1" && host != "::1" {
                return Err(AppError::InvalidInput(
                    "ws:// ist nur für localhost erlaubt.".to_owned(),
                ));
            }
        }
        _ => {
            return Err(AppError::InvalidInput(
                "Nur wss:// ist erlaubt (ws:// nur lokal).".to_owned(),
            ));
        }
    }
    if url.host_str().is_none() {
        return Err(AppError::InvalidInput(
            "Relay-URL braucht einen Host.".to_owned(),
        ));
    }
    Ok(url)
}

/// Host für die Auth-Signatur: klein, `:port` nur wenn nicht Standard.
pub fn auth_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

pub fn from_command_value(value: &Value) -> Result<CloudConfig> {
    let mut config = CloudConfig::default();
    if let Some(enabled) = value.get("enabled").and_then(Value::as_bool) {
        config.enabled = enabled;
    }
    if let Some(url) = value.get("relayUrl").and_then(Value::as_str) {
        config.relay_url = url.trim().to_owned();
    }
    if config.relay_url.is_empty() {
        config.relay_url = DEFAULT_RELAY_URL.to_owned();
    }
    parse_relay_url(&config.relay_url)?;
    Ok(config)
}
