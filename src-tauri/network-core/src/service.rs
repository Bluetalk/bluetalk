//! Async peer-network service: TCP listener, outbound connections, encrypted
//! sessions, heartbeats, bounded send queues, and signed UDP discovery.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use tokio::{
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    ConnectionDirection, DeliveryResult, DiscoveredPeer, NetworkConfig, NetworkError,
    NetworkEvent, NetworkEventSink, NetworkIdentity, NetworkInfo, PeerInfo, Result,
    discovery::{self, ReplayCache},
    protocol::{
        self, EstablishedSession, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, WireFrame,
    },
};

const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(5);
const DISCOVERED_PEER_TTL: Duration = Duration::from_secs(600);
const MAX_DISCOVERED_PEERS: usize = 512;
const MAX_CONNECT_ADDRESS_BYTES: usize = 512;

/// Encrypted peer-to-peer networking service.
///
/// All methods are safe to call concurrently. Events are delivered through the
/// [`NetworkEventSink`] passed at construction; sinks must return quickly.
pub struct PeerNetwork {
    inner: Arc<Inner>,
}

struct Inner {
    identity: NetworkIdentity,
    config: NetworkConfig,
    sink: Arc<dyn NetworkEventSink>,
    state: Mutex<ServiceState>,
    handshake_permits: Arc<Semaphore>,
    replay_cache: Mutex<ReplayCache>,
}

#[derive(Default)]
struct ServiceState {
    started: bool,
    listen_addrs: Vec<SocketAddr>,
    shutdown: Option<watch::Sender<bool>>,
    peers: HashMap<String, PeerHandle>,
    discovered: HashMap<String, (DiscoveredPeer, Instant)>,
    announce_socket: Option<Arc<UdpSocket>>,
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
struct PeerHandle {
    info: PeerInfo,
    connection_id: String,
    sender: mpsc::Sender<Vec<u8>>,
    queued_bytes: Arc<AtomicUsize>,
    close: watch::Sender<bool>,
}

impl PeerHandle {
    fn request_close(&self) {
        let _ = self.close.send(true);
    }
}

impl PeerNetwork {
    pub fn new(
        identity: NetworkIdentity,
        config: NetworkConfig,
        sink: Arc<dyn NetworkEventSink>,
    ) -> Result<Self> {
        config.validate()?;
        let replay_window = config
            .discovery
            .as_ref()
            .map(|discovery| (discovery.replay_window, discovery.replay_cache_entries))
            .unwrap_or((Duration::from_secs(180), 1024));
        Ok(Self {
            inner: Arc::new(Inner {
                handshake_permits: Arc::new(Semaphore::new(config.limits.max_pending_handshakes)),
                replay_cache: Mutex::new(ReplayCache::new(replay_window.0, replay_window.1)),
                identity,
                config,
                sink,
            state: Mutex::new(ServiceState::default()),
            }),
        })
    }

    pub fn peer_id(&self) -> String {
        self.inner.identity.peer_id()
    }

    /// Binds the TCP listener and, when configured, the discovery socket.
    pub async fn start(&self) -> Result<NetworkInfo> {
        {
            let state = self.inner.state.lock().expect("network state lock");
            if state.started {
                return Err(NetworkError::AlreadyStarted);
            }
        }

        let listener = TcpListener::bind(self.inner.config.listen_addr).await?;
        let local_addr = listener.local_addr()?;
        let (shutdown_tx, shutdown_rx) = watch::channel(false);

        let mut tasks = Vec::new();
        tasks.push(tokio::spawn(accept_loop(
            self.inner.clone(),
            listener,
            shutdown_rx.clone(),
        )));

        let mut announce_socket = None;
        if let Some(discovery_config) = self.inner.config.discovery.clone() {
            match UdpSocket::bind(discovery_config.bind_addr).await {
                Ok(socket) => {
                    let _ = socket.set_broadcast(true);
                    let socket = Arc::new(socket);
                    announce_socket = Some(socket.clone());
                    tasks.push(tokio::spawn(discovery_loop(
                        self.inner.clone(),
                        socket,
                        local_addr.port(),
                        shutdown_rx.clone(),
                    )));
                }
                Err(error) => {
                    self.inner.sink.emit(NetworkEvent::Warning {
                        code: "discovery_bind_failed".to_owned(),
                        message: format!(
                            "UDP discovery unavailable on {}: {error}",
                            discovery_config.bind_addr
                        ),
                    });
                }
            }
        }

        let mut state = self.inner.state.lock().expect("network state lock");
        state.started = true;
        state.listen_addrs = vec![local_addr];
        state.shutdown = Some(shutdown_tx);
        state.announce_socket = announce_socket;
        state.tasks = tasks;
        drop(state);

        Ok(self.info())
    }

