//! Verbundene Peers, Doppel-Login, gegenseitige Präsenz, Tunnel-Dispatch.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};

use tokio::sync::{mpsc, watch};

use crate::proto::{
    CONTROL_PUSH_TIMEOUT_MS, FORWARD_TIMEOUT_SECS, Outbound, closed, incoming, open_failed, opened,
    presence,
};
use crate::tunnel::{OpenFail, Tunnels};
use crate::util::short_id;

pub struct PeerSlot {
    pub generation: u64,
    pub name: String,
    pub control: mpsc::Sender<Outbound>,
    pub data: mpsc::Sender<Outbound>,
    pub cancel: watch::Sender<bool>,
    pub watch: HashSet<String>,
}

struct Inner {
    peers: HashMap<String, PeerSlot>,
    tunnels: Tunnels,
    next_gen: u64,
}

pub struct Hub {
    inner: Mutex<Inner>,
}

pub struct RegisterResult {
    pub generation: u64,
}

struct Push {
    tx: mpsc::Sender<Outbound>,
    cancel: watch::Sender<bool>,
    msg: Outbound,
}

impl Hub {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                peers: HashMap::new(),
                tunnels: Tunnels::default(),
                next_gen: 1,
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn online_count(&self) -> usize {
        self.lock().peers.len()
    }

    /// Registriert die Verbindung. Eine ältere derselben Peer-ID wird ersetzt.
    pub fn register(
        &self,
        peer_id: String,
        name: String,
        control: mpsc::Sender<Outbound>,
        data: mpsc::Sender<Outbound>,
        cancel: watch::Sender<bool>,
    ) -> RegisterResult {
        let mut g = self.lock();
        let generation = g.next_gen;
        g.next_gen += 1;
        let mut pushes = Vec::new();
        if g.peers.contains_key(&peer_id) {
            detach_peer(&mut g, &peer_id, Some("replaced"), &mut pushes);
        }
        g.peers.insert(
            peer_id,
            PeerSlot {
                generation,
                name,
                control,
                data,
                cancel,
                watch: HashSet::new(),
            },
        );
        drop(g);
        flush(pushes);
        RegisterResult { generation }
    }

    pub fn unregister(&self, peer_id: &str, generation: u64) {
        let mut g = self.lock();
        let current = g.peers.get(peer_id).map(|p| p.generation);
        if current != Some(generation) {
            return;
        }
        let mut pushes = Vec::new();
        detach_peer(&mut g, peer_id, None, &mut pushes);
        drop(g);
        flush(pushes);
    }

    /// Ersetzt die Watch-Liste. Liefert Snapshot-Nachrichten an den Aufrufer.
    pub fn set_watch(&self, peer_id: &str, generation: u64, peers: Vec<String>) -> Vec<Outbound> {
        let mut g = self.lock();
        if g.peers.get(peer_id).map(|p| p.generation) != Some(generation) {
            return Vec::new();
        }
        let old_watch = g
            .peers
            .get(peer_id)
            .map(|p| p.watch.clone())
            .unwrap_or_default();
        if let Some(p) = g.peers.get_mut(peer_id) {
            p.watch = peers.into_iter().collect();
        }
        let mut snapshot = Vec::new();
        let mut pushes = Vec::new();

        let new_watch = g
            .peers
            .get(peer_id)
            .map(|p| p.watch.clone())
            .unwrap_or_default();
        let old_mutual = mutual_set(&g, peer_id, &old_watch);
        let new_mutual = mutual_set(&g, peer_id, &new_watch);

        for other in &old_mutual {
            if !new_mutual.contains(other)
                && let Some(p) = g.peers.get(other)
            {
                pushes.push(Push {
                    tx: p.control.clone(),
                    cancel: p.cancel.clone(),
                    msg: Outbound::json(presence(peer_id, false)),
                });
            }
        }
        for other in &new_mutual {
            snapshot.push(Outbound::json(presence(other, true)));
            if !old_mutual.contains(other)
                && let Some(p) = g.peers.get(other)
            {
                pushes.push(Push {
                    tx: p.control.clone(),
                    cancel: p.cancel.clone(),
                    msg: Outbound::json(presence(peer_id, true)),
                });
            }
        }
        drop(g);
        flush(pushes);
        snapshot
    }

