//! Verbundene Geräte, Doppel-Login, gegenseitige Präsenz, Tunnel-Dispatch.
//!
//! Verbindungen laufen pro `(peerId, device)`. Watch-Listen sind **pro Verbindung**:
//! gegenseitig gilt, wenn mindestens ein Gerät des anderen die eigene Peer-ID
//! beobachtet. `online` = mindestens ein Gerät.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};

use tokio::sync::{mpsc, watch};

use crate::proto::{
    CONTROL_PUSH_TIMEOUT_MS, DeviceInfo, FORWARD_TIMEOUT_SECS, MAX_DEVICES_PER_PEER, Outbound,
    SYNC_HINT_INTERVAL_MS, closed, devices_event, incoming, open_failed, opened, presence,
    sync_hint,
};
use crate::tunnel::{OpenFail, Tunnels};
use crate::util::short_id;

pub struct ConnSlot {
    pub peer_id: String,
    pub device: String,
    pub device_name: String,
    pub name: String,
    pub control: mpsc::Sender<Outbound>,
    pub data: mpsc::Sender<Outbound>,
    pub cancel: watch::Sender<bool>,
    pub watch: HashSet<String>,
}

#[derive(Default)]
struct SyncHint {
    last_flush: Option<Instant>,
    pending_seq: Option<i64>,
    timer_armed: bool,
}

struct Inner {
    /// Generation → Verbindung.
    conns: HashMap<u64, ConnSlot>,
    /// peer_id → (device → generation).
    by_peer: HashMap<String, HashMap<String, u64>>,
    tunnels: Tunnels,
    next_gen: u64,
    /// Debounce für `{"t":"sync"}` pro Peer-ID (Konto).
    sync_hints: HashMap<String, SyncHint>,
}

pub struct Hub {
    inner: Mutex<Inner>,
}

pub struct RegisterSpec {
    pub peer_id: String,
    pub device: String,
    pub device_name: String,
    pub name: String,
}

