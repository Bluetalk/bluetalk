//! Info-, Peer-, Verbindungs- und Nachrichten-Befehle (get_info, connect,\n//! send/broadcast, Discovery, Reconnect-Auslöser).

use super::*;
use super::helpers::*;

impl PeerService {
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
        if let Some(peer_id) = expected_peer_id.as_deref() {
            if let Some(existing) = self.peer_snapshot(peer_id).await {
                return Ok(existing);
            }
        }
        let address = self.resolve_dial_address(&address, expected_peer_id.as_deref()).await;
        let direct_error = if address.is_empty() {
            None
        } else {
            match self.network().await {
                Ok(network) => match network.connect(&address, expected_peer_id.as_deref()).await {
                    Ok(info) => return Ok(peer_info_to_value(&info)),
                    Err(error) => Some(normalize_connect_error(&error.to_string())),
                },
                Err(error) => Some(error.to_string()),
            }
        };

        if let Some(peer_id) = expected_peer_id.as_deref() {
            if let Some(existing) = self.peer_snapshot(peer_id).await {
                return Ok(existing);
            }
            if let Some(cloud) = self.app.try_state::<Arc<crate::cloud::CloudService>>() {
                if cloud.is_online() {
                    match cloud.open_peer(peer_id).await {
                        Ok(info) => return Ok(info),
                        Err(error) => {
                            if address.is_empty() {
                                return Err(error);
                            }
                            log::debug!("cloud fallback for {peer_id} failed: {error}");
                        }
                    }
                }
            }
        }

        Err(AppError::Network(direct_error.unwrap_or_else(|| {
            "Connection failed".to_owned()
        })))
    }

    pub(crate) async fn connect_relay_stream<S>(
        &self,
        stream: S,
        remote_address: String,
        expected_peer_id: Option<&str>,
        device_key: &str,
        device_name: &str,
    ) -> Result<Value>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let network = self.network().await?;
        match network
            .connect_stream(
                stream,
                remote_address,
                expected_peer_id,
                device_key,
                device_name,
            )
            .await
        {
            Ok(info) => Ok(peer_info_to_value(&info)),
            Err(bluetalk_network::NetworkError::DuplicatePeer(id)) => self
                .peer_snapshot(&id)
                .await
                .ok_or_else(|| AppError::Network(format!("peer already connected: {id}"))),
            Err(error) => Err(AppError::Network(normalize_connect_error(&error.to_string()))),
        }
    }

    pub(crate) async fn accept_relay_stream<S>(
        &self,
        stream: S,
        remote_address: String,
        device_key: &str,
        device_name: &str,
    ) -> Result<Value>
    where
        S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
    {
        let network = self.network().await?;
        match network
            .accept_stream(stream, remote_address, device_key, device_name)
            .await
        {
            Ok(info) => Ok(peer_info_to_value(&info)),
            Err(bluetalk_network::NetworkError::DuplicatePeer(id)) => self
                .peer_snapshot(&id)
                .await
                .ok_or_else(|| AppError::Network(format!("peer already connected: {id}"))),
            Err(error) => Err(AppError::Network(error.to_string())),
        }
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

    pub async fn send_to(&self, peer_id: &str, device_key: &str, data: Value) -> Result<bool> {
        let network = self.network().await?;
        match network.send_to(peer_id, device_key, data) {
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
        let cloud_online = self.cloud_online();
        for contact in self.stored_contacts() {
            if contact.blocked {
                continue;
            }
            if contact.address.is_none() && !cloud_online {
                continue;
            }
            if self.has_peer(&contact.id).await {
                continue;
            }
            let service = self.clone();
            let target = match contact.address {
                Some(address) => json!({ "id": contact.id, "address": address }),
                None => json!({ "id": contact.id }),
            };
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

}
