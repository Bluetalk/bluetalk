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

    // ------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------

    pub async fn get_info(&self) -> Value {
        let network = self.network.read().await.clone();
        let (peer_id, name, port, started) = match &network {
            Some(network) => {
                let info = network.info();
                let port = info
                    .listen_addresses
                    .first()
                    .and_then(|addr| addr.parse::<SocketAddr>().ok())
                    .map(|addr| addr.port())
                    .unwrap_or(0);
                (info.peer_id, info.display_name, port, info.started)
            }
            None => (String::new(), self.display_name(), 0, false),
        };
        let addresses: Vec<String> = local_ipv4_addresses()
            .into_iter()
            .map(|ip| ip.to_string())
            .collect();
        let endpoints: Vec<String> = addresses
            .iter()
            .map(|ip| format!("{ip}:{port}"))
            .collect();
        let peers = self.peers_snapshot().await;
        let hosted: Vec<Value> = self
            .hosted
            .lock()
            .iter()
            .map(hosted_file_summary)
            .collect();
        json!({
            "id": peer_id,
            "name": name,
            "port": port,
            "ports": if port == 0 { Vec::new() } else { vec![port] },
            "addresses": addresses,
            "endpoints": endpoints,
            "peers": peers,
            "hostedFiles": hosted,
            "started": started,
        })
    }

    pub async fn peers_snapshot(&self) -> Vec<Value> {
        match self.network.read().await.as_ref() {
            Some(network) => network.peers().iter().map(peer_info_to_value).collect(),
            None => Vec::new(),
        }
    }

    pub async fn connect(&self, target: &Value) -> Result<Value> {
        let (address, expected_peer_id) = extract_connect_target(target)?;
        let address = self.resolve_dial_address(&address, expected_peer_id.as_deref()).await;
        let network = self.network().await?;
        let info = network
            .connect(&address, expected_peer_id.as_deref())
            .await
            .map_err(|error| AppError::Network(normalize_connect_error(&error.to_string())))?;
        Ok(peer_info_to_value(&info))
    }

    /// Prefers a discovered endpoint for the peer when the raw input has no
    /// port or the peer is known via discovery.
    async fn resolve_dial_address(&self, address: &str, expected_peer_id: Option<&str>) -> String {
        if let Some(peer_id) = expected_peer_id {
            if let Ok(network) = self.network().await {
                if let Some(discovered) = network
                    .discovered_peers()
                    .into_iter()
                    .find(|peer| peer.peer_id == peer_id)
                {
                    if let Some(endpoint) = discovered.endpoints.first() {
                        if address.is_empty() {
                            return endpoint.clone();
                        }
                    }
                }
            }
        }
        address.to_owned()
    }

    pub async fn disconnect(&self, peer_id: &str) -> Result<()> {
        // A manual disconnect must not fight the auto-reconnect loop.
        self.clear_reconnect(peer_id);
        let network = self.network().await?;
        network
            .disconnect(peer_id)
            .map_err(|error| AppError::Network(error.to_string()))
    }

    pub async fn send(&self, peer_id: &str, data: Value) -> Result<bool> {
        let network = self.network().await?;
        match network.send(peer_id, data) {
            Ok(()) => Ok(true),
            Err(bluetalk_network::NetworkError::PeerNotFound(_)) => Ok(false),
            Err(error) => Err(AppError::Network(error.to_string())),
        }
    }

    pub async fn send_many(&self, peer_ids: &[String], data: Value) -> Result<Vec<Value>> {
        let network = self.network().await?;
        Ok(network
            .send_many(peer_ids, data)
            .into_iter()
            .map(|result| json!({ "peerId": result.peer_id, "sent": result.accepted }))
            .collect())
    }

    pub async fn broadcast(&self, data: Value) -> Result<Vec<Value>> {
        let network = self.network().await?;
        Ok(network
            .broadcast(data)
            .into_iter()
            .map(|result| json!({ "peerId": result.peer_id, "sent": result.accepted }))
            .collect())
    }

    pub async fn refresh_discovery(&self) -> Result<()> {
        let network = self.network().await?;
        network
            .refresh_discovery()
            .await
            .map_err(|error| AppError::Network(error.to_string()))?;
        // Dial any freshly discovered stored contact that is not connected.
        self.autoconnect_discovered().await;
        Ok(())
    }

    pub async fn reconnect_contacts(self: &Arc<Self>) {
        for contact in self.stored_contacts() {
            let Some(address) = contact.address else { continue };
            if contact.blocked {
                continue;
            }
            let connected = {
                let network = self.network.read().await.clone();
                network
                    .map(|network| network.peers().iter().any(|peer| peer.peer_id == contact.id))
                    .unwrap_or(false)
            };
            if connected {
                continue;
            }
            let service = self.clone();
            let target = json!({ "id": contact.id, "address": address });
            tauri::async_runtime::spawn(async move {
                if let Err(error) = service.connect(&target).await {
                    log::debug!("contact reconnect failed: {error}");
                }
            });
        }
    }

    // ------------------------------------------------------------------
    // File hosting over the encrypted channel
    // ------------------------------------------------------------------

    pub async fn host_file(&self, meta: Value) -> Result<Value> {
        let name = sanitize_download_name(meta.get("name").and_then(Value::as_str).unwrap_or(""));
        let mime_type =
            sanitize_content_type(meta.get("type").and_then(Value::as_str).unwrap_or(""));
        let data_b64 = meta
            .get("data")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::InvalidInput("file data must be base64".to_owned()))?;
        if !is_strict_base64(data_b64) {
            return Err(AppError::InvalidInput("invalid base64 payload".to_owned()));
        }
        let data = BASE64
            .decode(data_b64)
            .map_err(|_| AppError::InvalidInput("invalid base64 payload".to_owned()))?;
        if data.is_empty() || data.len() > MAX_HOSTED_FILE_BYTES {
            return Err(AppError::InvalidInput(format!(
                "hosted files must contain 1..={MAX_HOSTED_FILE_BYTES} bytes"
            )));
        }

        let file_id = random_file_id()?;
        let entry = HostedFile {
            id: file_id.clone(),
            name: name.clone(),
            size: data.len(),
            mime_type: mime_type.clone(),
            data,
            created_at: now_ms(),
        };
        {
            let mut hosted = self.hosted.lock();
            hosted.push(entry);
            // Oldest-first eviction, byte and count bounded (v1 semantics).
            while hosted.len() > MAX_HOSTED_FILES
                || hosted.iter().map(|file| file.size).sum::<usize>()
                    > MAX_TOTAL_HOSTED_FILE_BYTES
            {
                hosted.remove(0);
            }
        }

        let size = {
            let hosted = self.hosted.lock();
            hosted
                .iter()
                .find(|file| file.id == file_id)
                .map(|file| file.size)
                .unwrap_or(0)
        };
        if let Ok(network) = self.network().await {
            let _ = network.broadcast(json!({
                "kind": "file-hosted",
                "fileId": file_id,
                "fileName": name,
                "fileSize": size,
                "fileType": mime_type,
            }));
        }
        Ok(json!({ "fileId": file_id, "url": format!("bt2://files/{file_id}") }))
    }

    pub fn hosted_files(&self) -> Vec<Value> {
        self.hosted.lock().iter().map(hosted_file_summary).collect()
    }

    pub async fn request_file(&self, peer_id: &str, file_id: &str) -> Result<Value> {
        if !is_valid_file_id(file_id) {
            return Err(AppError::InvalidInput("invalid file id".to_owned()));
        }
        let request_id = random_file_id()?;
        let (sender, receiver) = oneshot::channel();
        self.pending_file_requests
            .lock()
            .insert(request_id.clone(), sender);

        let network = self.network().await?;
        let sent = network.send(
            peer_id,
            json!({ "kind": FILE_REQUEST_KIND, "fileId": file_id, "requestId": request_id }),
        );
        if let Err(error) = sent {
            self.pending_file_requests.lock().remove(&request_id);
            return Err(AppError::Network(error.to_string()));
        }

        let response = tokio::time::timeout(FILE_REQUEST_TIMEOUT, receiver)
            .await
            .map_err(|_| AppError::Network("file request timed out".to_owned()))?
            .map_err(|_| AppError::Network("file request aborted".to_owned()))?;

        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            let message = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("file unavailable");
            return Err(AppError::Network(message.to_owned()));
        }
        let result = json!({
            "fileId": file_id,
            "data": response.get("data").cloned().unwrap_or(Value::Null),
            "name": response.get("name").cloned().unwrap_or(Value::Null),
            "type": response.get("type").cloned().unwrap_or(Value::Null),
            "size": response.get("size").cloned().unwrap_or(Value::Null),
            "from": peer_id,
        });
        let _ = self.app.emit("peer:file-received", result.clone());
        Ok(result)
    }

    // ------------------------------------------------------------------
    // Event handling
    // ------------------------------------------------------------------

    async fn handle_network_event(self: Arc<Self>, event: NetworkEvent) {
        match event {
            NetworkEvent::PeerConnected(info) => {
                self.clear_reconnect(&info.peer_id);
                let _ = self.app.emit("peer:connected", peer_info_to_value(&info));
                let _ = self.app.emit("peers:list-sync", self.peers_snapshot().await);
            }
            NetworkEvent::PeerDisconnected { peer_id, reason } => {
                let _ = self
                    .app
                    .emit("peer:disconnected", json!({ "id": peer_id, "reason": reason }));
                let _ = self.app.emit("peers:list-sync", self.peers_snapshot().await);
                self.schedule_reconnect(&peer_id);
            }
            NetworkEvent::PeerDiscovered(peer) => {
                let (addresses, ports): (Vec<String>, Vec<u16>) = peer
                    .endpoints
                    .iter()
                    .filter_map(|endpoint| parse_tcp_endpoint(endpoint))
                    .map(|addr| (addr.ip().to_string(), addr.port()))
                    .unzip();
                let _ = self.app.emit(
                    "peer:discovered",
                    json!({
                        "id": peer.peer_id,
                        "name": peer.display_name,
                        "addresses": addresses,
                        "ports": ports,
                        "primaryPort": ports.first().copied().unwrap_or(0),
                        "lastSeenAt": peer.advertised_at_ms,
                        "sourceAddress": peer.observed_from,
                    }),
                );
                self.autoconnect_discovered_peer(&peer.peer_id, &peer.endpoints).await;
            }
            NetworkEvent::Message {
                from_peer_id,
                message_id,
                sent_at_ms,
                payload,
            } => {
                self.handle_peer_message(from_peer_id, message_id, sent_at_ms, payload)
                    .await;
            }
            NetworkEvent::Warning { code, message } => {
                log::warn!("network warning {code}: {message}");
            }
        }
    }

    async fn handle_peer_message(
        &self,
        from_peer_id: String,
        message_id: String,
        sent_at_ms: i64,
        payload: Value,
    ) {
        let kind = payload
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        match kind.as_str() {
            FILE_REQUEST_KIND => {
                self.answer_file_request(&from_peer_id, &payload).await;
            }
            FILE_RESPONSE_KIND => {
                let request_id = payload
                    .get("requestId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let pending = self.pending_file_requests.lock().remove(request_id);
                if let Some(sender) = pending {
                    let _ = sender.send(payload);
                }
            }
            _ => {
                let mut event = match payload {
                    Value::Object(map) => Value::Object(map),
                    other => json!({ "content": other }),
                };
                if let Value::Object(map) = &mut event {
                    map.insert("from".to_owned(), Value::String(from_peer_id.clone()));
                    map.entry("timestamp".to_owned())
                        .or_insert_with(|| Value::from(sent_at_ms));
                    map.entry("transportMessageId".to_owned())
                        .or_insert_with(|| Value::String(message_id));
                }
                if kind == "file-hosted" {
                    let _ = self.app.emit("peer:file-offered", event.clone());
                }
                let _ = self.app.emit("peer:message", event);
            }
        }
    }

    async fn answer_file_request(&self, from_peer_id: &str, payload: &Value) {
        let request_id = payload
            .get("requestId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let file_id = payload.get("fileId").and_then(Value::as_str).unwrap_or("");
        if request_id.is_empty() || request_id.len() > 64 || !is_valid_file_id(file_id) {
            return;
        }
        let response = {
            let hosted = self.hosted.lock();
            match hosted.iter().find(|file| file.id == file_id) {
                Some(file) => json!({
                    "kind": FILE_RESPONSE_KIND,
                    "requestId": request_id,
                    "ok": true,
                    "fileId": file.id,
                    "data": BASE64.encode(&file.data),
                    "name": file.name,
                    "type": file.mime_type,
                    "size": file.size,
                }),
                None => json!({
                    "kind": FILE_RESPONSE_KIND,
                    "requestId": request_id,
                    "ok": false,
                    "fileId": file_id,
                    "error": "file_not_found",
                }),
            }
        };
        if let Ok(network) = self.network().await {
            let _ = network.send(from_peer_id, response);
        }
    }

    // ------------------------------------------------------------------
    // Reconnect handling
    // ------------------------------------------------------------------

    fn stored_contacts(&self) -> Vec<StoredContact> {
        let contacts = self
            .database
            .get("contacts", Value::Array(Vec::new()))
            .unwrap_or(Value::Array(Vec::new()));
        let Value::Array(entries) = contacts else {
            return Vec::new();
        };
        entries
            .into_iter()
            .filter_map(|entry| {
                let id = entry.get("id").and_then(Value::as_str)?.to_owned();
                Some(StoredContact {
                    id,
                    address: entry
                        .get("address")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .filter(|address| !address.trim().is_empty()),
                    blocked: entry.get("blocked").and_then(Value::as_bool) == Some(true),
                })
            })
            .collect()
    }

    fn clear_reconnect(&self, peer_id: &str) {
        if let Some(entry) = self.reconnects.lock().remove(peer_id) {
            entry.task.abort();
        }
    }

    fn schedule_reconnect(self: &Arc<Self>, peer_id: &str) {
        let contact = self
            .stored_contacts()
            .into_iter()
            .find(|contact| contact.id == peer_id && !contact.blocked);
        let Some(contact) = contact else { return };
        let Some(address) = contact.address else { return };

        let attempt = {
            let reconnects = self.reconnects.lock();
            reconnects
                .get(peer_id)
                .map(|entry| entry.attempt + 1)
                .unwrap_or(1)
        };
        let exponent = attempt.saturating_sub(1).min(5);
        let delay_ms = (RECONNECT_BASE_DELAY_MS << exponent).min(RECONNECT_MAX_DELAY_MS);
        let jitter = u64::from(rand::random::<u16>()) % (delay_ms / 4).max(1);

        let service = self.clone();
        let peer_id_owned = peer_id.to_owned();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay_ms + jitter)).await;
            let target = json!({ "id": peer_id_owned, "address": address });
            match service.connect(&target).await {
                Ok(_) => service.clear_reconnect(&peer_id_owned),
                Err(error) => {
                    log::debug!("reconnect to {peer_id_owned} failed: {error}");
                    service.schedule_reconnect(&peer_id_owned);
                }
            }
        });
        self.reconnects
            .lock()
            .insert(peer_id.to_owned(), ReconnectEntry { attempt, task });
    }

    async fn autoconnect_discovered(&self) {
        let Ok(network) = self.network().await else { return };
        for peer in network.discovered_peers() {
            self.autoconnect_discovered_peer(&peer.peer_id, &peer.endpoints)
                .await;
        }
    }

    /// Dials a discovered peer when it is a stored, unblocked contact, or when
    /// nothing is connected yet (v1 LAN auto-connect behaviour).
    async fn autoconnect_discovered_peer(&self, peer_id: &str, endpoints: &[String]) {
        let Ok(network) = self.network().await else { return };
        if network.peers().iter().any(|peer| peer.peer_id == peer_id) {
            return;
        }
        let is_contact = self
            .stored_contacts()
            .iter()
            .any(|contact| contact.id == peer_id && !contact.blocked);
        let nothing_connected = network.peers().is_empty();
        if !is_contact && !nothing_connected {
            return;
        }
        let Some(endpoint) = endpoints.first().cloned() else { return };
        let expected = peer_id.to_owned();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = network.connect(&endpoint, Some(&expected)).await {
                log::debug!("discovery auto-connect to {expected} failed: {error}");
            }
        });
    }
}

