//! Token-Bucket (Bytes + Steuernachrichten) und Verbindungen pro IP.

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub struct TokenBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(rate: f64, burst: f64) -> Self {
        Self {
            rate,
            burst,
            tokens: burst,
            last: Instant::now(),
        }
    }

    pub fn try_take(&mut self, amount: f64) -> bool {
        if amount <= 0.0 {
            return true;
        }
        self.refill();
        if self.tokens >= amount {
            self.tokens -= amount;
            true
        } else {
            false
        }
    }

    /// Tokens abziehen. Reicht der Stand nicht, Schuld und Wartezeit bis Nachlauf.
    pub fn take_or_wait(&mut self, amount: f64) -> Duration {
        if amount <= 0.0 {
            return Duration::ZERO;
        }
        self.refill();
        if self.tokens >= amount {
            self.tokens -= amount;
            Duration::ZERO
        } else {
            let deficit = amount - self.tokens;
            self.tokens -= amount;
            let secs = deficit / self.rate.max(1e-9);
            Duration::from_secs_f64(secs.max(0.0))
        }
    }

    fn refill(&mut self) {
        let now = Instant::now();
        let dt = now.saturating_duration_since(self.last).as_secs_f64();
        self.last = now;
        self.tokens = (self.tokens + dt * self.rate).min(self.burst);
    }
}

pub struct IpLimiter {
    max: u32,
    counts: Mutex<HashMap<IpAddr, u32>>,
}

impl IpLimiter {
    pub fn new(max: u32) -> Self {
        Self {
            max,
            counts: Mutex::new(HashMap::new()),
        }
    }

    pub fn try_acquire(&self, ip: IpAddr) -> bool {
        let mut g = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        let entry = g.entry(ip).or_insert(0);
        if *entry >= self.max {
            false
        } else {
            *entry += 1;
            true
        }
    }

    pub fn release(&self, ip: IpAddr) {
        let mut g = self.counts.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(c) = g.get_mut(&ip) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                g.remove(&ip);
            }
        }
    }
}

pub struct IpGuard {
    limiter: std::sync::Arc<IpLimiter>,
    ip: IpAddr,
}

impl IpGuard {
    pub fn new(limiter: std::sync::Arc<IpLimiter>, ip: IpAddr) -> Option<Self> {
        if limiter.try_acquire(ip) {
            Some(Self { limiter, ip })
        } else {
            None
        }
    }
}

impl Drop for IpGuard {
    fn drop(&mut self) {
        self.limiter.release(self.ip);
    }
}

/// Obergrenze: neue Schlüssel ablehnen, bestehende Zähler nie löschen.
const WINDOW_MAX_KEYS: usize = 50_000;

/// Gleitendes Fenster: max. `n` Ereignisse pro Schlüssel in `window`.
pub struct WindowLimiter {
    inner: Mutex<WindowInner>,
    clock: Option<Clock>,
}

type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

struct WindowBucket {
    events: Vec<Instant>,
    window: Duration,
}

struct WindowInner {
    map: HashMap<String, WindowBucket>,
    ops: u64,
}

impl WindowLimiter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WindowInner {
                map: HashMap::new(),
                ops: 0,
            }),
            clock: None,
        }
    }

    fn now(&self) -> Instant {
        match &self.clock {
            Some(clock) => clock(),
            None => Instant::now(),
        }
    }

    /// `true` = erlaubt (Ereignis gezählt).
    pub fn allow(&self, key: &str, max: usize, window: Duration) -> bool {
        let now = self.now();
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.ops = g.ops.wrapping_add(1);
        if g.ops.is_multiple_of(2048) {
            sweep(&mut g.map, now);
        }
        if let Some(bucket) = g.map.get_mut(key) {
            bucket.window = window;
            bucket
                .events
                .retain(|t| now.saturating_duration_since(*t) < window);
            if bucket.events.len() >= max {
                return false;
            }
            bucket.events.push(now);
            return true;
        }
        if g.map.len() >= WINDOW_MAX_KEYS {
            sweep(&mut g.map, now);
        }
        if g.map.len() >= WINDOW_MAX_KEYS {
            return false;
        }
        g.map.insert(
            key.to_string(),
            WindowBucket {
                events: vec![now],
                window,
            },
        );
        true
    }
}

