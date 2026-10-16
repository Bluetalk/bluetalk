//! Tunnel-Zuordnung, Binärframe-Umschreibung, Open-Timeout und Limits.

use std::collections::HashMap;

use crate::proto::{MAX_FRAME_PAYLOAD, MAX_PENDING_OPENS, MAX_TUNNELS};

/// `[u32 BE tunnelId][payload]`, Payload max. 64 KiB.
pub fn encode_frame(tunnel_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&tunnel_id.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

pub fn decode_frame(data: &[u8]) -> Option<(u32, &[u8])> {
    if data.len() < 4 || data.len() > 4 + MAX_FRAME_PAYLOAD {
        return None;
    }
    let id = u32::from_be_bytes(data[0..4].try_into().ok()?);
    if id == 0 {
        return None;
    }
    Some((id, &data[4..]))
}

#[derive(Clone, Debug)]
pub struct Endpoint {
    pub remote_peer: String,
    pub remote_id: u32,
}

#[derive(Clone, Debug)]
pub struct PendingOut {
    pub to: String,
    pub remote_id: u32,
}

#[derive(Clone, Debug)]
pub struct PendingIn {
    pub from: String,
    pub remote_id: u32,
}

#[derive(Default)]
struct PeerTunnels {
    established: HashMap<u32, Endpoint>,
    pending_out: HashMap<u32, PendingOut>,
    pending_in: HashMap<u32, PendingIn>,
    next_hint: u32,
}

impl PeerTunnels {
    fn used(&self, id: u32) -> bool {
        self.established.contains_key(&id)
            || self.pending_out.contains_key(&id)
            || self.pending_in.contains_key(&id)
    }

    fn total(&self) -> usize {
        self.established.len() + self.pending_out.len() + self.pending_in.len()
    }

    fn alloc_id(&mut self) -> Option<u32> {
        if self.total() >= MAX_TUNNELS {
            return None;
        }
        let start = if self.next_hint == 0 {
            1
        } else {
            self.next_hint
        };
        let mut id = start;
        for _ in 0..u32::MAX {
            if id != 0 && !self.used(id) {
                self.next_hint = id.wrapping_add(1);
                return Some(id);
            }
            id = id.wrapping_add(1);
        }
        None
    }
}

#[derive(Default)]
pub struct Tunnels {
    by_peer: HashMap<String, PeerTunnels>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenFail {
    Offline,
    Limit,
    SelfOpen,
    Invalid,
}

pub struct OpenOk {
    pub remote_id: u32,
}

impl Tunnels {
    pub fn open(
        &mut self,
        from: &str,
        local_id: u32,
        to: &str,
        target_online: bool,
    ) -> Result<OpenOk, OpenFail> {
        if from == to {
            return Err(OpenFail::SelfOpen);
        }
        if local_id == 0 {
            return Err(OpenFail::Invalid);
        }
        if !target_online {
            return Err(OpenFail::Offline);
        }
        {
            let src = self.by_peer.entry(from.to_string()).or_default();
            if src.used(local_id) {
                return Err(OpenFail::Invalid);
            }
            if src.total() >= MAX_TUNNELS || src.pending_out.len() >= MAX_PENDING_OPENS {
                return Err(OpenFail::Limit);
            }
        }
        let remote_id = {
            let dst = self.by_peer.entry(to.to_string()).or_default();
            if dst.total() >= MAX_TUNNELS || dst.pending_in.len() >= MAX_PENDING_OPENS {
                return Err(OpenFail::Limit);
            }
            dst.alloc_id().ok_or(OpenFail::Limit)?
        };
        self.by_peer
            .entry(from.to_string())
            .or_default()
            .pending_out
            .insert(
                local_id,
                PendingOut {
                    to: to.to_string(),
                    remote_id,
                },
            );
        self.by_peer
            .entry(to.to_string())
            .or_default()
            .pending_in
            .insert(
                remote_id,
                PendingIn {
                    from: from.to_string(),
                    remote_id: local_id,
                },
            );
        Ok(OpenOk { remote_id })
    }

    /// B akzeptiert. Liefert (A-Peer, A-Tunnel-ID).
    pub fn accept(&mut self, peer: &str, local_id: u32) -> Result<(String, u32), OpenFail> {
        let pending = self
            .by_peer
            .get_mut(peer)
            .and_then(|p| p.pending_in.remove(&local_id))
            .ok_or(OpenFail::Invalid)?;
        let from = pending.from;
        let from_id = pending.remote_id;
        let src_ok = self
            .by_peer
            .get_mut(&from)
            .and_then(|p| p.pending_out.remove(&from_id))
            .is_some();
        if !src_ok {
            return Err(OpenFail::Invalid);
        }
        self.by_peer
            .entry(peer.to_string())
            .or_default()
            .established
            .insert(
                local_id,
                Endpoint {
                    remote_peer: from.clone(),
                    remote_id: from_id,
                },
            );
        self.by_peer
            .entry(from.clone())
            .or_default()
            .established
            .insert(
                from_id,
                Endpoint {
                    remote_peer: peer.to_string(),
                    remote_id: local_id,
                },
            );
        Ok((from, from_id))
    }

    /// B lehnt ab. Liefert (A-Peer, A-Tunnel-ID).
    pub fn reject(&mut self, peer: &str, local_id: u32) -> Result<(String, u32), OpenFail> {
        let pending = self
            .by_peer
            .get_mut(peer)
            .and_then(|p| p.pending_in.remove(&local_id))
            .ok_or(OpenFail::Invalid)?;
        let from = pending.from;
        let from_id = pending.remote_id;
        if let Some(src) = self.by_peer.get_mut(&from) {
            src.pending_out.remove(&from_id);
        }
        Ok((from, from_id))
    }

    /// Timeout der offenen Anfrage von A.
    pub fn timeout_open(&mut self, from: &str, local_id: u32) -> Option<(String, u32)> {
        let pending = self
            .by_peer
            .get_mut(from)
            .and_then(|p| p.pending_out.remove(&local_id))?;
        if let Some(dst) = self.by_peer.get_mut(&pending.to) {
            dst.pending_in.remove(&pending.remote_id);
        }
        Some((pending.to, pending.remote_id))
    }

    pub fn lookup(&self, peer: &str, local_id: u32) -> Option<Endpoint> {
        self.by_peer
            .get(peer)
            .and_then(|p| p.established.get(&local_id))
            .cloned()
    }

    /// Schließt einen etablierten oder ausstehenden Tunnel. Liefert Gegenseite.
    pub fn close(&mut self, peer: &str, local_id: u32) -> Option<(String, u32)> {
        if let Some(end) = self
            .by_peer
            .get_mut(peer)
            .and_then(|p| p.established.remove(&local_id))
        {
            if let Some(remote) = self.by_peer.get_mut(&end.remote_peer) {
                remote.established.remove(&end.remote_id);
            }
            return Some((end.remote_peer, end.remote_id));
        }
        if let Some(p) = self
            .by_peer
            .get_mut(peer)
            .and_then(|t| t.pending_out.remove(&local_id))
        {
            if let Some(dst) = self.by_peer.get_mut(&p.to) {
                dst.pending_in.remove(&p.remote_id);
            }
            return Some((p.to, p.remote_id));
        }
        if let Some(p) = self
            .by_peer
            .get_mut(peer)
            .and_then(|t| t.pending_in.remove(&local_id))
        {
            if let Some(src) = self.by_peer.get_mut(&p.from) {
                src.pending_out.remove(&p.remote_id);
            }
            return Some((p.from, p.remote_id));
        }
        None
    }

    /// Alle Tunnel eines Peers, Gegenseiten zum Benachrichtigen.
    pub fn drop_peer(&mut self, peer: &str) -> Vec<(String, u32)> {
        let Some(own) = self.by_peer.remove(peer) else {
            return Vec::new();
        };
        let mut notify = Vec::new();
        for (_, end) in own.established {
            if let Some(remote) = self.by_peer.get_mut(&end.remote_peer) {
                remote.established.remove(&end.remote_id);
            }
            notify.push((end.remote_peer, end.remote_id));
        }
        for (_, p) in own.pending_out {
            if let Some(dst) = self.by_peer.get_mut(&p.to) {
                dst.pending_in.remove(&p.remote_id);
            }
            notify.push((p.to, p.remote_id));
        }
        for (_, p) in own.pending_in {
            if let Some(src) = self.by_peer.get_mut(&p.from) {
                src.pending_out.remove(&p.remote_id);
            }
            notify.push((p.from, p.remote_id));
        }
        notify
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_id_umschreiben() {
        let payload = b"hello-tunnel";
        let a = encode_frame(7, payload);
        let (id, rest) = decode_frame(&a).expect("decode");
        assert_eq!(id, 7);
        assert_eq!(rest, payload);
        let b = encode_frame(3, rest);
        let (id2, rest2) = decode_frame(&b).expect("decode2");
        assert_eq!(id2, 3);
        assert_eq!(rest2, payload);
        assert!(decode_frame(&[0, 0]).is_none());
        assert!(decode_frame(&encode_frame(0, payload)).is_none());
        let too_big = vec![0u8; MAX_FRAME_PAYLOAD + 5];
        assert!(decode_frame(&too_big).is_none());
    }

    #[test]
    fn zuordnung_open_accept_close() {
        let mut t = Tunnels::default();
        let ok = t.open("A", 7, "B", true).expect("open");
        assert_eq!(ok.remote_id, 1);
        let (from, from_id) = t.accept("B", 1).expect("accept");
        assert_eq!(from, "A");
        assert_eq!(from_id, 7);
        let fwd = t.lookup("A", 7).expect("map");
        assert_eq!(fwd.remote_peer, "B");
        assert_eq!(fwd.remote_id, 1);
        let back = t.close("A", 7).expect("close");
        assert_eq!(back, ("B".into(), 1));
        assert!(t.lookup("B", 1).is_none());
    }
}
