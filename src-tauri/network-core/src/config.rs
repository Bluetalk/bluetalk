use std::{net::SocketAddr, time::Duration};

use crate::{NetworkError, Result};

/// Resource limits are enforced before allocations or queueing.
#[derive(Debug, Clone)]
pub struct NetworkLimits {
    /// Maximum serialized application frame size. Defaults to 8 MiB.
    pub max_frame_bytes: usize,
    /// Maximum number of pending frames per peer.
    pub outbound_queue_frames: usize,
    /// Maximum aggregate serialized bytes pending per peer.
    pub outbound_queue_bytes: usize,
    /// Maximum concurrently executing inbound handshakes.
    pub max_pending_handshakes: usize,
}

impl Default for NetworkLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 8 * 1024 * 1024,
            outbound_queue_frames: 64,
            outbound_queue_bytes: 16 * 1024 * 1024,
            max_pending_handshakes: 32,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NetworkTimeouts {
    pub connect: Duration,
    pub handshake: Duration,
    pub write: Duration,
    pub idle: Duration,
    pub heartbeat: Duration,
}

impl Default for NetworkTimeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(5),
            handshake: Duration::from_secs(8),
            write: Duration::from_secs(10),
            idle: Duration::from_secs(90),
            heartbeat: Duration::from_secs(25),
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveryConfig {
    /// UDP address used for signed v2 discovery announcements.
    pub bind_addr: SocketAddr,
    /// Broadcast or unicast destinations. Supplying explicit interface
    /// broadcast addresses works in networks that block 255.255.255.255.
    pub targets: Vec<SocketAddr>,
    pub max_packet_bytes: usize,
    pub max_clock_skew: Duration,
    pub replay_window: Duration,
    pub replay_cache_entries: usize,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            bind_addr: "0.0.0.0:41235".parse().expect("static socket address"),
            targets: vec!["255.255.255.255:41235"
                .parse()
                .expect("static socket address")],
            max_packet_bytes: 16 * 1024,
            max_clock_skew: Duration::from_secs(120),
            replay_window: Duration::from_secs(180),
            replay_cache_entries: 4_096,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NetworkConfig {
    pub display_name: String,
    pub listen_addr: SocketAddr,
    /// `None` disables UDP discovery without affecting direct connections.
    pub discovery: Option<DiscoveryConfig>,
    pub limits: NetworkLimits,
    pub timeouts: NetworkTimeouts,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            display_name: "BlueTalk user".to_owned(),
            listen_addr: "0.0.0.0:41236".parse().expect("static socket address"),
            discovery: Some(DiscoveryConfig::default()),
            limits: NetworkLimits::default(),
            timeouts: NetworkTimeouts::default(),
        }
    }
}

impl NetworkConfig {
    pub(crate) fn validate(&self) -> Result<()> {
        let name_len = self.display_name.as_bytes().len();
        if name_len == 0 || name_len > 128 {
            return Err(NetworkError::InvalidConfig(
                "display_name must contain 1..=128 UTF-8 bytes".to_owned(),
            ));
        }
        if self.limits.max_frame_bytes == 0
            || self.limits.max_frame_bytes > 64 * 1024 * 1024
        {
            return Err(NetworkError::InvalidConfig(
                "max_frame_bytes must be in 1..=67108864".to_owned(),
            ));
        }
        if self.limits.outbound_queue_frames == 0 {
            return Err(NetworkError::InvalidConfig(
                "outbound_queue_frames must be non-zero".to_owned(),
            ));
        }
        if self.limits.outbound_queue_bytes == 0
            || self.limits.outbound_queue_bytes > u32::MAX as usize
        {
            return Err(NetworkError::InvalidConfig(
                "outbound_queue_bytes must be in 1..=u32::MAX".to_owned(),
            ));
        }
        if self.limits.max_pending_handshakes == 0 {
            return Err(NetworkError::InvalidConfig(
                "max_pending_handshakes must be non-zero".to_owned(),
            ));
        }
        if self.timeouts.connect.is_zero()
            || self.timeouts.handshake.is_zero()
            || self.timeouts.write.is_zero()
            || self.timeouts.idle.is_zero()
            || self.timeouts.heartbeat.is_zero()
        {
            return Err(NetworkError::InvalidConfig(
                "network timeouts must be non-zero".to_owned(),
            ));
        }
        if self.timeouts.heartbeat >= self.timeouts.idle {
            return Err(NetworkError::InvalidConfig(
                "heartbeat must be shorter than idle timeout".to_owned(),
            ));
        }
        if let Some(discovery) = &self.discovery {
            if discovery.max_packet_bytes < 512 || discovery.max_packet_bytes > 65_507 {
                return Err(NetworkError::InvalidConfig(
                    "discovery max_packet_bytes must be in 512..=65507".to_owned(),
                ));
            }
            if discovery.replay_cache_entries == 0 {
                return Err(NetworkError::InvalidConfig(
                    "discovery replay_cache_entries must be non-zero".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

