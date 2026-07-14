//! Netzwerk-Event-Verarbeitung und Beantwortung von Datei-Anfragen.

use super::*;
use super::helpers::*;

impl PeerService {
    pub(super) async fn handle_network_event(self: Arc<Self>, event: NetworkEvent) {
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
}