    pub fn open_tunnel(
        &self,
        from: &str,
        generation: u64,
        local_id: u32,
        to: &str,
    ) -> Result<(), &'static str> {
        let mut g = self.lock();
        if g.peers.get(from).map(|p| p.generation) != Some(generation) {
            return Err("invalid");
        }
        if from == to {
            return Err("self");
        }
        let target_online = g.peers.contains_key(to);
        let name = g
            .peers
            .get(from)
            .map(|p| p.name.clone())
            .unwrap_or_default();
        match g.tunnels.open(from, local_id, to, target_online) {
            Ok(ok) => {
                let Some(target) = g.peers.get(to) else {
                    return Err("offline");
                };
                tracing::debug!(
                    from = %short_id(from),
                    to = %short_id(to),
                    tunnel = local_id,
                    remote = ok.remote_id,
                    "open"
                );
                let msg = Outbound::json(incoming(ok.remote_id, from, &name));
                let tx = target.control.clone();
                let cancel = target.cancel.clone();
                drop(g);
                if !try_send_ctl(&tx, &cancel, msg) {
                    self.fail_open(from, local_id, generation, "limit");
                    return Err("limit");
                }
                Ok(())
            }
            Err(OpenFail::Offline) => Err("offline"),
            Err(OpenFail::Limit) => Err("limit"),
            Err(OpenFail::SelfOpen) => Err("self"),
            Err(OpenFail::Invalid) => Err("invalid"),
        }
    }

    pub fn fail_open(&self, from: &str, local_id: u32, generation: u64, code: &'static str) {
        let mut g = self.lock();
        if g.peers.get(from).map(|p| p.generation) != Some(generation) {
            return;
        }
        let Some((remote_peer, remote_id)) = g.tunnels.timeout_open(from, local_id) else {
            return;
        };
        let opener = control_of(&g, from);
        let remote = control_of(&g, &remote_peer);
        drop(g);
        if let Some((tx, cancel)) = opener {
            try_send_ctl(&tx, &cancel, Outbound::json(open_failed(local_id, code)));
        }
        if let Some((tx, cancel)) = remote {
            // PROTOCOL closed-codes: remote | overflow | disconnect
            try_send_ctl(&tx, &cancel, Outbound::json(closed(remote_id, "remote")));
        }
    }

    pub fn accept_tunnel(&self, peer: &str, generation: u64, local_id: u32) -> Result<(), ()> {
        let mut g = self.lock();
        if g.peers.get(peer).map(|p| p.generation) != Some(generation) {
            return Err(());
        }
        match g.tunnels.accept(peer, local_id) {
            Ok((from, from_id)) => {
                let opener = control_of(&g, &from);
                drop(g);
                if let Some((tx, cancel)) = opener {
                    try_send_ctl(&tx, &cancel, Outbound::json(opened(from_id)));
                }
                Ok(())
            }
            Err(_) => Err(()),
        }
    }

    pub fn reject_tunnel(&self, peer: &str, generation: u64, local_id: u32) -> Result<(), ()> {
        let mut g = self.lock();
        if g.peers.get(peer).map(|p| p.generation) != Some(generation) {
            return Err(());
        }
        match g.tunnels.reject(peer, local_id) {
            Ok((from, from_id)) => {
                let opener = control_of(&g, &from);
                drop(g);
                if let Some((tx, cancel)) = opener {
                    try_send_ctl(
                        &tx,
                        &cancel,
                        Outbound::json(open_failed(from_id, "rejected")),
                    );
                }
                Ok(())
            }
            Err(_) => Err(()),
        }
    }

    pub fn close_tunnel(&self, peer: &str, generation: u64, local_id: u32, code: &'static str) {
        let mut g = self.lock();
        if g.peers.get(peer).map(|p| p.generation) != Some(generation) {
            return;
        }
        let Some((remote_peer, remote_id)) = g.tunnels.close(peer, local_id) else {
            return;
        };
        let remote = control_of(&g, &remote_peer);
        drop(g);
        if let Some((tx, cancel)) = remote {
            try_send_ctl(&tx, &cancel, Outbound::json(closed(remote_id, code)));
        }
    }

    /// Live-Steuernachricht (Postfach). Kurzer Timeout; bei Stau Verbindung kicken.
    pub async fn deliver_control(&self, peer_id: &str, msg: Outbound) -> bool {
        let pair = { control_of(&self.lock(), peer_id) };
        let Some((tx, cancel)) = pair else {
            return false;
        };
        match tokio::time::timeout(Duration::from_millis(CONTROL_PUSH_TIMEOUT_MS), tx.send(msg))
            .await
        {
            Ok(Ok(())) => true,
            Ok(Err(_)) => false,
            Err(_) => {
                let _ = cancel.send(true);
                false
            }
        }
    }

    /// Leitet ein Binärframe weiter. Volle Daten-Queue: warten, nach Timeout `overflow`.
    pub async fn forward_binary(&self, from: &str, generation: u64, local_id: u32, payload: &[u8]) {
        let looked_up = {
            let g = self.lock();
            if g.peers.get(from).map(|p| p.generation) != Some(generation) {
                None
            } else {
                g.tunnels.lookup(from, local_id).and_then(|end| {
                    let tx = g.peers.get(&end.remote_peer).map(|p| p.data.clone())?;
                    Some((tx, end.remote_id, end.remote_peer.clone()))
                })
            }
        };
        let Some((tx, remote_id, remote_peer)) = looked_up else {
            return;
        };
        let frame = crate::tunnel::encode_frame(remote_id, payload);
        match tokio::time::timeout(
            Duration::from_secs(FORWARD_TIMEOUT_SECS),
            tx.send(Outbound::Binary(bytes::Bytes::from(frame))),
        )
        .await
        {
            Ok(Ok(())) => {}
            _ => {
                self.close_tunnel(from, generation, local_id, "overflow");
                self.try_push_control(from, Outbound::json(closed(local_id, "overflow")));
                tracing::debug!(
                    from = %short_id(from),
                    to = %short_id(&remote_peer),
                    "overflow"
                );
            }
        }
    }

    fn try_push_control(&self, peer_id: &str, msg: Outbound) {
        let Some((tx, cancel)) = control_of(&self.lock(), peer_id) else {
            return;
        };
        try_send_ctl(&tx, &cancel, msg);
    }
}