struct StoredContact {
    id: String,
    address: Option<String>,
    blocked: bool,
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

fn peer_info_to_value(info: &bluetalk_network::PeerInfo) -> Value {
    let (address, port) = match info.remote_address.parse::<SocketAddr>() {
        Ok(addr) => (addr.ip().to_string(), addr.port()),
        Err(_) => (info.remote_address.clone(), 0),
    };
    json!({
        "id": info.peer_id,
        "name": info.display_name,
        "address": address,
        "port": port,
        "ports": if port == 0 { Vec::new() } else { vec![port] },
        "connectedAt": info.connected_at_ms,
        "direction": info.direction,
        "encrypted": info.authenticated_encryption,
        "supportsHeartbeat": true,
    })
}

fn hosted_file_summary(file: &HostedFile) -> Value {
    json!({
        "id": file.id,
        "name": file.name,
        "size": file.size,
        "type": file.mime_type,
        "createdAt": file.created_at,
    })
}

fn extract_connect_target(target: &Value) -> Result<(String, Option<String>)> {
    match target {
        Value::String(address) => Ok((normalize_connect_address(address)?, None)),
        Value::Object(map) => {
            let peer_id = map
                .get("id")
                .or_else(|| map.get("peerId"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let address = map
                .get("address")
                .and_then(Value::as_str)
                .map(normalize_connect_address)
                .transpose()?
                .unwrap_or_default();
            if address.is_empty() && peer_id.is_none() {
                return Err(AppError::InvalidInput(
                    "connect target needs an address or peer id".to_owned(),
                ));
            }
            Ok((address, peer_id))
        }
        _ => Err(AppError::InvalidInput("invalid connect target".to_owned())),
    }
}

/// Accepts `host`, `host:port`, and `scheme://host:port` inputs and returns a
/// dialable `host:port` string (default port appended when missing).
pub fn normalize_connect_address(raw: &str) -> Result<String> {
    let mut input = raw.trim().to_owned();
    input.retain(|character| !character.is_whitespace());
    if input.is_empty() || input.len() > 512 {
        return Err(AppError::InvalidInput("invalid address".to_owned()));
    }
    for prefix in ["tcp://", "ws://", "wss://", "http://", "https://"] {
        if let Some(stripped) = input.strip_prefix(prefix) {
            input = stripped.to_owned();
            break;
        }
    }
    if let Some(stripped) = input.strip_suffix("/bt/ws") {
        input = stripped.to_owned();
    }
    let input = input.trim_end_matches('/');

    if let Ok(address) = input.parse::<SocketAddr>() {
        return Ok(address.to_string());
    }
    if let Ok(ip) = input.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, DEFAULT_LISTEN_PORT).to_string());
    }
    // host:port with a plain IPv4/hostname
    if let Some((host, port)) = input.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            if port > 0 && is_plausible_host(host) {
                return Ok(format!("{host}:{port}"));
            }
        }
    }
    if is_plausible_host(input) {
        return Ok(format!("{input}:{DEFAULT_LISTEN_PORT}"));
    }
    Err(AppError::InvalidInput("invalid address".to_owned()))
}

