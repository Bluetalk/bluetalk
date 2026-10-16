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
    io::{AsyncRead, AsyncWrite},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{Semaphore, mpsc, watch},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    ConnectionDirection, DeliveryResult, DiscoveredPeer, NetworkConfig, NetworkError,
    NetworkEvent, NetworkEventSink, NetworkIdentity, NetworkInfo, PeerDevice, PeerInfo, Result,
    discovery::{self, ReplayCache},
    protocol::{
        self, EstablishedSession, PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, WireFrame,
    },
};

/// LAN/Direktverbindung: eine Sitzung pro Peer.
pub const DIRECT_DEVICE_KEY: &str = "direct";
/// Relay ohne device-Feld (Clients ≤ 2.3.x).
pub const LEGACY_DEVICE_KEY: &str = "legacy";

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
    peers: HashMap<(String, String), PeerHandle>,
    discovered: HashMap<String, (DiscoveredPeer, Instant)>,
    announce_socket: Option<Arc<UdpSocket>>,
    tasks: Vec<JoinHandle<()>>,
}

#[derive(Clone)]
struct PeerHandle {
    info: PeerInfo,
    device_key: String,
    device_name: String,
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
                if let Some(existing) =
                    find_session(&state, expected, DIRECT_DEVICE_KEY)
                {
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

        self.connect_stream(
            stream,
            remote_address,
            expected_peer_id,
            DIRECT_DEVICE_KEY,
            "",
        )
        .await
    }

