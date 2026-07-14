//! Application-level peer networking: wraps [`bluetalk_network::PeerNetwork`],
//! translates its events into the renderer event contract, provides encrypted
//! in-band file transfer, and reconnects known contacts with backoff.

use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use bluetalk_network::{
    DiscoveryConfig, NetworkConfig, NetworkEvent, NetworkEventSink, NetworkIdentity, PeerNetwork,
};
use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};
use tokio::sync::{RwLock, oneshot};

use crate::{
    database::Database,
    error::{AppError, Result},
};

const DEFAULT_LISTEN_PORT: u16 = 41_236;
const DISCOVERY_PORT: u16 = 41_235;
const MAX_HOSTED_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_HOSTED_FILES: usize = 20;
const MAX_TOTAL_HOSTED_FILE_BYTES: usize = 64 * 1024 * 1024;
const FILE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_BASE_DELAY_MS: u64 = 1_000;
const RECONNECT_MAX_DELAY_MS: u64 = 30_000;
const FILE_REQUEST_KIND: &str = "bt2:file-request";
const FILE_RESPONSE_KIND: &str = "bt2:file-response";

struct HostedFile {
    id: String,
    name: String,
    size: usize,
    mime_type: String,
    data: Vec<u8>,
    created_at: i64,
}

struct ReconnectEntry {
    attempt: u32,
    task: tauri::async_runtime::JoinHandle<()>,
}

pub struct PeerService {
    app: AppHandle,
    database: Arc<Database>,
    identity_path: PathBuf,
    network: RwLock<Option<Arc<PeerNetwork>>>,
    hosted: Mutex<Vec<HostedFile>>,
    pending_file_requests: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    reconnects: Mutex<HashMap<String, ReconnectEntry>>,
}

struct ServiceSink {
    service: std::sync::Weak<PeerService>,
}

impl NetworkEventSink for ServiceSink {
    fn emit(&self, event: NetworkEvent) {
        let Some(service) = self.service.upgrade() else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            service.handle_network_event(event).await;
        });
    }
}