fn is_plausible_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

fn normalize_connect_error(error: &str) -> String {
    if error.contains("timed out") || error.contains("refused") || error.contains("unreachable") {
        "Connection failed".to_owned()
    } else {
        error.to_owned()
    }
}

fn parse_tcp_endpoint(endpoint: &str) -> Option<SocketAddr> {
    endpoint
        .strip_prefix("tcp://")
        .unwrap_or(endpoint)
        .trim_end_matches('/')
        .parse()
        .ok()
}

pub fn local_ipv4_addresses() -> Vec<Ipv4Addr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) => Some(v4.ip),
            _ => None,
        })
        .collect()
}

fn local_broadcast_addresses() -> Vec<Ipv4Addr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) => v4.broadcast,
            _ => None,
        })
        .collect()
}

fn is_strict_base64(value: &str) -> bool {
    !value.is_empty()
        && value.len() % 4 == 0
        && value.len() <= 12 * 1024 * 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn is_valid_file_id(file_id: &str) -> bool {
    file_id.len() == 24 && file_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn random_file_id() -> Result<String> {
    let mut bytes = [0_u8; 12];
    rand::fill(&mut bytes);
    Ok(hex::encode(bytes))
}

fn sanitize_download_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '"' | '\\' | '/'))
        .take(180)
        .collect();
    if cleaned.trim().is_empty() {
        "download.bin".to_owned()
    } else {
        cleaned
    }
}

fn sanitize_content_type(mime_type: &str) -> String {
    let candidate = mime_type.trim();
    let valid = candidate.len() <= 120
        && candidate.split_once('/').is_some_and(|(kind, subtype)| {
            !kind.is_empty()
                && !subtype.is_empty()
                && candidate
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b'"')
        });
    if valid {
        candidate.to_owned()
    } else {
        "application/octet-stream".to_owned()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

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
