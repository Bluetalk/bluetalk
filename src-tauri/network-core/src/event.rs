use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionDirection {
    Inbound,
    Outbound,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerInfo {
    pub peer_id: String,
    pub display_name: String,
    pub remote_address: String,
    pub connected_at_ms: i64,
    pub direction: ConnectionDirection,
    pub protocol_version: u16,
    /// Always true for peers returned by the v2 service. Legacy candidates
    /// use separate types and cannot enter this collection.
    pub authenticated_encryption: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeer {
    pub peer_id: String,
    pub display_name: String,
    pub endpoints: Vec<String>,
    pub observed_from: String,
    pub advertised_at_ms: i64,
    pub protocol_versions: Vec<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub peer_id: String,
    pub display_name: String,
    pub protocol_versions: Vec<u16>,
    pub listen_addresses: Vec<String>,
    pub started: bool,
    pub connected_peer_count: usize,
    pub discovery_enabled: bool,
    pub max_frame_bytes: usize,
    pub outbound_queue_frames: usize,
    pub outbound_queue_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryResult {
    pub peer_id: String,
    pub accepted: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum NetworkEvent {
    PeerConnected(PeerInfo),
    PeerDisconnected {
        peer_id: String,
        reason: String,
    },
    PeerDiscovered(DiscoveredPeer),
    Message {
        from_peer_id: String,
        message_id: String,
        sent_at_ms: i64,
        payload: serde_json::Value,
    },
    Warning {
        code: String,
        message: String,
    },
}

/// Minimal callback boundary for Tauri, tests, or another host runtime.
/// Implementations should return quickly and enqueue any expensive work.
pub trait NetworkEventSink: Send + Sync + 'static {
    fn emit(&self, event: NetworkEvent);
}

impl<F> NetworkEventSink for F
where
    F: Fn(NetworkEvent) + Send + Sync + 'static,
{
    fn emit(&self, event: NetworkEvent) {
        self(event);
    }
}

#[derive(Debug, Default)]
pub struct NoopEventSink;

impl NetworkEventSink for NoopEventSink {
    fn emit(&self, _event: NetworkEvent) {}
}

