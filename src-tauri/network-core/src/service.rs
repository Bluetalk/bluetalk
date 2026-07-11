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

async fn accept_loop(
    inner: Arc<Inner>,
    listener: TcpListener,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            _ = shutdown.changed() => break,
            accepted = listener.accept() => accepted,
        };
        let (stream, remote) = match accepted {
            Ok(value) => value,
            Err(error) => {
                log::warn!("peer listener accept failed: {error}");
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
        };
        let Ok(permit) = inner.handshake_permits.clone().try_acquire_owned() else {
            drop(stream);
            continue;
        };
        let inner = inner.clone();
        tokio::spawn(async move {
            let _permit = permit;
            stream.set_nodelay(true).ok();
            let mut stream = stream;
            let session = match timeout(
                inner.config.timeouts.handshake,
                protocol::responder_handshake(
                    &mut stream,
                    &inner.identity,
                    &inner.config.display_name,
                    inner.config.limits.max_frame_bytes,
                ),
            )
            .await
            {
                Ok(Ok(session)) => session,
                Ok(Err(error)) => {
                    log::debug!("inbound handshake from {remote} rejected: {error}");
                    return;
                }
                Err(_) => {
                    log::debug!("inbound handshake from {remote} timed out");
                    return;
                }
            };
            if let Err(error) = spawn_session(
                inner,
                stream,
                session,
                remote.to_string(),
                ConnectionDirection::Inbound,
            ) {
                log::debug!("inbound session from {remote} not registered: {error}");
            }
        });
    }
}

/// Registers the peer (applying the duplicate-connection tie-break) and spawns
/// the reader/writer tasks that own the connection.
fn spawn_session(
    inner: Arc<Inner>,
    stream: TcpStream,
    session: EstablishedSession,
    remote_address: String,
    direction: ConnectionDirection,
) -> Result<PeerInfo> {
    let own_peer_id = inner.identity.peer_id();
    if session.remote_peer_id == own_peer_id {
        return Err(NetworkError::Handshake(
            "refusing to connect to self".to_owned(),
        ));
    }

    let info = PeerInfo {
        peer_id: session.remote_peer_id.clone(),
        display_name: session.remote_display_name.clone(),
        remote_address,
        connected_at_ms: protocol::unix_time_ms(),
        direction,
        protocol_version: PROTOCOL_VERSION,
        authenticated_encryption: true,
    };

    let (sender, receiver) = mpsc::channel::<Vec<u8>>(inner.config.limits.outbound_queue_frames);
    let (close_tx, close_rx) = watch::channel(false);
    let handle = PeerHandle {
        info: info.clone(),
        connection_id: session.connection_id.clone(),
        sender,
        queued_bytes: Arc::new(AtomicUsize::new(0)),
        close: close_tx,
    };

    {
        let mut state = inner.state.lock().expect("network state lock");
        if !state.started {
            return Err(NetworkError::NotStarted);
        }
        if let Some(existing) = state.peers.get(&info.peer_id) {
            // Both sides resolve simultaneous dials identically: the side with
            // the lexicographically smaller peer id keeps its outbound leg.
            let preferred = if own_peer_id < info.peer_id {
                ConnectionDirection::Outbound
            } else {
                ConnectionDirection::Inbound
            };
            if direction == preferred {
                existing.request_close();
            } else {
                return Err(NetworkError::DuplicatePeer(info.peer_id.clone()));
            }
        }
        state.peers.insert(info.peer_id.clone(), handle.clone());
    }

    inner.sink.emit(NetworkEvent::PeerConnected(info.clone()));

    let queued_bytes = handle.queued_bytes.clone();
    let connection_id = session.connection_id.clone();
    let peer_id = info.peer_id.clone();
    tokio::spawn(run_session(
        inner,
        stream,
        session,
        peer_id,
        connection_id,
        receiver,
        queued_bytes,
        close_rx,
    ));

    Ok(info)
}

