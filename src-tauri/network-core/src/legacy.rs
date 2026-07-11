//! Strictly isolated BlueTalk v1 discovery compatibility.
//!
//! V1 advertisements are unauthenticated and v1 WebSocket traffic is not
//! transport-encrypted. The secure v2 service never silently downgrades a v2
//! connection or inserts a legacy candidate into its authenticated peer set.

use serde::{Deserialize, Serialize};

use crate::{NetworkError, Result};

pub const LEGACY_DISCOVERY_MAGIC: &str = "BLUETALK_V2";
pub const LEGACY_DISCOVERY_PORT: u16 = 41_234;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LegacyInteropPolicy {
    #[default]
    Off,
    /// Parse and surface candidates for explicit user approval. This does not
    /// enable the legacy WebSocket transport.
    DiscoveryOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPeerCandidate {
    pub device_id: String,
    pub display_name: String,
    pub port: u16,
    pub observed_address: Option<String>,
    pub authenticated: bool,
    pub encrypted_transport: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyPacket {
    #[serde(rename = "type")]
    packet_type: String,
    #[serde(alias = "deviceId")]
    device_id: String,
    #[serde(default, alias = "deviceName", alias = "name")]
    display_name: String,
    port: u16,
}

pub fn parse_discovery_packet(
    policy: LegacyInteropPolicy,
    packet: &[u8],
    observed_address: Option<String>,
) -> Result<LegacyPeerCandidate> {
    if policy == LegacyInteropPolicy::Off {
        return Err(NetworkError::Protocol(
            "legacy interoperability is disabled".to_owned(),
        ));
    }
    if packet.len() > 4_096 {
        return Err(NetworkError::FrameTooLarge {
            actual: packet.len(),
            maximum: 4_096,
        });
    }
    let packet: LegacyPacket = serde_json::from_slice(packet)
        .map_err(|error| NetworkError::Protocol(format!("invalid legacy packet: {error}")))?;
    if packet.packet_type != LEGACY_DISCOVERY_MAGIC {
        return Err(NetworkError::Protocol(
            "incorrect legacy discovery magic".to_owned(),
        ));
    }
    if packet.device_id.is_empty() || packet.device_id.len() > 256 {
        return Err(NetworkError::Protocol(
            "legacy device id must contain 1..=256 bytes".to_owned(),
        ));
    }
    if packet.display_name.len() > 256 || packet.port == 0 {
        return Err(NetworkError::Protocol(
            "invalid legacy discovery fields".to_owned(),
        ));
    }
    Ok(LegacyPeerCandidate {
        device_id: packet.device_id,
        display_name: packet.display_name,
        port: packet.port,
        observed_address,
        authenticated: false,
        encrypted_transport: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_candidates_are_explicitly_unauthenticated() {
        let packet = br#"{"type":"BLUETALK_V2","deviceId":"old-peer","deviceName":"Old peer","port":41234}"#;
        let peer = parse_discovery_packet(
            LegacyInteropPolicy::DiscoveryOnly,
            packet,
            Some("192.0.2.1".to_owned()),
        )
        .unwrap();
        assert!(!peer.authenticated);
        assert!(!peer.encrypted_transport);
        assert!(parse_discovery_packet(LegacyInteropPolicy::Off, packet, None).is_err());
    }
}
