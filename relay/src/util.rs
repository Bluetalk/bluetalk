//! Kleine Helfer: Peer-IDs, Host-Normalisierung, Zeit.

use std::{
    net::IpAddr,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::http::HeaderMap;
use rand::RngCore;

pub fn unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_bytes(buf: &mut [u8]) {
    if getrandom::fill(buf).is_err() {
        rand::rng().fill_bytes(buf);
    }
}

/// XOR-Faltung, gleiche Länge vorausgesetzt.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        d |= x ^ y;
    }
    d == 0
}

/// Gekürzte Peer-ID für Logs (`bt2_` + 8 Hex-Zeichen).
pub fn short_id(peer_id: &str) -> &str {
    if peer_id.len() >= 12 {
        &peer_id[..12]
    } else {
        peer_id
    }
}

/// Host klein, ohne Standardport 80/443.
pub fn normalize_host(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    if let Some(stripped) = strip_default_port(&s, ":443") {
        return stripped;
    }
    if let Some(stripped) = strip_default_port(&s, ":80") {
        return stripped;
    }
    s
}

fn strip_default_port(host: &str, suffix: &str) -> Option<String> {
    let stripped = host.strip_suffix(suffix)?;
    if stripped.ends_with(']') || !stripped.contains(':') {
        Some(stripped.to_string())
    } else {
        None
    }
}

/// `bt2_` + 64 Kleinbuchstaben-Hex.
pub fn parse_peer_id(raw: &str) -> Option<String> {
    if raw.len() != 68 || !raw.starts_with("bt2_") {
        return None;
    }
    let hex = &raw[4..];
    if !hex.as_bytes().iter().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("bt2_{}", hex.to_ascii_lowercase()))
}

pub fn valid_name(name: &str) -> bool {
    name.chars().count() <= 64
}

/// Geräte-ID: 8–64 Zeichen `[A-Za-z0-9_-]`. `"legacy"` ist der Default ohne Feld,
/// nicht Teil dieser Regex (zu kurz).
pub fn valid_device_id(id: &str) -> bool {
    let n = id.len();
    (8..=64).contains(&n)
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// UUID (8-4-4-4-12, hex) oder ein knapper druckbarer Bezeichner.
pub fn valid_mail_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    if id.len() == 36 {
        let b = id.as_bytes();
        return b[8] == b'-'
            && b[13] == b'-'
            && b[18] == b'-'
            && b[23] == b'-'
            && id
                .bytes()
                .enumerate()
                .all(|(i, c)| matches!(i, 8 | 13 | 18 | 23) || c.is_ascii_hexdigit());
    }
    id.bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Client-IP: `CLIENT_IP_HEADER` (genau dieser Header), sonst bei TRUST_PROXY
/// das letzte `X-Forwarded-For`-Element (vom nächsten Proxy angehängt), sonst Socket.
pub fn client_ip(
    headers: &HeaderMap,
    socket: std::net::SocketAddr,
    trust_proxy: bool,
    client_ip_header: Option<&str>,
) -> IpAddr {
    let fallback = socket.ip().to_canonical();
    if let Some(name) = client_ip_header {
        return header_ip(headers, name).unwrap_or(fallback);
    }
    if !trust_proxy {
        return fallback;
    }
    let Some(value) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) else {
        return fallback;
    };
    let last = value
        .split(',')
        .map(str::trim)
        .rfind(|s| !s.is_empty())
        .unwrap_or("");
    last.parse::<IpAddr>()
        .map(|ip| ip.to_canonical())
        .unwrap_or(fallback)
}

fn header_ip(headers: &HeaderMap, name: &str) -> Option<IpAddr> {
    let value = headers.get(name)?.to_str().ok()?.trim();
    value.parse::<IpAddr>().ok().map(|ip| ip.to_canonical())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_konstante_zeit() {
        assert!(ct_eq(b"abcd", b"abcd"));
        assert!(!ct_eq(b"abcd", b"abce"));
        assert!(!ct_eq(b"ab", b"abcd"));
    }

    #[test]
    fn host_stript_standardports() {
        assert_eq!(normalize_host("BT.Henny.Dev"), "bt.henny.dev");
        assert_eq!(normalize_host("bt.henny.dev:443"), "bt.henny.dev");
        assert_eq!(normalize_host("example.com:80"), "example.com");
        assert_eq!(normalize_host("example.com:8080"), "example.com:8080");
        assert_eq!(normalize_host("[::1]:443"), "[::1]");
        assert_eq!(normalize_host("[::1]:8080"), "[::1]:8080");
    }

    #[test]
    fn device_id_format() {
        assert!(valid_device_id("testdev-1"));
        assert!(valid_device_id(&"A".repeat(8)));
        assert!(valid_device_id(&"x".repeat(64)));
        assert!(!valid_device_id("legacy"));
        assert!(!valid_device_id("short"));
        assert!(!valid_device_id(&"x".repeat(65)));
        assert!(!valid_device_id("bad device"));
        assert!(!valid_device_id("dev/ice1"));
    }

    #[test]
    fn peer_id_nur_bt2_hex() {
        let ok = format!("bt2_{}", "ab".repeat(32));
        assert_eq!(parse_peer_id(&ok).as_deref(), Some(ok.as_str()));
        assert!(parse_peer_id("bt2_short").is_none());
        assert!(parse_peer_id(&format!("BT2_{}", "ab".repeat(32))).is_none());
        let mixed = format!("bt2_{}", "AB".repeat(32));
        assert_eq!(parse_peer_id(&mixed).as_deref(), Some(ok.as_str()));
    }

    fn sock(ip: &str) -> std::net::SocketAddr {
        format!("{ip}:1234").parse().unwrap()
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn client_ip_ohne_proxy_ist_socket() {
        let spoofed = headers(&[("x-forwarded-for", "198.51.100.1")]);
        let ip = client_ip(&spoofed, sock("10.0.0.9"), false, None);
        assert_eq!(ip, "10.0.0.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn client_ip_header_genau_dieser_header() {
        let h = headers(&[
            ("cf-connecting-ip", "203.0.113.9"),
            ("x-forwarded-for", "198.51.100.1, 10.0.0.1"),
        ]);
        let ip = client_ip(&h, sock("127.0.0.1"), true, Some("cf-connecting-ip"));
        assert_eq!(ip, "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn client_ip_header_fehlt_dann_socket() {
        let h = headers(&[("x-forwarded-for", "198.51.100.1")]);
        let ip = client_ip(&h, sock("192.0.2.1"), true, Some("cf-connecting-ip"));
        assert_eq!(ip, "192.0.2.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn client_ip_trust_proxy_nimmt_letztes_xff() {
        let h = headers(&[("x-forwarded-for", "198.51.100.1, 8.8.8.8, 203.0.113.50")]);
        let ip = client_ip(&h, sock("127.0.0.1"), true, None);
        assert_eq!(ip, "203.0.113.50".parse::<IpAddr>().unwrap());
        assert_ne!(ip, "198.51.100.1".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn client_ip_header_ipv6() {
        let h = headers(&[("cf-connecting-ip", "2001:db8::1")]);
        let ip = client_ip(&h, sock("127.0.0.1"), false, Some("cf-connecting-ip"));
        assert_eq!(ip, "2001:db8::1".parse::<IpAddr>().unwrap());
    }
}
