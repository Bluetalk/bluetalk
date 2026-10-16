//! Tunnel-Zuordnung, Binärframe-Umschreibung, Open-Timeout und Limits.
//!
//! Schlüssel ist die Verbindungs-Generation (ein Gerät), nicht die Peer-ID —
//! Limits gelten damit pro Verbindung.

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
    pub remote_gen: u64,
    pub remote_id: u32,
}

#[derive(Clone, Debug)]
pub struct PendingOut {
    pub to_gen: u64,
    pub remote_id: u32,
}

#[derive(Clone, Debug)]
pub struct PendingIn {
    pub from_gen: u64,
    pub remote_id: u32,
}

#[derive(Default)]
struct ConnTunnels {
    established: HashMap<u32, Endpoint>,
    pending_out: HashMap<u32, PendingOut>,
    pending_in: HashMap<u32, PendingIn>,
    next_hint: u32,
}

impl ConnTunnels {
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
    by_conn: HashMap<u64, ConnTunnels>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenFail {
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
        from_gen: u64,
        from_peer: &str,
        local_id: u32,
        to_gen: u64,
        to_peer: &str,
    ) -> Result<OpenOk, OpenFail> {
        if from_peer == to_peer {
            return Err(OpenFail::SelfOpen);
        }
        if local_id == 0 {
            return Err(OpenFail::Invalid);
        }
        {
            let src = self.by_conn.entry(from_gen).or_default();
            if src.used(local_id) {
                return Err(OpenFail::Invalid);
            }
            if src.total() >= MAX_TUNNELS || src.pending_out.len() >= MAX_PENDING_OPENS {
                return Err(OpenFail::Limit);
            }
        }
        let remote_id = {
            let dst = self.by_conn.entry(to_gen).or_default();
            if dst.total() >= MAX_TUNNELS || dst.pending_in.len() >= MAX_PENDING_OPENS {
                return Err(OpenFail::Limit);
            }
            dst.alloc_id().ok_or(OpenFail::Limit)?
        };
        self.by_conn
            .entry(from_gen)
            .or_default()
            .pending_out
            .insert(local_id, PendingOut { to_gen, remote_id });
        self.by_conn.entry(to_gen).or_default().pending_in.insert(
            remote_id,
            PendingIn {
                from_gen,
                remote_id: local_id,
            },
        );
        Ok(OpenOk { remote_id })
    }

    /// B akzeptiert. Liefert (A-Generation, A-Tunnel-ID).
    pub fn accept(&mut self, gid: u64, local_id: u32) -> Result<(u64, u32), OpenFail> {
        let pending = self
            .by_conn
            .get_mut(&gid)
            .and_then(|p| p.pending_in.remove(&local_id))
            .ok_or(OpenFail::Invalid)?;
        let from_gen = pending.from_gen;
        let from_id = pending.remote_id;
        let src_ok = self
            .by_conn
            .get_mut(&from_gen)
            .and_then(|p| p.pending_out.remove(&from_id))
            .is_some();
        if !src_ok {
            return Err(OpenFail::Invalid);
        }
        self.by_conn.entry(gid).or_default().established.insert(
            local_id,
            Endpoint {
                remote_gen: from_gen,
                remote_id: from_id,
            },
        );
        self.by_conn
            .entry(from_gen)
            .or_default()
            .established
            .insert(
                from_id,
                Endpoint {
                    remote_gen: gid,
                    remote_id: local_id,
                },
            );
        Ok((from_gen, from_id))
    }

    /// B lehnt ab. Liefert (A-Generation, A-Tunnel-ID).
    pub fn reject(&mut self, gid: u64, local_id: u32) -> Result<(u64, u32), OpenFail> {
        let pending = self
            .by_conn
            .get_mut(&gid)
            .and_then(|p| p.pending_in.remove(&local_id))
            .ok_or(OpenFail::Invalid)?;
        let from_gen = pending.from_gen;
        let from_id = pending.remote_id;
        if let Some(src) = self.by_conn.get_mut(&from_gen) {
            src.pending_out.remove(&from_id);
        }
        Ok((from_gen, from_id))
    }