pub struct RegisterResult {
    pub generation: u64,
    pub device: String,
    pub other_devices: Vec<DeviceInfo>,
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
                conns: HashMap::new(),
                by_peer: HashMap::new(),
                tunnels: Tunnels::default(),
                next_gen: 1,
                sync_hints: HashMap::new(),
            }),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Anzahl eindeutiger Peer-IDs mit mindestens einem Gerät.
    pub fn online_count(&self) -> usize {
        self.lock().by_peer.len()
    }

    /// Registriert die Verbindung. Gleiche `(peerId, device)` ersetzt die alte;
    /// das 9. Gerät verdrängt das am längsten verbundene.
    pub fn register(
        &self,
        spec: RegisterSpec,
        control: mpsc::Sender<Outbound>,
        data: mpsc::Sender<Outbound>,
        cancel: watch::Sender<bool>,
    ) -> RegisterResult {
        let mut g = self.lock();
        let generation = g.next_gen;
        g.next_gen += 1;
        let mut pushes = Vec::new();
        let old_mutual = mutual_peers(&g, &spec.peer_id);

        let same = g
            .by_peer
            .get(&spec.peer_id)
            .and_then(|m| m.get(&spec.device))
            .copied();
        if let Some(old_gen) = same {
            detach_conn(&mut g, old_gen, Some("replaced"), &mut pushes);
        } else if g.by_peer.get(&spec.peer_id).map(|m| m.len()).unwrap_or(0) >= MAX_DEVICES_PER_PEER
            && let Some(oldest) = g
                .by_peer
                .get(&spec.peer_id)
                .and_then(|m| m.values().copied().min())
        {
            detach_conn(&mut g, oldest, Some("replaced"), &mut pushes);
        }

        g.conns.insert(
            generation,
            ConnSlot {
                peer_id: spec.peer_id.clone(),
                device: spec.device.clone(),
                device_name: spec.device_name,
                name: spec.name,
                control,
                data,
                cancel,
                watch: HashSet::new(),
            },
        );
        g.by_peer
            .entry(spec.peer_id.clone())
            .or_default()
            .insert(spec.device.clone(), generation);

        let other_devices = other_devices(&g, &spec.peer_id, &spec.device);
        queue_own_devices(&g, &spec.peer_id, Some(generation), &mut pushes);
        queue_presence_diff(&g, &spec.peer_id, &old_mutual, &mut pushes);

        drop(g);
        flush(pushes);
        RegisterResult {
            generation,
            device: spec.device,
            other_devices,
        }
    }

    pub fn unregister(&self, peer_id: &str, generation: u64) {
        let mut g = self.lock();
        let Some(c) = g.conns.get(&generation) else {
            return;
        };
        if c.peer_id != peer_id {
            return;
        }
        let mut pushes = Vec::new();
        let old_mutual = mutual_peers(&g, peer_id);
        detach_conn(&mut g, generation, None, &mut pushes);
        queue_own_devices(&g, peer_id, None, &mut pushes);
        queue_presence_diff(&g, peer_id, &old_mutual, &mut pushes);
        if !g.by_peer.contains_key(peer_id) {
            g.sync_hints.remove(peer_id);
        }
        drop(g);
        flush(pushes);
    }

    /// Ersetzt die Watch-Liste dieser Verbindung. Liefert Snapshot an den Aufrufer.
    pub fn set_watch(&self, peer_id: &str, generation: u64, peers: Vec<String>) -> Vec<Outbound> {
        let mut g = self.lock();
        let Some(c) = g.conns.get(&generation) else {
            return Vec::new();
        };
        if c.peer_id != peer_id {
            return Vec::new();
        }
        let old_mutual = mutual_peers(&g, peer_id);
        if let Some(c) = g.conns.get_mut(&generation) {
            c.watch = peers.into_iter().collect();
        }
        let new_mutual = mutual_peers(&g, peer_id);
        let my_watch = g
            .conns
            .get(&generation)
            .map(|c| c.watch.clone())
            .unwrap_or_default();

        let mut snapshot = Vec::new();
        let mut pushes = Vec::new();
        for other in &my_watch {
            if new_mutual.contains(other) {
                let devices = device_list(&g, other);
                snapshot.push(Outbound::json(presence(other, true, &devices)));
            }
        }
        let my_devices = device_list(&g, peer_id);
        for q in old_mutual.difference(&new_mutual) {
            push_presence_to_watchers(&g, q, peer_id, false, &[], &mut pushes);
        }
        for q in new_mutual.difference(&old_mutual) {
            push_presence_to_watchers(&g, q, peer_id, true, &my_devices, &mut pushes);
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
        to_device: Option<&str>,
    ) -> Result<(), &'static str> {
        let mut g = self.lock();
        if !conn_matches(&g, from, generation) {
            return Err("invalid");
        }
        if from == to {
            return Err("self");
        }
        let name = g
            .conns
            .get(&generation)
            .map(|c| c.name.clone())
            .unwrap_or_default();
        let from_device = g
            .conns
            .get(&generation)
            .map(|c| c.device.clone())
            .unwrap_or_default();
        let target_gen = match to_device {
            Some(dev) => g.by_peer.get(to).and_then(|m| m.get(dev)).copied(),
            None => g.by_peer.get(to).and_then(|m| m.values().copied().max()),
        };
        let Some(target_gen) = target_gen else {
            return Err("offline");
        };
        let Some(target) = g.conns.get(&target_gen) else {
            return Err("offline");
        };
        let tx = target.control.clone();
        let cancel = target.cancel.clone();
        match g.tunnels.open(generation, from, local_id, target_gen, to) {
            Ok(ok) => {
                tracing::debug!(
                    from = %short_id(from),
                    to = %short_id(to),
                    tunnel = local_id,
                    remote = ok.remote_id,
                    "open"
                );
                let msg = Outbound::json(incoming(ok.remote_id, from, &from_device, &name));
                drop(g);
                if !try_send_ctl(&tx, &cancel, msg) {
                    self.fail_open(from, local_id, generation, "limit");
                    return Err("limit");
                }
                Ok(())
            }
            Err(OpenFail::Limit) => Err("limit"),
            Err(OpenFail::SelfOpen) => Err("self"),
            Err(OpenFail::Invalid) => Err("invalid"),
        }
    }

    pub fn fail_open(&self, from: &str, local_id: u32, generation: u64, code: &'static str) {
        let mut g = self.lock();
        if !conn_matches(&g, from, generation) {
            return;
        }
        let Some((remote_gen, remote_id)) = g.tunnels.timeout_open(generation, local_id) else {
            return;
        };
        let opener = control_of(&g, generation);
        let remote = control_of(&g, remote_gen);
        drop(g);
        if let Some((tx, cancel)) = opener {
            try_send_ctl(&tx, &cancel, Outbound::json(open_failed(local_id, code)));
        }
        if let Some((tx, cancel)) = remote {
            try_send_ctl(&tx, &cancel, Outbound::json(closed(remote_id, "remote")));
        }
    }

    pub fn accept_tunnel(&self, peer: &str, generation: u64, local_id: u32) -> Result<(), ()> {
        let mut g = self.lock();
        if !conn_matches(&g, peer, generation) {
            return Err(());
        }
        match g.tunnels.accept(generation, local_id) {
            Ok((from_gen, from_id)) => {
                let opener = control_of(&g, from_gen);
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
        if !conn_matches(&g, peer, generation) {
            return Err(());
        }
        match g.tunnels.reject(generation, local_id) {
            Ok((from_gen, from_id)) => {
                let opener = control_of(&g, from_gen);
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
        if !conn_matches(&g, peer, generation) {
            return;
        }
        let Some((remote_gen, remote_id)) = g.tunnels.close(generation, local_id) else {
            return;
        };
        let remote = control_of(&g, remote_gen);
        drop(g);
        if let Some((tx, cancel)) = remote {
            try_send_ctl(&tx, &cancel, Outbound::json(closed(remote_id, code)));
        }
    }

    /// Live-Steuernachricht (Postfach) an **alle** Geräte des Peers.
    /// true, wenn mindestens eine Zustellung geklappt hat.
    pub async fn deliver_control(&self, peer_id: &str, msg: Outbound) -> bool {
        let targets = {
            let g = self.lock();
            control_targets(&g, peer_id)
        };
        if targets.is_empty() {
            return false;
        }
        let mut any = false;
        for (tx, cancel) in targets {
            if send_ctl_wait(tx, cancel, msg.clone()).await {
                any = true;
            }
        }
        any
    }

    /// Leitet ein Binärframe weiter. Volle Daten-Queue: warten, nach Timeout `overflow`.
    pub async fn forward_binary(&self, from: &str, generation: u64, local_id: u32, payload: &[u8]) {
        let looked_up = {
            let g = self.lock();
            if !conn_matches(&g, from, generation) {
                None
            } else {
                g.tunnels.lookup(generation, local_id).and_then(|end| {
                    let slot = g.conns.get(&end.remote_gen)?;
                    Some((slot.data.clone(), end.remote_id, slot.peer_id.clone()))
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
                self.try_push_control(generation, Outbound::json(closed(local_id, "overflow")));
                tracing::debug!(
                    from = %short_id(from),
                    to = %short_id(&remote_peer),
                    "overflow"
                );
            }
        }
    }

    /// Nach erfolgreichem Sync-Push: Hinweis an alle Geräte, max. 1×/s, letzter Wert bleibt.
    pub fn notify_sync(self: &Arc<Self>, peer_id: &str, latest_seq: i64) {
        let mut g = self.lock();
        let hint = g.sync_hints.entry(peer_id.to_string()).or_default();
        hint.pending_seq = Some(latest_seq);
        let now = Instant::now();
        let wait = match hint.last_flush {
            None => Duration::ZERO,
            Some(t) => {
                let elapsed = now.saturating_duration_since(t);
                Duration::from_millis(SYNC_HINT_INTERVAL_MS).saturating_sub(elapsed)
            }
        };
        if hint.timer_armed && !wait.is_zero() {
            return;
        }
        if wait.is_zero() {
            hint.timer_armed = false;
            let seq = hint.pending_seq.take();
            hint.last_flush = Some(now);
            let targets = control_targets(&g, peer_id);
            drop(g);
            if let Some(seq) = seq {
                flush_sync(targets, seq);
            }
            return;
        }
        hint.timer_armed = true;
        drop(g);
        let hub = Arc::clone(self);
        let peer = peer_id.to_string();
        tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            hub.flush_sync_hint(&peer);
        });
    }

    fn flush_sync_hint(&self, peer_id: &str) {
        let mut g = self.lock();
        let Some(hint) = g.sync_hints.get_mut(peer_id) else {
            return;
        };
        hint.timer_armed = false;
        let Some(seq) = hint.pending_seq.take() else {
            return;
        };
        hint.last_flush = Some(Instant::now());
        let targets = control_targets(&g, peer_id);
        drop(g);
        flush_sync(targets, seq);
    }

    fn try_push_control(&self, generation: u64, msg: Outbound) {
        let Some((tx, cancel)) = control_of(&self.lock(), generation) else {
            return;
        };
        try_send_ctl(&tx, &cancel, msg);
    }
}

fn conn_matches(g: &Inner, peer_id: &str, generation: u64) -> bool {
    g.conns
        .get(&generation)
        .is_some_and(|c| c.peer_id == peer_id)
}

fn control_of(g: &Inner, generation: u64) -> Option<(mpsc::Sender<Outbound>, watch::Sender<bool>)> {
    g.conns
        .get(&generation)
        .map(|p| (p.control.clone(), p.cancel.clone()))
}

fn control_targets(g: &Inner, peer_id: &str) -> Vec<(mpsc::Sender<Outbound>, watch::Sender<bool>)> {
    let Some(map) = g.by_peer.get(peer_id) else {
        return Vec::new();
    };
    map.values()
        .filter_map(|gid| {
            g.conns
                .get(gid)
                .map(|c| (c.control.clone(), c.cancel.clone()))
        })
        .collect()
}

fn flush_sync(targets: Vec<(mpsc::Sender<Outbound>, watch::Sender<bool>)>, seq: i64) {
    let msg = Outbound::json(sync_hint(seq));
    for (tx, cancel) in targets {
        try_send_ctl(&tx, &cancel, msg.clone());
    }
}

async fn send_ctl_wait(
    tx: mpsc::Sender<Outbound>,
    cancel: watch::Sender<bool>,
    msg: Outbound,
) -> bool {
    match tx.try_send(msg) {
        Ok(()) => true,
        Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => false,
        Err(tokio::sync::mpsc::error::TrySendError::Full(m)) => {
            match tokio::time::timeout(Duration::from_millis(CONTROL_PUSH_TIMEOUT_MS), tx.send(m))
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
    }
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

fn detach_conn(g: &mut Inner, generation: u64, replaced: Option<&str>, pushes: &mut Vec<Push>) {
    let Some(slot) = g.conns.remove(&generation) else {
        return;
    };
    if let Some(map) = g.by_peer.get_mut(&slot.peer_id) {
        if map.get(&slot.device) == Some(&generation) {
            map.remove(&slot.device);
        }
        if map.is_empty() {
            g.by_peer.remove(&slot.peer_id);
        }
    }
    let notify = g.tunnels.drop_conn(generation);
    for (remote_gen, remote_id) in notify {
        if let Some(p) = g.conns.get(&remote_gen) {
            pushes.push(Push {
                tx: p.control.clone(),
                cancel: p.cancel.clone(),
                msg: Outbound::json(closed(remote_id, "disconnect")),
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
        tracing::info!(peer = %short_id(&slot.peer_id), device = %slot.device, "ersetzt");
    }
}

fn device_list(g: &Inner, peer_id: &str) -> Vec<DeviceInfo> {
    let mut v: Vec<DeviceInfo> = g
        .by_peer
        .get(peer_id)
        .into_iter()
        .flatten()
        .filter_map(|(dev, gid)| {
            g.conns.get(gid).map(|c| DeviceInfo {
                id: dev.clone(),
                name: c.device_name.clone(),
            })
        })
        .collect();
    v.sort_by(|a, b| a.id.cmp(&b.id));
    v
}

fn other_devices(g: &Inner, peer_id: &str, except: &str) -> Vec<DeviceInfo> {
    device_list(g, peer_id)
        .into_iter()
        .filter(|d| d.id != except)
        .collect()
}

fn union_watch(g: &Inner, peer_id: &str) -> HashSet<String> {
    let mut u = HashSet::new();
    let Some(map) = g.by_peer.get(peer_id) else {
        return u;
    };
    for gid in map.values() {
        if let Some(c) = g.conns.get(gid) {
            u.extend(c.watch.iter().cloned());
        }
    }
    u
}

fn peer_watches(g: &Inner, watcher: &str, target: &str) -> bool {
    let Some(map) = g.by_peer.get(watcher) else {
        return false;
    };
    map.values()
        .any(|gid| g.conns.get(gid).is_some_and(|c| c.watch.contains(target)))
}

fn mutual_peers(g: &Inner, me: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for other in union_watch(g, me) {
        if other == me {
            continue;
        }
        if peer_watches(g, &other, me) {
            out.insert(other);
        }
    }
    out
}

fn push_presence_to_watchers(
    g: &Inner,
    watcher_peer: &str,
    subject: &str,
    online: bool,
    devices: &[DeviceInfo],
    pushes: &mut Vec<Push>,
) {
    let Some(map) = g.by_peer.get(watcher_peer) else {
        return;
    };
    let gids: Vec<u64> = map.values().copied().collect();
    for gid in gids {
        let Some(c) = g.conns.get(&gid) else {
            continue;
        };
        if !c.watch.contains(subject) {
            continue;
        }
        pushes.push(Push {
            tx: c.control.clone(),
            cancel: c.cancel.clone(),
            msg: Outbound::json(presence(subject, online, devices)),
        });
    }
}

/// Geräteänderung oder Mutual-Wechsel: aktuelle Wahrheit an die Beobachter.
fn queue_presence_diff(
    g: &Inner,
    subject: &str,
    old_mutual: &HashSet<String>,
    pushes: &mut Vec<Push>,
) {
    let new_mutual = mutual_peers(g, subject);
    let devices = device_list(g, subject);
    let online = !devices.is_empty();
    for q in old_mutual.difference(&new_mutual) {
        push_presence_to_watchers(g, q, subject, false, &[], pushes);
    }
    if online {
        for q in &new_mutual {
            push_presence_to_watchers(g, q, subject, true, &devices, pushes);
        }
    }
}

fn queue_own_devices(g: &Inner, peer_id: &str, except_gen: Option<u64>, pushes: &mut Vec<Push>) {
    let all = device_list(g, peer_id);
    let Some(map) = g.by_peer.get(peer_id) else {
        return;
    };
    let entries: Vec<(String, u64)> = map.iter().map(|(d, gid)| (d.clone(), *gid)).collect();
    for (dev, gid) in entries {
        if Some(gid) == except_gen {
            continue;
        }
        let Some(c) = g.conns.get(&gid) else {
            continue;
        };
        let others: Vec<DeviceInfo> = all.iter().filter(|d| d.id != dev).cloned().collect();
        pushes.push(Push {
            tx: c.control.clone(),
            cancel: c.cancel.clone(),
            msg: Outbound::json(devices_event(&others)),
        });
    }
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
    use crate::proto::LEGACY_DEVICE;

    fn pid(n: u8) -> String {
        format!("bt2_{}", hex::encode([n; 32]))
    }

    fn dev(n: u8) -> String {
        format!("device-{n:02}")
    }

    fn spec(peer: String, device: &str, name: &str) -> RegisterSpec {
        RegisterSpec {
            peer_id: peer,
            device: device.to_string(),
            device_name: name.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn praesenz_nur_gegenseitig() {
        let a = pid(1);
        let b = pid(2);
        let c = pid(3);
        let mut w = HashMap::new();
        w.insert(a.clone(), HashSet::from([b.clone(), c.clone()]));
        w.insert(b.clone(), HashSet::from([a.clone()]));
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
        hub.register(spec(pid(1), LEGACY_DEVICE, "eins"), c1, d1, cancel1);
        let (c2, _rx2) = mpsc::channel(8);
        let (d2, _drx2) = mpsc::channel(8);
        let (cancel2, _c2r) = watch::channel(false);
        hub.register(spec(pid(1), LEGACY_DEVICE, "zwei"), c2, d2, cancel2);
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

    #[tokio::test]
    async fn zwei_geraete_parallel() {
        let hub = Hub::new();
        let (c1, mut rx1) = mpsc::channel(8);
        let (d1, _drx1) = mpsc::channel(8);
        let (cancel1, c1r) = watch::channel(false);
        let r1 = hub.register(spec(pid(1), &dev(1), "eins"), c1, d1, cancel1);
        assert!(r1.other_devices.is_empty());
        let (c2, _rx2) = mpsc::channel(8);
        let (d2, _drx2) = mpsc::channel(8);
        let (cancel2, _c2r) = watch::channel(false);
        let r2 = hub.register(spec(pid(1), &dev(2), "zwei"), c2, d2, cancel2);
        assert_eq!(r2.other_devices.len(), 1);
        assert_eq!(r2.other_devices[0].id, dev(1));
        assert!(!*c1r.borrow());
        let mut saw_devices = false;
        while let Ok(msg) = rx1.try_recv() {
            if let Outbound::Text(t) = msg
                && t.contains("\"t\":\"devices\"")
            {
                saw_devices = true;
                assert!(t.contains(&dev(2)));
            }
        }
        assert!(saw_devices);
        assert_eq!(hub.online_count(), 1);
        hub.unregister(&pid(1), r1.generation);
        hub.unregister(&pid(1), r2.generation);
        assert_eq!(hub.online_count(), 0);
    }

    #[tokio::test]
    async fn neuntes_geraet_verdraengt_aeltestes() {
        let hub = Hub::new();
        let mut first_rx = None;
        let mut first_cancel = None;
        let mut gens = Vec::new();
        for i in 1u8..=8 {
            let (c, rx) = mpsc::channel(8);
            let (d, _) = mpsc::channel(8);
            let (cancel, cr) = watch::channel(false);
            let r = hub.register(spec(pid(1), &dev(i), "n"), c, d, cancel);
            gens.push(r.generation);
            if i == 1 {
                first_rx = Some(rx);
                first_cancel = Some(cr);
            }
        }
        assert_eq!(hub.online_count(), 1);
        let (c9, _rx9) = mpsc::channel(8);
        let (d9, _) = mpsc::channel(8);
        let (cancel9, _) = watch::channel(false);
        hub.register(spec(pid(1), &dev(9), "n"), c9, d9, cancel9);
        let mut cr = first_cancel.expect("c1");
        assert!(*cr.borrow() || cr.changed().await.is_ok());
        let mut saw_replaced = false;
        let mut rx1 = first_rx.expect("rx1");
        while let Ok(msg) = rx1.try_recv() {
            if let Outbound::Text(t) = msg
                && t.contains("replaced")
            {
                saw_replaced = true;
            }
        }
        assert!(saw_replaced);
        hub.unregister(&pid(1), gens[0]);
        assert_eq!(hub.online_count(), 1);
    }
}
