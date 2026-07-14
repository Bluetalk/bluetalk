//! Kontakt-basiertes Reconnect und Auto-Connect entdeckter Peers.

use super::*;

impl PeerService {
    pub(super) fn stored_contacts(&self) -> Vec<StoredContact> {
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

    pub(super) fn clear_reconnect(&self, peer_id: &str) {
        if let Some(entry) = self.reconnects.lock().remove(peer_id) {
            entry.task.abort();
        }
    }

    pub(super) fn schedule_reconnect(self: &Arc<Self>, peer_id: &str) {
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

    pub(super) async fn autoconnect_discovered(&self) {
        let Ok(network) = self.network().await else { return };
        for peer in network.discovered_peers() {
            self.autoconnect_discovered_peer(&peer.peer_id, &peer.endpoints)
                .await;
        }
    }

    /// Dials a discovered peer when it is a stored, unblocked contact, or when
    /// nothing is connected yet (v1 LAN auto-connect behaviour).
    pub(super) async fn autoconnect_discovered_peer(&self, peer_id: &str, endpoints: &[String]) {
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
