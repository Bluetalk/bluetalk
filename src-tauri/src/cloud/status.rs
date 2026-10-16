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
}

impl CloudState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Connecting => "connecting",
            Self::Online => "online",
            Self::Offline => "offline",
            Self::Error => "error",
        }
    }
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
        }
    }

    pub fn to_value(&self) -> Value {
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
        })
    }
}
