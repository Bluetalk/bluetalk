//! Hintergrund-Schleifen: TCP-Accept-Loop, UDP-Discovery-Loop und
//! periodisches Announce.

use super::*;
use super::session::spawn_session;

pub(super) async fn accept_loop(
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

pub(super) async fn discovery_loop(
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

pub(super) async fn announce_once(inner: &Arc<Inner>, socket: &UdpSocket, listen_port: u16) {
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