    /// Stops all tasks and disconnects every peer.
    pub async fn stop(&self) {
        let (shutdown, peers, tasks) = {
            let mut state = self.inner.state.lock().expect("network state lock");
            if !state.started {
                return;
            }
            state.started = false;
            state.listen_addrs.clear();
            state.announce_socket = None;
            (
                state.shutdown.take(),
                std::mem::take(&mut state.peers),
                std::mem::take(&mut state.tasks),
            )
        };
        if let Some(shutdown) = shutdown {
            let _ = shutdown.send(true);
        }
        for (_, handle) in peers {
            handle.request_close();
        }
        for task in tasks {
            let _ = timeout(Duration::from_secs(2), task).await;
        }
    }

    /// Connects to `host:port` (a `tcp://` prefix is accepted) and performs the
    /// authenticated handshake. Returns the existing session when the peer is
    /// already connected.
    pub async fn connect(
        &self,
        address: &str,
        expected_peer_id: Option<&str>,
    ) -> Result<PeerInfo> {
        let target = parse_connect_address(address)?;
        {
            let state = self.inner.state.lock().expect("network state lock");
            if !state.started {
                return Err(NetworkError::NotStarted);
            }
            if let Some(expected) = expected_peer_id {
                if let Some(existing) = state.peers.get(expected) {
                    return Ok(existing.info.clone());
                }
            }
        }

        let stream = timeout(
            self.inner.config.timeouts.connect,
            TcpStream::connect(target),
        )
        .await
        .map_err(|_| NetworkError::Timeout("connect"))??;
        stream.set_nodelay(true).ok();
        let remote_address = stream
            .peer_addr()
            .map(|addr| addr.to_string())
            .unwrap_or_else(|_| target.to_string());

        let mut stream = stream;
        let session = timeout(
            self.inner.config.timeouts.handshake,
            protocol::initiator_handshake(
                &mut stream,
                &self.inner.identity,
                &self.inner.config.display_name,
                expected_peer_id,
                self.inner.config.limits.max_frame_bytes,
            ),
        )
        .await
        .map_err(|_| NetworkError::Timeout("handshake"))??;

        spawn_session(
            self.inner.clone(),
            stream,
            session,
            remote_address,
            ConnectionDirection::Outbound,
        )
    }

    pub fn disconnect(&self, peer_id: &str) -> Result<()> {
        let handle = {
            let state = self.inner.state.lock().expect("network state lock");
            state
                .peers
                .get(peer_id)
                .cloned()
                .ok_or_else(|| NetworkError::PeerNotFound(peer_id.to_owned()))?
        };
        handle.request_close();
        Ok(())
    }

    /// Queues an application payload for one peer. Fails fast on backpressure.
    pub fn send(&self, peer_id: &str, payload: serde_json::Value) -> Result<()> {
        let frame = WireFrame::Message {
            message_id: crate::identity::random_hex(12)?,
            sent_at_ms: protocol::unix_time_ms(),
            payload,
        };
        let encoded = protocol::encode_wire_frame(&frame, self.inner.config.limits.max_frame_bytes)?;
        self.send_encoded(peer_id, encoded)
    }

    pub fn send_many(&self, peer_ids: &[String], payload: serde_json::Value) -> Vec<DeliveryResult> {
        peer_ids
            .iter()
            .map(|peer_id| {
                let outcome = self.send(peer_id, payload.clone());
                DeliveryResult {
                    peer_id: peer_id.clone(),
                    accepted: outcome.is_ok(),
                    error: outcome.err().map(|error| error.to_string()),
                }
            })
            .collect()
    }