fn control_of(g: &Inner, peer_id: &str) -> Option<(mpsc::Sender<Outbound>, watch::Sender<bool>)> {
    g.peers
        .get(peer_id)
        .map(|p| (p.control.clone(), p.cancel.clone()))
}

/// false = Kanal voll/tot → Gegenseite kicken (Client verbindet neu).
fn try_send_ctl(tx: &mpsc::Sender<Outbound>, cancel: &watch::Sender<bool>, msg: Outbound) -> bool {
    if tx.try_send(msg).is_err() {
        let _ = cancel.send(true);
        false
    } else {
        true
    }
}

fn detach_peer(g: &mut Inner, peer_id: &str, replaced: Option<&str>, pushes: &mut Vec<Push>) {
    let Some(slot) = g.peers.remove(peer_id) else {
        return;
    };
    let notify = g.tunnels.drop_peer(peer_id);
    for (remote, remote_id) in notify {
        if let Some(p) = g.peers.get(&remote) {
            pushes.push(Push {
                tx: p.control.clone(),
                cancel: p.cancel.clone(),
                msg: Outbound::json(closed(remote_id, "disconnect")),
            });
        }
    }
    let watch = slot.watch.clone();
    let mutual = mutual_set(g, peer_id, &watch);
    for other in mutual {
        if let Some(p) = g.peers.get(&other) {
            pushes.push(Push {
                tx: p.control.clone(),
                cancel: p.cancel.clone(),
                msg: Outbound::json(presence(peer_id, false)),
            });
        }
    }
    if let Some(code) = replaced {
        try_send_ctl(
            &slot.control,
            &slot.cancel,
            Outbound::json(crate::proto::error(code)),
        );
        let _ = slot.control.try_send(Outbound::Close);
        let _ = slot.cancel.send(true);
        tracing::info!(peer = %short_id(peer_id), "ersetzt");
    }
}