    /// Initiator-Handshake über einen beliebigen bidirektionalen Stream
    /// (TCP, Relay-Tunnel, Test-Duplex). Gleiche Timeouts wie der TCP-Pfad.
    /// `device_key` = `"direct"` (LAN) oder Remote-deviceId (Relay).
    pub async fn connect_stream<S>(
        &self,
        mut stream: S,
        remote_address: String,
        expected_peer_id: Option<&str>,
        device_key: &str,
        device_name: &str,
    ) -> Result<PeerInfo>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        let device_key = normalize_device_key(device_key);
        {
            let state = self.inner.state.lock().expect("network state lock");
            if !state.started {
                return Err(NetworkError::NotStarted);
            }
            if let Some(expected) = expected_peer_id {
                if let Some(existing) = find_session(&state, expected, &device_key) {
                    return Ok(existing.info.clone());
                }
            }
        }

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
            device_key,
            device_name.trim().chars().take(64).collect(),
        )
    }

    /// Responder-Handshake über einen beliebigen Stream. Nutzt dieselben
    /// Handshake-Permits wie die Accept-Schleife.
    pub async fn accept_stream<S>(
        &self,
        stream: S,
        remote_address: String,
        device_key: &str,
        device_name: &str,
    ) -> Result<PeerInfo>
    where
        S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
    {
        {
            let state = self.inner.state.lock().expect("network state lock");
            if !state.started {
                return Err(NetworkError::NotStarted);
            }
        }
        let permit = self
            .inner
            .handshake_permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                NetworkError::Handshake("too many pending inbound handshakes".to_owned())
            })?;
        let result = complete_inbound_session(
            self.inner.clone(),
            stream,
            remote_address,
            normalize_device_key(device_key),
            device_name.trim().chars().take(64).collect(),
        )
        .await;
        drop(permit);
        result
    }

    pub fn disconnect(&self, peer_id: &str) -> Result<()> {
        let handles = {
            let state = self.inner.state.lock().expect("network state lock");
            sessions_for_peer(&state, peer_id)
        };
        if handles.is_empty() {
            return Err(NetworkError::PeerNotFound(peer_id.to_owned()));
        }
        for handle in handles {
            handle.request_close();
        }
        Ok(())
    }

    /// Sendet an alle Sitzungen des Peers. Erfolg, wenn mindestens eine
    /// Sitzung die Nachricht angenommen hat.
    pub fn send(&self, peer_id: &str, payload: serde_json::Value) -> Result<()> {
        let frame = WireFrame::Message {
            message_id: crate::identity::random_hex(12)?,
            sent_at_ms: protocol::unix_time_ms(),
            payload,
        };
        let encoded = protocol::encode_wire_frame(&frame, self.inner.config.limits.max_frame_bytes)?;
        let handles = {
            let state = self.inner.state.lock().expect("network state lock");
            sessions_for_peer(&state, peer_id)
        };
        if handles.is_empty() {
            return Err(NetworkError::PeerNotFound(peer_id.to_owned()));
        }
        let mut last_error = None;
        let mut accepted = false;
        for handle in handles {
            match self.send_encoded_to(&handle, encoded.clone()) {
                Ok(()) => accepted = true,
                Err(error) => last_error = Some(error),
            }
        }
        if accepted {
            Ok(())
        } else {
            Err(last_error.unwrap_or_else(|| NetworkError::PeerNotFound(peer_id.to_owned())))
        }
    }

    /// Sendet nur an die Sitzung `(peer_id, device_key)`.
    pub fn send_to(
        &self,
        peer_id: &str,
        device_key: &str,
        payload: serde_json::Value,
    ) -> Result<()> {
        let frame = WireFrame::Message {
            message_id: crate::identity::random_hex(12)?,
            sent_at_ms: protocol::unix_time_ms(),
            payload,
        };
        let encoded = protocol::encode_wire_frame(&frame, self.inner.config.limits.max_frame_bytes)?;
        let handle = {
            let state = self.inner.state.lock().expect("network state lock");
            find_session(&state, peer_id, &normalize_device_key(device_key))
                .cloned()
                .ok_or_else(|| NetworkError::PeerNotFound(peer_id.to_owned()))?
        };
        self.send_encoded_to(&handle, encoded)
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
            let mut ids: Vec<String> = state
                .peers
                .keys()
                .map(|(peer_id, _)| peer_id.clone())
                .collect();
            ids.sort();
            ids.dedup();
            ids
        };
        self.send_many(&peer_ids, payload)
    }

    pub fn peers(&self) -> Vec<PeerInfo> {
        let state = self.inner.state.lock().expect("network state lock");
        aggregated_peers(&state)
    }

    pub fn has_peer(&self, peer_id: &str) -> bool {
        let state = self.inner.state.lock().expect("network state lock");
        state.peers.keys().any(|(id, _)| id == peer_id)
    }

    pub fn has_direct(&self, peer_id: &str) -> bool {
        let state = self.inner.state.lock().expect("network state lock");
        find_session(&state, peer_id, DIRECT_DEVICE_KEY).is_some()
    }

    pub fn has_session(&self, peer_id: &str, device_key: &str) -> bool {
        let state = self.inner.state.lock().expect("network state lock");
        find_session(&state, peer_id, &normalize_device_key(device_key)).is_some()
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
            connected_peer_count: unique_peer_count(&state),
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

    fn send_encoded_to(&self, handle: &PeerHandle, encoded: Vec<u8>) -> Result<()> {
        let peer_id = &handle.info.peer_id;
        let byte_budget = self.inner.config.limits.outbound_queue_bytes;
        let queued = handle.queued_bytes.fetch_add(encoded.len(), Ordering::AcqRel);
        if queued + encoded.len() > byte_budget {
            handle.queued_bytes.fetch_sub(encoded.len(), Ordering::AcqRel);
            return Err(NetworkError::Backpressure(peer_id.clone()));
        }
        let encoded_len = encoded.len();
        match handle.sender.try_send(encoded) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                handle.queued_bytes.fetch_sub(encoded_len, Ordering::AcqRel);
                Err(NetworkError::Backpressure(peer_id.clone()))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                handle.queued_bytes.fetch_sub(encoded_len, Ordering::AcqRel);
                Err(NetworkError::PeerNotFound(peer_id.clone()))
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

fn normalize_device_key(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        DIRECT_DEVICE_KEY.to_owned()
    } else {
        trimmed.chars().take(64).collect()
    }
}

fn find_session<'a>(
    state: &'a ServiceState,
    peer_id: &str,
    device_key: &str,
) -> Option<&'a PeerHandle> {
    state.peers.get(&(peer_id.to_owned(), device_key.to_owned()))
}