    pub fn broadcast(&self, payload: serde_json::Value) -> Vec<DeliveryResult> {
        let peer_ids: Vec<String> = {
            let state = self.inner.state.lock().expect("network state lock");
            state.peers.keys().cloned().collect()
        };
        self.send_many(&peer_ids, payload)
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        let state = self.inner.state.lock().expect("network state lock");
        state.peers.values().map(|handle| handle.info.clone()).collect()
    }

    pub fn discovered_peers(&self) -> Vec<DiscoveredPeer> {
        let now = Instant::now();
        let mut state = self.inner.state.lock().expect("network state lock");
        state
            .discovered
            .retain(|_, (_, seen)| now.saturating_duration_since(*seen) < DISCOVERED_PEER_TTL);
        state
            .discovered
            .values()
            .map(|(peer, _)| peer.clone())
            .collect()
    }

    pub fn info(&self) -> NetworkInfo {
        let state = self.inner.state.lock().expect("network state lock");
        NetworkInfo {
            peer_id: self.inner.identity.peer_id(),
            display_name: self.inner.config.display_name.clone(),
            protocol_versions: SUPPORTED_PROTOCOL_VERSIONS.to_vec(),
            listen_addresses: state
                .listen_addrs
                .iter()
                .map(|addr| addr.to_string())
                .collect(),
            started: state.started,
            connected_peer_count: state.peers.len(),
            discovery_enabled: state.announce_socket.is_some(),
            max_frame_bytes: self.inner.config.limits.max_frame_bytes,
            outbound_queue_frames: self.inner.config.limits.outbound_queue_frames,
            outbound_queue_bytes: self.inner.config.limits.outbound_queue_bytes,
        }
    }

    /// Sends an immediate discovery announcement instead of waiting for the
    /// periodic timer.
    pub async fn refresh_discovery(&self) -> Result<()> {
        let (socket, port) = {
            let state = self.inner.state.lock().expect("network state lock");
            if !state.started {
                return Err(NetworkError::NotStarted);
            }
            let port = state
                .listen_addrs
                .first()
                .map(|addr| addr.port())
                .ok_or(NetworkError::NotStarted)?;
            match &state.announce_socket {
                Some(socket) => (socket.clone(), port),
                None => return Ok(()),
            }
        };
        announce_once(&self.inner, &socket, port).await;
        Ok(())
    }

    fn send_encoded(&self, peer_id: &str, encoded: Vec<u8>) -> Result<()> {
        let handle = {
            let state = self.inner.state.lock().expect("network state lock");
            state
                .peers
                .get(peer_id)
                .cloned()
                .ok_or_else(|| NetworkError::PeerNotFound(peer_id.to_owned()))?
        };
        let byte_budget = self.inner.config.limits.outbound_queue_bytes;
        let queued = handle.queued_bytes.fetch_add(encoded.len(), Ordering::AcqRel);
        if queued + encoded.len() > byte_budget {
            handle.queued_bytes.fetch_sub(encoded.len(), Ordering::AcqRel);
            return Err(NetworkError::Backpressure(peer_id.to_owned()));
        }
        let encoded_len = encoded.len();
        match handle.sender.try_send(encoded) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                handle.queued_bytes.fetch_sub(encoded_len, Ordering::AcqRel);
                Err(NetworkError::Backpressure(peer_id.to_owned()))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                handle.queued_bytes.fetch_sub(encoded_len, Ordering::AcqRel);
                Err(NetworkError::PeerNotFound(peer_id.to_owned()))
            }
        }
    }
}

impl Drop for PeerNetwork {
    fn drop(&mut self) {
        let mut state = self.inner.state.lock().expect("network state lock");
        if let Some(shutdown) = state.shutdown.take() {
            let _ = shutdown.send(true);
        }
        for (_, handle) in state.peers.drain() {
            handle.request_close();
        }
        for task in state.tasks.drain(..) {
            task.abort();
        }
    }
}

fn parse_connect_address(raw: &str) -> Result<SocketAddr> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_CONNECT_ADDRESS_BYTES {
        return Err(NetworkError::InvalidConfig(
            "connect address must contain 1..=512 bytes".to_owned(),
        ));
    }
    let without_scheme = trimmed
        .strip_prefix("tcp://")
        .unwrap_or(trimmed)
        .trim_end_matches('/');
    without_scheme.parse::<SocketAddr>().map_err(|_| {
        NetworkError::InvalidConfig(format!("invalid connect address: {without_scheme}"))
    })
}