fn mutual_set(g: &Inner, me: &str, my_watch: &HashSet<String>) -> HashSet<String> {
    let mut out = HashSet::new();
    for other in my_watch {
        if other == me {
            continue;
        }
        if let Some(p) = g.peers.get(other)
            && p.watch.contains(me)
        {
            out.insert(other.clone());
        }
    }
    out
}

fn flush(pushes: Vec<Push>) {
    for p in pushes {
        try_send_ctl(&p.tx, &p.cancel, p.msg);
    }
}

/// Reine Präsenzlogik, ohne I/O — für Unit-Tests.
#[cfg(test)]
pub fn mutual_online(watches: &HashMap<String, HashSet<String>>, me: &str) -> Vec<String> {
    let Some(mine) = watches.get(me) else {
        return Vec::new();
    };
    let mut v: Vec<String> = mine
        .iter()
        .filter(|other| {
            *other != me && watches.get(*other).map(|w| w.contains(me)).unwrap_or(false)
        })
        .cloned()
        .collect();
    v.sort();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid(n: u8) -> String {
        format!("bt2_{}", hex::encode([n; 32]))
    }

    #[test]
    fn praesenz_nur_gegenseitig() {
        let a = pid(1);
        let b = pid(2);
        let c = pid(3);
        let mut w = HashMap::new();
        w.insert(a.clone(), HashSet::from([b.clone(), c.clone()]));
        w.insert(b.clone(), HashSet::from([a.clone()]));
        // C beobachtet A nicht.
        w.insert(c.clone(), HashSet::new());
        assert_eq!(mutual_online(&w, &a), vec![b.clone()]);
        assert_eq!(mutual_online(&w, &b), vec![a.clone()]);
        assert!(mutual_online(&w, &c).is_empty());

        w.get_mut(&c).unwrap().insert(a.clone());
        let mut both = mutual_online(&w, &a);
        both.sort();
        assert_eq!(both, vec![b.clone(), c.clone()]);
    }

    #[tokio::test]
    async fn register_ersetzt_alte_verbindung() {
        let hub = Hub::new();
        let (c1, mut rx1) = mpsc::channel(8);
        let (d1, _drx1) = mpsc::channel(8);
        let (cancel1, mut c1r) = watch::channel(false);
        hub.register(pid(1), "eins".into(), c1, d1, cancel1);
        let (c2, _rx2) = mpsc::channel(8);
        let (d2, _drx2) = mpsc::channel(8);
        let (cancel2, _c2r) = watch::channel(false);
        hub.register(pid(1), "zwei".into(), c2, d2, cancel2);
        assert!(*c1r.borrow() || c1r.changed().await.is_ok());
        let mut saw_replaced = false;
        while let Ok(msg) = rx1.try_recv() {
            if let Outbound::Text(t) = msg
                && t.contains("replaced")
            {
                saw_replaced = true;
            }
        }
        assert!(saw_replaced);
        assert_eq!(hub.online_count(), 1);
    }
}