fn sessions_for_peer(state: &ServiceState, peer_id: &str) -> Vec<PeerHandle> {
    state
        .peers
        .iter()
        .filter(|((id, _), _)| id == peer_id)
        .map(|(_, handle)| handle.clone())
        .collect()
}

fn unique_peer_count(state: &ServiceState) -> usize {
    let mut ids: Vec<&str> = state.peers.keys().map(|(id, _)| id.as_str()).collect();
    ids.sort_unstable();
    ids.dedup();
    ids.len()
}

fn devices_of_peer(state: &ServiceState, peer_id: &str) -> Vec<PeerDevice> {
    let mut devices: Vec<PeerDevice> = state
        .peers
        .iter()
        .filter(|((id, _), _)| id == peer_id)
        .map(|((_, device_key), handle)| peer_device_of(device_key, handle))
        .collect();
    devices.sort_by(|a, b| a.id.cmp(&b.id));
    devices
}

fn peer_device_of(device_key: &str, handle: &PeerHandle) -> PeerDevice {
    PeerDevice {
        id: device_key.to_owned(),
        name: handle.device_name.clone(),
        transport: if device_key == DIRECT_DEVICE_KEY {
            "direct".to_owned()
        } else {
            "relay".to_owned()
        },
    }
}

fn aggregated_peers(state: &ServiceState) -> Vec<PeerInfo> {
    let mut groups: HashMap<String, Vec<&PeerHandle>> = HashMap::new();
    for ((peer_id, _), handle) in &state.peers {
        groups.entry(peer_id.clone()).or_default().push(handle);
    }
    let mut peers: Vec<PeerInfo> = groups
        .into_values()
        .map(|handles| {
            let primary = handles
                .iter()
                .min_by_key(|handle| {
                    let direct = if handle.device_key == DIRECT_DEVICE_KEY {
                        0_u8
                    } else {
                        1
                    };
                    (direct, handle.info.connected_at_ms)
                })
                .copied()
                .expect("group is non-empty");
            let mut info = primary.info.clone();
            let mut devices: Vec<PeerDevice> = handles
                .iter()
                .map(|handle| peer_device_of(&handle.device_key, handle))
                .collect();
            devices.sort_by(|a, b| a.id.cmp(&b.id));
            info.devices = devices;
            info
        })
        .collect();
    peers.sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
    peers
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

async fn complete_inbound_session<S>(
    inner: Arc<Inner>,
    mut stream: S,
    remote_address: String,
    device_key: String,
    device_name: String,
) -> Result<PeerInfo>
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let session = timeout(
        inner.config.timeouts.handshake,
        protocol::responder_handshake(
            &mut stream,
            &inner.identity,
            &inner.config.display_name,
            inner.config.limits.max_frame_bytes,
        ),
    )
    .await
    .map_err(|_| NetworkError::Timeout("handshake"))??;
    spawn_session(
        inner,
        stream,
        session,
        remote_address,
        ConnectionDirection::Inbound,
        device_key,
        device_name,
    )
}

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
    async fn stream_connect_and_accept_exchange_a_message() {
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
        network_b.start().await.unwrap();
        let (client, server) = tokio::io::duplex(256 * 1024);
        let expected_b = network_b.peer_id();

        let (initiated, accepted) = tokio::join!(
            network_a.connect_stream(
                client,
                "relay://test".to_owned(),
                Some(&expected_b),
                "dev-a",
                "",
            ),
            network_b.accept_stream(server, "relay://test".to_owned(), "dev-a", ""),
        );
        let peer = initiated.expect("initiator stream handshake");
        accepted.expect("responder stream handshake");
        assert_eq!(peer.peer_id, expected_b);
        assert_eq!(peer.remote_address, "relay://test");

        network_a
            .send(&peer.peer_id, serde_json::json!({"kind": "chat", "text": "via-stream"}))
            .unwrap();
        let received = sink_b
            .wait_for(|event| matches!(event, NetworkEvent::Message { .. }))
            .await;
        match received {
            NetworkEvent::Message {
                payload,
                from_peer_id,
                ..
            } => {
                assert_eq!(payload["text"], "via-stream");
                assert_eq!(from_peer_id, network_a.peer_id());
            }
            _ => unreachable!(),
        }

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

    #[tokio::test]
    async fn two_devices_fan_out_and_send_to() {
        let sink_b = CollectingSink::new();
        let network_a = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(crate::NoopEventSink),
        )
        .unwrap();
        let network_b = PeerNetwork::new(
            NetworkIdentity::generate().unwrap(),
            test_config(),
            Arc::new(sink_b.clone()),
        )
        .unwrap();
        network_a.start().await.unwrap();
        network_b.start().await.unwrap();

        let (client1, server1) = tokio::io::duplex(256 * 1024);
        let (client2, server2) = tokio::io::duplex(256 * 1024);
        let expected_b = network_b.peer_id();

        let (first, _) = tokio::join!(
            network_a.connect_stream(client1, "relay://d1".to_owned(), Some(&expected_b), "d1", "Eins"),
            network_b.accept_stream(server1, "relay://d1".to_owned(), "d1", "Eins"),
        );
        first.expect("first device");

        let connected_events = {
            let events = sink_b.events.lock().unwrap();
            events
                .iter()
                .filter(|event| matches!(event, NetworkEvent::PeerConnected(_)))
                .count()
        };
        assert_eq!(connected_events, 1);

        let (second, _) = tokio::join!(
            network_a.connect_stream(client2, "relay://d2".to_owned(), Some(&expected_b), "d2", "Zwei"),
            network_b.accept_stream(server2, "relay://d2".to_owned(), "d2", "Zwei"),
        );
        second.expect("second device");

        let connected_events = {
            let events = sink_b.events.lock().unwrap();
            events
                .iter()
                .filter(|event| matches!(event, NetworkEvent::PeerConnected(_)))
                .count()
        };
        assert_eq!(connected_events, 1);
        sink_b
            .wait_for(|event| matches!(event, NetworkEvent::PeerDevices { devices, .. } if devices.len() == 2))
            .await;

        assert_eq!(network_a.peers().len(), 1);
        assert_eq!(network_a.peers()[0].devices.len(), 2);
        assert_eq!(network_a.info().connected_peer_count, 1);

        network_a
            .send(&expected_b, serde_json::json!({"kind": "chat", "text": "all"}))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        let fanout = {
            let events = sink_b.events.lock().unwrap();
            events
                .iter()
                .filter(|event| matches!(event, NetworkEvent::Message { payload, .. } if payload["text"] == "all"))
                .count()
        };
        assert_eq!(fanout, 2);

        network_a
            .send_to(
                &expected_b,
                "d1",
                serde_json::json!({"kind": "chat", "text": "only-d1"}),
            )
            .unwrap();
        sink_b
            .wait_for(|event| {
                matches!(
                    event,
                    NetworkEvent::Message {
                        from_device,
                        payload,
                        ..
                    } if from_device == "d1" && payload["text"] == "only-d1"
                )
            })
            .await;

        network_a.stop().await;
        network_b.stop().await;
    }

    #[tokio::test]
    async fn last_session_emits_peer_disconnected() {
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
        network_b.start().await.unwrap();
        let (client, server) = tokio::io::duplex(256 * 1024);
        let expected_b = network_b.peer_id();
        let (initiated, accepted) = tokio::join!(
            network_a.connect_stream(client, "relay://x".to_owned(), Some(&expected_b), "x", ""),
            network_b.accept_stream(server, "relay://x".to_owned(), "x", ""),
        );
        initiated.unwrap();
        accepted.unwrap();
        network_a.disconnect(&expected_b).unwrap();
        sink_a
            .wait_for(|event| matches!(event, NetworkEvent::PeerDisconnected { .. }))
            .await;
        sink_b
            .wait_for(|event| matches!(event, NetworkEvent::PeerDisconnected { .. }))
            .await;
        network_a.stop().await;
        network_b.stop().await;
    }
}