mod loops;
mod session;

use loops::{accept_loop, announce_once, discovery_loop};
use session::spawn_session;

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    struct CollectingSink {
        events: StdMutex<Vec<NetworkEvent>>,
        notify: tokio::sync::Notify,
    }

    impl CollectingSink {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                events: StdMutex::new(Vec::new()),
                notify: tokio::sync::Notify::new(),
            })
        }

        async fn wait_for<F>(&self, predicate: F) -> NetworkEvent
        where
            F: Fn(&NetworkEvent) -> bool,
        {
            loop {
                {
                    let events = self.events.lock().unwrap();
                    if let Some(event) = events.iter().find(|event| predicate(event)) {
                        return event.clone();
                    }
                }
                timeout(Duration::from_secs(5), self.notify.notified())
                    .await
                    .expect("expected network event");
            }
        }
    }

    impl NetworkEventSink for Arc<CollectingSink> {
        fn emit(&self, event: NetworkEvent) {
            self.events.lock().unwrap().push(event);
            self.notify.notify_waiters();
        }
    }

    fn test_config() -> NetworkConfig {
        NetworkConfig {
            display_name: "test".to_owned(),
            listen_addr: "127.0.0.1:0".parse().unwrap(),
            discovery: None,
            limits: NetworkLimits::default(),
            timeouts: NetworkTimeouts::default(),
        }
    }

    use crate::config::{NetworkLimits, NetworkTimeouts};

    #[tokio::test]
    async fn peers_connect_exchange_messages_and_disconnect() {
        let sink_a = CollectingSink::new();
        let sink_b = CollectingSink::new();
        let network_a = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(sink_a.clone()),
        )
        .unwrap();
        let network_b = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(sink_b.clone()),
        )
        .unwrap();

        network_a.start().await.unwrap();
        let info_b = network_b.start().await.unwrap();
        let address = info_b.listen_addresses.first().unwrap().clone();

        let peer = network_a.connect(&address, None).await.unwrap();
        assert_eq!(peer.peer_id, network_b.peer_id());
        sink_b
            .wait_for(|event| matches!(event, NetworkEvent::PeerConnected(_)))
            .await;

        network_a
            .send(&peer.peer_id, serde_json::json!({"kind": "chat", "text": "hallo"}))
            .unwrap();
        let received = sink_b
            .wait_for(|event| matches!(event, NetworkEvent::Message { .. }))
            .await;
        match received {
            NetworkEvent::Message { payload, from_peer_id, .. } => {
                assert_eq!(payload["text"], "hallo");
                assert_eq!(from_peer_id, network_a.peer_id());
            }
            _ => unreachable!(),
        }

        network_a.disconnect(&peer.peer_id).unwrap();
        sink_a
            .wait_for(|event| matches!(event, NetworkEvent::PeerDisconnected { .. }))
            .await;
        sink_b
            .wait_for(|event| matches!(event, NetworkEvent::PeerDisconnected { .. }))
            .await;

        network_a.stop().await;
        network_b.stop().await;
    }

    #[tokio::test]
    async fn identity_pinning_rejects_unexpected_peer() {
        let network_a = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        let network_b = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        network_a.start().await.unwrap();
        let info_b = network_b.start().await.unwrap();
        let address = info_b.listen_addresses.first().unwrap().clone();

        let wrong_id = format!("bt2_{}", "0".repeat(64));
        let outcome = network_a.connect(&address, Some(&wrong_id)).await;
        assert!(matches!(
            outcome,
            Err(NetworkError::PeerIdentityMismatch { .. })
        ));

        network_a.stop().await;
        network_b.stop().await;
    }

    #[tokio::test]
    async fn send_to_unknown_peer_fails() {
        let network = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        network.start().await.unwrap();
        assert!(matches!(
            network.send("bt2_missing", serde_json::json!({})),
            Err(NetworkError::PeerNotFound(_))
        ));
        network.stop().await;
    }
}