fn sweep(map: &mut HashMap<String, WindowBucket>, now: Instant) {
    map.retain(|_, bucket| {
        bucket
            .events
            .retain(|t| now.saturating_duration_since(*t) < bucket.window);
        !bucket.events.is_empty()
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn take_or_wait_sofort_wenn_tokens_reichen() {
        let mut b = TokenBucket::new(10_000.0, 100.0);
        assert_eq!(b.take_or_wait(40.0), Duration::ZERO);
        assert_eq!(b.take_or_wait(40.0), Duration::ZERO);
    }

    #[test]
    fn take_or_wait_drosselt_statt_abzulehnen() {
        let mut b = TokenBucket::new(10_000.0, 100.0);
        assert_eq!(b.take_or_wait(100.0), Duration::ZERO);
        let wait = b.take_or_wait(100.0);
        assert!(
            wait >= Duration::from_millis(9) && wait <= Duration::from_millis(15),
            "wait={wait:?}"
        );
        std::thread::sleep(wait + Duration::from_millis(3));
        assert_eq!(b.take_or_wait(10.0), Duration::ZERO);
    }

    #[test]
    fn try_take_lehnt_ab_wenn_leer() {
        let mut b = TokenBucket::new(1.0, 10.0);
        assert!(b.try_take(10.0));
        assert!(!b.try_take(1.0));
    }

    #[test]
    fn window_limiter_zaehlt_und_sperrt() {
        let w = WindowLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..3 {
            assert!(w.allow("k", 3, window));
        }
        assert!(!w.allow("k", 3, window));
        assert!(w.allow("other", 3, window));
    }

    fn limiter_at(offset_ms: Arc<std::sync::atomic::AtomicU64>) -> WindowLimiter {
        let base = Instant::now();
        WindowLimiter {
            inner: Mutex::new(WindowInner {
                map: HashMap::new(),
                ops: 0,
            }),
            clock: Some(Arc::new(move || {
                base + Duration::from_millis(offset_ms.load(std::sync::atomic::Ordering::SeqCst))
            })),
        }
    }

    impl WindowLimiter {
        fn sweep_now(&self) {
            let now = self.now();
            let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            sweep(&mut g.map, now);
        }
    }

    #[test]
    fn window_limiter_langes_fenster_ueberlebt_kurzen_sweep() {
        let offset = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let w = limiter_at(offset.clone());
        let hour = Duration::from_secs(3600);
        let minute = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(w.allow("reg:1.2.3.4", 5, hour));
        }
        assert!(!w.allow("reg:1.2.3.4", 5, hour));
        assert!(w.allow("login-ip:1.2.3.4", 5, minute));

        offset.store(61_000, std::sync::atomic::Ordering::SeqCst);
        w.sweep_now();
        assert!(
            !w.allow("reg:1.2.3.4", 5, hour),
            "Register-Limit (1 h) darf nach 61 s Sweep nicht fallen"
        );
        assert!(
            w.allow("login-ip:1.2.3.4", 5, minute),
            "60s-Fenster darf nach 61 s leer sein"
        );
    }

    #[test]
    fn window_limiter_flut_setzt_bestehende_zaehler_nicht_zurueck() {
        let w = WindowLimiter::new();
        let window = Duration::from_secs(60);
        for _ in 0..5 {
            assert!(w.allow("login-user:alice", 5, window));
        }
        assert!(!w.allow("login-user:alice", 5, window));

        let mut accepted = 0usize;
        for i in 0..WINDOW_MAX_KEYS + 32 {
            if w.allow(&format!("flood-{i}"), 3, window) {
                accepted += 1;
            }
        }
        assert!(
            accepted <= WINDOW_MAX_KEYS,
            "neue Keys dürfen die Karte nicht unbegrenzt füllen"
        );
        assert!(
            !w.allow("login-user:alice", 5, window),
            "bestehender Zähler darf durch Flut nicht verschwinden"
        );
        assert!(
            !w.allow("flood-neu", 3, window),
            "übervolle Karte lehnt neue Keys ab statt zu leeren"
        );
    }
}
