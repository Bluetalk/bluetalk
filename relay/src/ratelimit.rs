//! Token-Bucket (Bytes + Steuernachrichten) und Verbindungen pro IP.

use std::{
    collections::HashMap,
    net::IpAddr,
    sync::Mutex,
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
}
