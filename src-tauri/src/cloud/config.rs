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
pub const DEVICE_ID_KEY: &str = "cloudDeviceId";

pub fn is_valid_device_id(id: &str) -> bool {
    let len = id.len();
    (8..=64).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn generate_device_id() -> String {
    let mut bytes = [0_u8; 16];
    rand::fill(&mut bytes);
    hex::encode(bytes)
}

pub fn local_device_name() -> String {
    match std::env::consts::OS {
        "windows" => "Windows".to_owned(),
        "macos" => "macOS".to_owned(),
        "linux" => "Linux".to_owned(),
        other => {
            let mut name = other.to_owned();
            if let Some(first) = name.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            name.chars().take(64).collect()
        }
    }
}

/// Dieselbe Store-ID wie der Sync-`origin` (`cloudDeviceId`).
pub fn load_or_create_device_id(database: &Database) -> String {
    let stored = database
        .get(DEVICE_ID_KEY, Value::Null)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned));
    if let Some(id) = stored.filter(|id| is_valid_device_id(id)) {
        return id;
    }
    let id = generate_device_id();
    if let Err(error) = database.set(DEVICE_ID_KEY, json!(id.clone())) {
        log::warn!("cloudDeviceId konnte nicht gespeichert werden: {error}");
    }
    id
}

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