#[allow(clippy::too_many_arguments)]
async fn run_session(
    inner: Arc<Inner>,
    stream: TcpStream,
    session: EstablishedSession,
    peer_id: String,
    connection_id: String,
    mut outbound: mpsc::Receiver<Vec<u8>>,
    queued_bytes: Arc<AtomicUsize>,
    mut close: watch::Receiver<bool>,
) {
    let EstablishedSession {
        mut send_cipher,
        mut receive_cipher,
        ..
    } = session;
    let (mut read_half, mut write_half) = stream.into_split();
    let limits_max_frame = inner.config.limits.max_frame_bytes;
    let timeouts = inner.config.timeouts.clone();
    let sink = inner.sink.clone();

    let writer_peer_id = peer_id.clone();
    let mut writer_close = close.clone();
    let writer = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(timeouts.heartbeat);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        heartbeat.tick().await; // the first tick fires immediately
        let reason: &str = loop {
            tokio::select! {
                _ = writer_close.changed() => break "closed locally",
                maybe_frame = outbound.recv() => {
                    let Some(encoded) = maybe_frame else { break "sender dropped" };
                    queued_bytes.fetch_sub(encoded.len(), Ordering::AcqRel);
                    let write = protocol::write_encrypted(&mut write_half, &mut send_cipher, &encoded);
                    match timeout(timeouts.write, write).await {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            log::debug!("write to {writer_peer_id} failed: {error}");
                            break "write failed";
                        }
                        Err(_) => break "write timed out",
                    }
                }
                _ = heartbeat.tick() => {
                    let nonce = crate::identity::random_hex(8).unwrap_or_else(|_| "0".repeat(16));
                    let frame = WireFrame::Ping { nonce };
                    let Ok(encoded) = protocol::encode_wire_frame(&frame, limits_max_frame) else {
                        continue;
                    };
                    match timeout(timeouts.write, protocol::write_encrypted(&mut write_half, &mut send_cipher, &encoded)).await {
                        Ok(Ok(())) => {}
                        _ => break "heartbeat write failed",
                    }
                }
            }
        };
        // Best-effort close notification for the remote side.
        if let Ok(encoded) = protocol::encode_wire_frame(
            &WireFrame::Close {
                reason: reason.to_owned(),
            },
            limits_max_frame,
        ) {
            let _ = timeout(
                Duration::from_secs(1),
                protocol::write_encrypted(&mut write_half, &mut send_cipher, &encoded),
            )
            .await;
        }
    });

    // Reader loop: enforces the idle timeout and surfaces messages.
    let disconnect_reason;
    loop {
        let read = protocol::read_encrypted(&mut read_half, &mut receive_cipher);
        let frame_bytes = tokio::select! {
            _ = close.changed() => {
                disconnect_reason = "closed locally".to_owned();
                break;
            }
            read = timeout(timeouts.idle, read) => match read {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(NetworkError::Closed)) => {
                    disconnect_reason = "connection closed".to_owned();
                    break;
                }
                Ok(Err(error)) => {
                    disconnect_reason = error.to_string();
                    break;
                }
                Err(_) => {
                    disconnect_reason = "idle timeout".to_owned();
                    break;
                }
            },
        };
        match protocol::decode_wire_frame(&frame_bytes, limits_max_frame) {
            Ok(WireFrame::Message {
                message_id,
                sent_at_ms,
                payload,
            }) => {
                sink.emit(NetworkEvent::Message {
                    from_peer_id: peer_id.clone(),
                    message_id,
                    sent_at_ms,
                    payload,
                });
            }
            Ok(WireFrame::Ping { nonce }) => {
                if let Ok(encoded) =
                    protocol::encode_wire_frame(&WireFrame::Pong { nonce }, limits_max_frame)
                {
                    // Routed through the queue so the writer owns the cipher.
                    let handle = {
                        let state = inner.state.lock().expect("network state lock");
                        state.peers.get(&peer_id).cloned()
                    };
                    if let Some(handle) = handle {
                        if handle.connection_id == connection_id {
                            handle.queued_bytes.fetch_add(encoded.len(), Ordering::AcqRel);
                            if handle.sender.try_send(encoded).is_err() {
                                // Queue full: the heartbeat keeps the link alive.
                            }
                        }
                    }
                }
            }
            Ok(WireFrame::Pong { .. }) => {}
            Ok(WireFrame::Close { reason }) => {
                disconnect_reason = if reason.is_empty() {
                    "closed by peer".to_owned()
                } else {
                    reason
                };
                break;
            }
            Err(error) => {
                disconnect_reason = error.to_string();
                break;
            }
        }
    }

    writer.abort();
    let _ = writer.await;

    let removed = {
        let mut state = inner.state.lock().expect("network state lock");
        match state.peers.get(&peer_id) {
            Some(existing) if existing.connection_id == connection_id => {
                state.peers.remove(&peer_id);
                true
            }
            _ => false,
        }
    };
    if removed {
        sink.emit(NetworkEvent::PeerDisconnected {
            peer_id,
            reason: disconnect_reason,
        });
    }
}

