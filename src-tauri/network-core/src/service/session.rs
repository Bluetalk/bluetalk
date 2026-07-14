//! Sitzungs-Aufbau: Peer-Registrierung (Duplikat-Auflösung) und der
//! Reader/Writer-Task, der eine verschlüsselte Verbindung betreibt.

use super::*;

/// Registers the peer (applying the duplicate-connection tie-break) and spawns
/// the reader/writer tasks that own the connection.
pub(super) fn spawn_session(
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
