//! Reine Hilfsfunktionen: Wert-Konvertierung, Adress-/Endpunkt-Normalisierung,
//! lokale IPs, Datei-ID/Base64-Prüfung und Sanitizing.

use super::*;

pub(super) fn peer_info_to_value(info: &bluetalk_network::PeerInfo) -> Value {
    let (address, port) = match info.remote_address.parse::<SocketAddr>() {
        Ok(addr) => (addr.ip().to_string(), addr.port()),
        Err(_) => (info.remote_address.clone(), 0),
    };
    json!({
        "id": info.peer_id,
        "name": info.display_name,
        "address": address,
        "port": port,
        "ports": if port == 0 { Vec::new() } else { vec![port] },
        "connectedAt": info.connected_at_ms,
        "direction": info.direction,
        "encrypted": info.authenticated_encryption,
        "supportsHeartbeat": true,
    })
}

pub(super) fn hosted_file_summary(file: &HostedFile) -> Value {
    json!({
        "id": file.id,
        "name": file.name,
        "size": file.size,
        "type": file.mime_type,
        "createdAt": file.created_at,
    })
}

pub(super) fn extract_connect_target(target: &Value) -> Result<(String, Option<String>)> {
    match target {
        Value::String(address) => Ok((normalize_connect_address(address)?, None)),
        Value::Object(map) => {
            let peer_id = map
                .get("id")
                .or_else(|| map.get("peerId"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            let address = map
                .get("address")
                .and_then(Value::as_str)
                .map(normalize_connect_address)
                .transpose()?
                .unwrap_or_default();
            if address.is_empty() && peer_id.is_none() {
                return Err(AppError::InvalidInput(
                    "connect target needs an address or peer id".to_owned(),
                ));
            }
            Ok((address, peer_id))
        }
        _ => Err(AppError::InvalidInput("invalid connect target".to_owned())),
    }
}

/// Accepts `host`, `host:port`, and `scheme://host:port` inputs and returns a
/// dialable `host:port` string (default port appended when missing).
pub fn normalize_connect_address(raw: &str) -> Result<String> {
    let mut input = raw.trim().to_owned();
    input.retain(|character| !character.is_whitespace());
    if input.is_empty() || input.len() > 512 {
        return Err(AppError::InvalidInput("invalid address".to_owned()));
    }
    for prefix in ["tcp://", "ws://", "wss://", "http://", "https://"] {
        if let Some(stripped) = input.strip_prefix(prefix) {
            input = stripped.to_owned();
            break;
        }
    }
    if let Some(stripped) = input.strip_suffix("/bt/ws") {
        input = stripped.to_owned();
    }
    let input = input.trim_end_matches('/');

    if let Ok(address) = input.parse::<SocketAddr>() {
        return Ok(address.to_string());
    }
    if let Ok(ip) = input.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, DEFAULT_LISTEN_PORT).to_string());
    }
    // host:port with a plain IPv4/hostname
    if let Some((host, port)) = input.rsplit_once(':') {
        if let Ok(port) = port.parse::<u16>() {
            if port > 0 && is_plausible_host(host) {
                return Ok(format!("{host}:{port}"));
            }
        }
    }
    if is_plausible_host(input) {
        return Ok(format!("{input}:{DEFAULT_LISTEN_PORT}"));
    }
    Err(AppError::InvalidInput("invalid address".to_owned()))
}

pub(super) fn is_plausible_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

pub(super) fn normalize_connect_error(error: &str) -> String {
    if error.contains("timed out") || error.contains("refused") || error.contains("unreachable") {
        "Connection failed".to_owned()
    } else {
        error.to_owned()
    }
}

pub(super) fn parse_tcp_endpoint(endpoint: &str) -> Option<SocketAddr> {
    endpoint
        .strip_prefix("tcp://")
        .unwrap_or(endpoint)
        .trim_end_matches('/')
        .parse()
        .ok()
}

pub fn local_ipv4_addresses() -> Vec<Ipv4Addr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) => Some(v4.ip),
            _ => None,
        })
        .collect()
}

pub(super) fn local_broadcast_addresses() -> Vec<Ipv4Addr> {
    let Ok(interfaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    interfaces
        .into_iter()
        .filter(|interface| !interface.is_loopback())
        .filter_map(|interface| match interface.addr {
            if_addrs::IfAddr::V4(v4) => v4.broadcast,
            _ => None,
        })
        .collect()
}

pub(super) fn is_strict_base64(value: &str) -> bool {
    !value.is_empty()
        && value.len() % 4 == 0
        && value.len() <= 12 * 1024 * 1024
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

pub(super) fn is_valid_file_id(file_id: &str) -> bool {
    file_id.len() == 24 && file_id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn random_file_id() -> Result<String> {
    let mut bytes = [0_u8; 12];
    rand::fill(&mut bytes);
    Ok(hex::encode(bytes))
}

pub(super) fn sanitize_download_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|character| !matches!(character, '\r' | '\n' | '"' | '\\' | '/'))
        .take(180)
        .collect();
    if cleaned.trim().is_empty() {
        "download.bin".to_owned()
    } else {
        cleaned
    }
}

pub(super) fn sanitize_content_type(mime_type: &str) -> String {
    let candidate = mime_type.trim();
    let valid = candidate.len() <= 120
        && candidate.split_once('/').is_some_and(|(kind, subtype)| {
            !kind.is_empty()
                && !subtype.is_empty()
                && candidate
                    .bytes()
                    .all(|byte| byte.is_ascii_graphic() && byte != b'"')
        });
    if valid {
        candidate.to_owned()
    } else {
        "application/octet-stream".to_owned()
    }
}

pub(super) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}