async fn discovery_loop(
    inner: Arc<Inner>,
    socket: Arc<UdpSocket>,
    listen_port: u16,
    mut shutdown: watch::Receiver<bool>,
) {
    let Some(discovery_config) = inner.config.discovery.clone() else {
        return;
    };
    let mut announce = tokio::time::interval(ANNOUNCE_INTERVAL);
    announce.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut packet = vec![0_u8; discovery_config.max_packet_bytes];
    let own_peer_id = inner.identity.peer_id();

    loop {
        tokio::select! {
            _ = shutdown.changed() => break,
            _ = announce.tick() => {
                announce_once(&inner, &socket, listen_port).await;
            }
            received = socket.recv_from(&mut packet) => {
                let Ok((length, from)) = received else { continue };
                let verified = match discovery::verify_announcement(
                    &packet[..length],
                    from,
                    discovery_config.max_packet_bytes,
                    discovery_config.max_clock_skew,
                ) {
                    Ok(verified) => verified,
                    Err(_) => continue,
                };
                if verified.peer.peer_id == own_peer_id {
                    continue;
                }
                let fresh = {
                    let mut cache = inner.replay_cache.lock().expect("replay cache lock");
                    cache.record_if_fresh(verified.replay_key.clone(), Instant::now())
                };
                if !fresh {
                    continue;
                }
                let peer = verified.peer;
                {
                    let mut state = inner.state.lock().expect("network state lock");
                    if state.discovered.len() >= MAX_DISCOVERED_PEERS
                        && !state.discovered.contains_key(&peer.peer_id)
                    {
                        let oldest = state
                            .discovered
                            .iter()
                            .min_by_key(|(_, (_, seen))| *seen)
                            .map(|(key, _)| key.clone());
                        if let Some(oldest) = oldest {
                            state.discovered.remove(&oldest);
                        }
                    }
                    state
                        .discovered
                        .insert(peer.peer_id.clone(), (peer.clone(), Instant::now()));
                }
                inner.sink.emit(NetworkEvent::PeerDiscovered(peer));
            }
        }
    }
}

async fn announce_once(inner: &Arc<Inner>, socket: &UdpSocket, listen_port: u16) {
    let Some(discovery_config) = inner.config.discovery.as_ref() else {
        return;
    };
    // The unspecified host is replaced by the observed source IP on receive.
    let endpoints = vec![format!("tcp://0.0.0.0:{listen_port}")];
    let packet = match discovery::create_announcement(
        &inner.identity,
        &inner.config.display_name,
        &endpoints,
    ) {
        Ok(packet) => packet,
        Err(error) => {
            log::warn!("failed to create discovery announcement: {error}");
            return;
        }
    };
    for target in &discovery_config.targets {
        if let Err(error) = socket.send_to(&packet, target).await {
            log::debug!("discovery announcement to {target} failed: {error}");
        }
    }
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
