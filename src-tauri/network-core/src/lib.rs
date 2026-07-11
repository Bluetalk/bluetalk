//! BlueTalk v2 peer-networking core.
//!
//! The crate deliberately has no Tauri dependency. Applications provide a
//! [`NetworkEventSink`] and expose the async [`PeerNetwork`] operations through
//! their preferred command layer. The wire protocol uses signed ephemeral
//! X25519 handshakes, HKDF-SHA256 session derivation, and ChaCha20-Poly1305
//! records. Legacy v1 parsing is isolated in [`legacy`] and never participates
//! in a v2 authenticated session.

mod config;
mod discovery;
mod error;
mod event;
mod identity;
pub mod legacy;
mod protocol;
mod service;

pub use config::{DiscoveryConfig, NetworkConfig, NetworkLimits, NetworkTimeouts};
pub use error::{NetworkError, Result};
pub use event::{
    ConnectionDirection, DeliveryResult, DiscoveredPeer, NetworkEvent, NetworkEventSink,
    NetworkInfo, NoopEventSink, PeerInfo,
};
pub use identity::NetworkIdentity;
pub use protocol::{PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS};
pub use service::PeerNetwork;