    /// Timeout der offenen Anfrage von A.
    pub fn timeout_open(&mut self, from_gen: u64, local_id: u32) -> Option<(u64, u32)> {
        let pending = self
            .by_conn
            .get_mut(&from_gen)
            .and_then(|p| p.pending_out.remove(&local_id))?;
        if let Some(dst) = self.by_conn.get_mut(&pending.to_gen) {
            dst.pending_in.remove(&pending.remote_id);
        }
        Some((pending.to_gen, pending.remote_id))
    }

    pub fn lookup(&self, gid: u64, local_id: u32) -> Option<Endpoint> {
        self.by_conn
            .get(&gid)
            .and_then(|p| p.established.get(&local_id))
            .cloned()
    }

    /// Schließt einen etablierten oder ausstehenden Tunnel. Liefert Gegenseite.
    pub fn close(&mut self, gid: u64, local_id: u32) -> Option<(u64, u32)> {
        if let Some(end) = self
            .by_conn
            .get_mut(&gid)
            .and_then(|p| p.established.remove(&local_id))
        {
            if let Some(remote) = self.by_conn.get_mut(&end.remote_gen) {
                remote.established.remove(&end.remote_id);
            }
            return Some((end.remote_gen, end.remote_id));
        }
        if let Some(p) = self
            .by_conn
            .get_mut(&gid)
            .and_then(|t| t.pending_out.remove(&local_id))
        {
            if let Some(dst) = self.by_conn.get_mut(&p.to_gen) {
                dst.pending_in.remove(&p.remote_id);
            }
            return Some((p.to_gen, p.remote_id));
        }
        if let Some(p) = self
            .by_conn
            .get_mut(&gid)
            .and_then(|t| t.pending_in.remove(&local_id))
        {
            if let Some(src) = self.by_conn.get_mut(&p.from_gen) {
                src.pending_out.remove(&p.remote_id);
            }
            return Some((p.from_gen, p.remote_id));
        }
        None
    }

    /// Alle Tunnel einer Verbindung, Gegenseiten zum Benachrichtigen.
    pub fn drop_conn(&mut self, gid: u64) -> Vec<(u64, u32)> {
        let Some(own) = self.by_conn.remove(&gid) else {
            return Vec::new();
        };
        let mut notify = Vec::new();
        for (_, end) in own.established {
            if let Some(remote) = self.by_conn.get_mut(&end.remote_gen) {
                remote.established.remove(&end.remote_id);
            }
            notify.push((end.remote_gen, end.remote_id));
        }
        for (_, p) in own.pending_out {
            if let Some(dst) = self.by_conn.get_mut(&p.to_gen) {
                dst.pending_in.remove(&p.remote_id);
            }
            notify.push((p.to_gen, p.remote_id));
        }
        for (_, p) in own.pending_in {
            if let Some(src) = self.by_conn.get_mut(&p.from_gen) {
                src.pending_out.remove(&p.remote_id);
            }
            notify.push((p.from_gen, p.remote_id));
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
        let ok = t.open(1, "A", 7, 2, "B").expect("open");
        assert_eq!(ok.remote_id, 1);
        let (from_gen, from_id) = t.accept(2, 1).expect("accept");
        assert_eq!(from_gen, 1);
        assert_eq!(from_id, 7);
        let fwd = t.lookup(1, 7).expect("map");
        assert_eq!(fwd.remote_gen, 2);
        assert_eq!(fwd.remote_id, 1);
        let back = t.close(1, 7).expect("close");
        assert_eq!(back, (2, 1));
        assert!(t.lookup(2, 1).is_none());
    }

    #[test]
    fn open_gleiche_peer_id_ist_self() {
        let mut t = Tunnels::default();
        assert_eq!(t.open(1, "A", 7, 2, "A").err(), Some(OpenFail::SelfOpen));
    }
}
