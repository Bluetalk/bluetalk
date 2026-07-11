use std::io;

#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error("invalid network configuration: {0}")]
    InvalidConfig(String),
    #[error("identity error: {0}")]
    Identity(String),
    #[error("network service is not started")]
    NotStarted,
    #[error("network service is already started")]
    AlreadyStarted,
    #[error("peer not found: {0}")]
    PeerNotFound(String),
    #[error("peer already connected: {0}")]
    DuplicatePeer(String),
    #[error("peer identity mismatch: expected {expected}, received {actual}")]
    PeerIdentityMismatch { expected: String, actual: String },
    #[error("outbound queue is full for peer {0}")]
    Backpressure(String),
    #[error("frame is {actual} bytes, maximum is {maximum}")]
    FrameTooLarge { actual: usize, maximum: usize },
    #[error("operation timed out: {0}")]
    Timeout(&'static str),
    #[error("handshake rejected: {0}")]
    Handshake(String),
    #[error("protocol violation: {0}")]
    Protocol(String),
    #[error("cryptographic operation failed: {0}")]
    Crypto(String),
    #[error("discovery packet rejected: {0}")]
    Discovery(String),
    #[error("connection closed")]
    Closed,
    #[error("serialization failed: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("I/O failed: {0}")]
    Io(#[from] io::Error),
}

pub type Result<T, E = NetworkError> = std::result::Result<T, E>;

