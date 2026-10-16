//! Cloud-Status für Commands und Events.

use serde_json::{Value, json};

use super::config::CloudConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudState {
    Disabled,
    Connecting,
    Online,
    Offline,
    Error,
    Replaced,
}

impl CloudState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Connecting => "connecting",
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Error => "error",
            Self::Replaced => "replaced",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CloudDevice {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct StatusSnapshot {
    pub enabled: bool,
    pub relay_url: String,
    pub state: CloudState,
    pub peer_id: String,
    pub last_error: Option<String>,
    pub latency_ms: Option<u64>,
    pub connected_at: Option<i64>,
    pub tunnels: usize,
    pub online_peers: Vec<String>,
    pub device_id: String,
    pub device_name: String,
    /// Andere eigene Geräte vom Relay (`ready`/`devices`).
    pub other_devices: Vec<CloudDevice>,
}

impl StatusSnapshot {
    pub fn from_config(config: &CloudConfig) -> Self {
        Self {
            enabled: config.enabled,
            relay_url: config.relay_url.clone(),
            state: if config.enabled {
                CloudState::Connecting
            } else {
                CloudState::Disabled
            },
            peer_id: String::new(),
            last_error: None,
            latency_ms: None,
            connected_at: None,
            tunnels: 0,
            online_peers: Vec::new(),
            device_id: String::new(),
            device_name: super::config::local_device_name(),
            other_devices: Vec::new(),
        }
    }

    pub fn to_value(&self) -> Value {
        let online = self.state == CloudState::Online;
        let mut devices = Vec::new();
        if !self.device_id.is_empty() {
            devices.push(json!({
                "id": self.device_id,
                "name": self.device_name,
                "thisDevice": true,
                "online": online,
            }));
        }
        for device in &self.other_devices {
            devices.push(json!({
                "id": device.id,
                "name": device.name,
                "thisDevice": false,
                "online": online,
            }));
        }
        json!({
            "enabled": self.enabled,
            "relayUrl": self.relay_url,
            "state": self.state.as_str(),
            "peerId": self.peer_id,
            "lastError": self.last_error,
            "latencyMs": self.latency_ms,
            "connectedAt": self.connected_at,
            "tunnels": self.tunnels,
            "onlinePeers": self.online_peers,
            "deviceId": self.device_id,
            "deviceName": self.device_name,
            "devices": devices,
        })
    }
}
