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

}