impl PeerService {
    pub fn initialize(app: AppHandle, database: Arc<Database>, data_dir: PathBuf) -> Arc<Self> {
        let service = Arc::new(Self {
            app,
            database,
            identity_path: data_dir.join("network-identity.json"),
            network: RwLock::new(None),
            hosted: Mutex::new(Vec::new()),
            pending_file_requests: Mutex::new(HashMap::new()),
            reconnects: Mutex::new(HashMap::new()),
        });

        let startup = service.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = startup.start_network().await {
                log::error!("peer network failed to start: {error}");
                let _ = startup.app.emit(
                    "peer:disconnected",
                    json!({ "id": null, "reason": format!("network unavailable: {error}") }),
                );
            }
            let _ = startup.app.emit("peers:list-sync", startup.peers_snapshot().await);
            // Give the listener a moment before dialing out, mirroring v1.
            tokio::time::sleep(Duration::from_secs(1)).await;
            startup.reconnect_contacts().await;
        });

        service
    }

    fn identity(&self) -> Result<NetworkIdentity> {
        NetworkIdentity::load_or_create(&self.identity_path)
            .map_err(|error| AppError::Network(format!("identity unavailable: {error}")))
    }

    fn display_name(&self) -> String {
        let name = self
            .database
            .get("settings.displayName", Value::Null)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_default();
        let trimmed = name.trim();
        if trimmed.is_empty() {
            "BlueTalk user".to_owned()
        } else {
            trimmed.chars().take(100).collect()
        }
    }

    fn configured_port(&self) -> u16 {
        self.database
            .get("settings.peerPort", Value::Null)
            .ok()
            .and_then(|value| value.as_u64())
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .unwrap_or(DEFAULT_LISTEN_PORT)
    }

    fn build_config(&self, listen_port: u16) -> NetworkConfig {
        let mut targets: Vec<SocketAddr> = local_broadcast_addresses()
            .into_iter()
            .map(|ip| SocketAddr::new(IpAddr::V4(ip), DISCOVERY_PORT))
            .collect();
        targets.push(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::BROADCAST),
            DISCOVERY_PORT,
        ));
        targets.sort();
        targets.dedup();

        let mut limits = bluetalk_network::NetworkLimits::default();
        // Base64-encoded 8 MiB attachments plus envelope overhead must fit in
        // one frame for the in-band file transfer.
        limits.max_frame_bytes = 16 * 1024 * 1024;

        NetworkConfig {
            display_name: self.display_name(),
            listen_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), listen_port),
            discovery: Some(DiscoveryConfig {
                bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), DISCOVERY_PORT),
                targets,
                ..DiscoveryConfig::default()
            }),
            limits,
            timeouts: bluetalk_network::NetworkTimeouts::default(),
        }
    }

    async fn start_network(self: &Arc<Self>) -> Result<()> {
        let identity = self.identity()?;
        let sink = Arc::new(ServiceSink {
            service: Arc::downgrade(self),
        });

        let configured_port = self.configured_port();
        // The configured port may be taken by another instance; fall back to
        // an ephemeral port instead of failing the whole app.
        for port in [configured_port, 0] {
            let network = PeerNetwork::new(
                identity.clone(),
                self.build_config(port),
                sink.clone() as Arc<dyn NetworkEventSink>,
            )
            .map_err(|error| AppError::Network(error.to_string()))?;
            match network.start().await {
                Ok(info) => {
                    log::info!(
                        "peer network listening on {:?} as {}",
                        info.listen_addresses,
                        info.peer_id
                    );
                    *self.network.write().await = Some(Arc::new(network));
                    return Ok(());
                }
                Err(error) if port != 0 => {
                    log::warn!("listen port {port} unavailable ({error}); using an ephemeral port");
                }
                Err(error) => return Err(AppError::Network(error.to_string())),
            }
        }
        unreachable!("ephemeral bind either succeeds or returns above");
    }

    async fn network(&self) -> Result<Arc<PeerNetwork>> {
        self.network
            .read()
            .await
            .clone()
            .ok_or_else(|| AppError::NotReady("peer network is not running".to_owned()))
    }

    /// Stops the network, rebuilds it with fresh settings (display name and
    /// port), restarts it, and re-dials stored contacts.
    pub async fn reset_all_connections(self: &Arc<Self>) -> Result<()> {
        {
            let mut reconnects = self.reconnects.lock();
            for (_, entry) in reconnects.drain() {
                entry.task.abort();
            }
        }
        if let Some(network) = self.network.write().await.take() {
            network.stop().await;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        self.start_network().await?;
        let _ = self.app.emit("peers:list-sync", self.peers_snapshot().await);
        self.reconnect_contacts().await;
        Ok(())
    }

    /// Full wipe: drops all connections, deletes the identity seed (a new
    /// peer id is generated on restart), and brings the network back up.
    pub async fn wipe_identity_and_reset(self: &Arc<Self>) -> Result<()> {
        {
            let mut reconnects = self.reconnects.lock();
            for (_, entry) in reconnects.drain() {
                entry.task.abort();
            }
        }
        self.hosted.lock().clear();
        self.pending_file_requests.lock().clear();
        if let Some(network) = self.network.write().await.take() {
            network.stop().await;
        }
        match std::fs::remove_file(&self.identity_path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.start_network().await?;
        let _ = self.app.emit("peers:list-sync", self.peers_snapshot().await);
        Ok(())
    }

    pub async fn shutdown(&self) {
        {
            let mut reconnects = self.reconnects.lock();
            for (_, entry) in reconnects.drain() {
                entry.task.abort();
            }
        }
        if let Some(network) = self.network.write().await.take() {
            network.stop().await;
        }
    }
}

struct StoredContact {
    id: String,
    address: Option<String>,
    blocked: bool,
}

mod events;
mod files;
mod helpers;
mod messaging;
mod reconnect;

pub use helpers::normalize_connect_address;
use helpers::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_normalize_like_v1() {
        assert_eq!(
            normalize_connect_address(" 192.168.1.20:5000/ ").unwrap(),
            "192.168.1.20:5000"
        );
        assert_eq!(
            normalize_connect_address("tcp://192.168.1.20:5000").unwrap(),
            "192.168.1.20:5000"
        );
        assert_eq!(
            normalize_connect_address("ws://10.0.0.5:8080/bt/ws").unwrap(),
            "10.0.0.5:8080"
        );
        assert_eq!(
            normalize_connect_address("192.168.1.20").unwrap(),
            format!("192.168.1.20:{DEFAULT_LISTEN_PORT}")
        );
        assert_eq!(
            normalize_connect_address("my-host.local:9000").unwrap(),
            "my-host.local:9000"
        );
        // Whitespace is stripped like in v1 before validation.
        assert_eq!(
            normalize_connect_address("my host.local:9000").unwrap(),
            "myhost.local:9000"
        );
        assert!(normalize_connect_address("").is_err());
        assert!(normalize_connect_address("host_with_underscore!:1").is_err());
    }

    #[test]
    fn file_ids_and_base64_are_validated() {
        assert!(is_valid_file_id("0123456789abcdef01234567"));
        assert!(!is_valid_file_id("0123456789ABCDEF0123456")); // 23 chars
        assert!(!is_valid_file_id("xx23456789abcdef012345zz"));
        assert!(is_strict_base64("aGVsbG8="));
        assert!(!is_strict_base64("aGVsbG8"));
        assert!(!is_strict_base64("aGV$bG8="));
    }

    #[test]
    fn content_types_and_names_are_sanitized() {
        assert_eq!(sanitize_content_type("image/png"), "image/png");
        assert_eq!(
            sanitize_content_type("weird stuff"),
            "application/octet-stream"
        );
        assert_eq!(sanitize_download_name("a/b\\c\r\n.txt"), "abc.txt");
        assert_eq!(sanitize_download_name(""), "download.bin");
    }
}
