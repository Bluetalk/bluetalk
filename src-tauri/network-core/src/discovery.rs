use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use url::{Host, Url};

use crate::{
    DiscoveredPeer, NetworkError, NetworkIdentity, Result,
    identity::{peer_id_for_public_key, random_hex},
    protocol::{PROTOCOL_VERSION, unix_time_ms},
};

const DISCOVERY_MAGIC: &str = "BLUETALK_DISCOVERY";
const DISCOVERY_ENVELOPE_VERSION: u8 = 1;
const SIGNATURE_DOMAIN: &[u8] = b"BlueTalk/v2/discovery/1\0";
const MAX_ENDPOINTS: usize = 16;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedAnnouncement {
    magic: String,
    envelope_version: u8,
    protocol_versions: Vec<u16>,
    peer_id: String,
    identity_key: String,
    display_name: String,
    endpoints: Vec<String>,
    timestamp_ms: i64,
    nonce: String,
    signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignatureBody<'a> {
    magic: &'a str,
    envelope_version: u8,
    protocol_versions: &'a [u16],
    peer_id: &'a str,
    identity_key: &'a str,
    display_name: &'a str,
    endpoints: &'a [String],
    timestamp_ms: i64,
    nonce: &'a str,
}

pub(crate) struct VerifiedAnnouncement {
    pub peer: DiscoveredPeer,
    pub replay_key: String,
}

pub(crate) fn create_announcement(
    identity: &NetworkIdentity,
    display_name: &str,
    endpoints: &[String],
) -> Result<Vec<u8>> {
    create_announcement_at(identity, display_name, endpoints, unix_time_ms())
}

fn create_announcement_at(
    identity: &NetworkIdentity,
    display_name: &str,
    endpoints: &[String],
    timestamp_ms: i64,
) -> Result<Vec<u8>> {
    validate_display_name(display_name)?;
    validate_endpoints(endpoints, None)?;
    let mut announcement = SignedAnnouncement {
        magic: DISCOVERY_MAGIC.to_owned(),
        envelope_version: DISCOVERY_ENVELOPE_VERSION,
        protocol_versions: vec![PROTOCOL_VERSION],
        peer_id: identity.peer_id(),
        identity_key: BASE64.encode(identity.public_key_bytes()),
        display_name: display_name.to_owned(),
        endpoints: endpoints.to_vec(),
        timestamp_ms,
        nonce: random_hex(16)?,
        signature: String::new(),
    };
    announcement.signature = BASE64.encode(identity.sign(&signature_input(&announcement)?));
    Ok(serde_json::to_vec(&announcement)?)
}

pub(crate) fn verify_announcement(
    packet: &[u8],
    observed_from: SocketAddr,
    max_packet_bytes: usize,
    max_clock_skew: Duration,
) -> Result<VerifiedAnnouncement> {
    if packet.len() > max_packet_bytes {
        return Err(NetworkError::Discovery(format!(
            "packet is {} bytes; maximum is {max_packet_bytes}",
            packet.len()
        )));
    }
    let announcement: SignedAnnouncement = serde_json::from_slice(packet)
        .map_err(|error| NetworkError::Discovery(format!("invalid JSON: {error}")))?;
    if announcement.magic != DISCOVERY_MAGIC {
        return Err(NetworkError::Discovery("incorrect discovery magic".to_owned()));
    }
    if announcement.envelope_version != DISCOVERY_ENVELOPE_VERSION {
        return Err(NetworkError::Discovery(format!(
            "unsupported discovery envelope {}",
            announcement.envelope_version
        )));
    }
    if !announcement
        .protocol_versions
        .contains(&PROTOCOL_VERSION)
        || announcement.protocol_versions.is_empty()
        || announcement.protocol_versions.len() > 16
    {
        return Err(NetworkError::Discovery(
            "announcement does not offer a supported protocol".to_owned(),
        ));
    }
    validate_display_name(&announcement.display_name)?;
    let endpoints = validate_endpoints(&announcement.endpoints, Some(observed_from.ip()))?;

    let allowed_skew_ms = max_clock_skew.as_millis().min(i64::MAX as u128) as u64;
    if unix_time_ms().abs_diff(announcement.timestamp_ms) > allowed_skew_ms {
        return Err(NetworkError::Discovery(
            "announcement timestamp is outside the permitted clock skew".to_owned(),
        ));
    }
    if announcement.nonce.len() != 32
        || hex::decode(&announcement.nonce).map_or(true, |value| value.len() != 16)
    {
        return Err(NetworkError::Discovery(
            "announcement nonce must contain 16 random bytes".to_owned(),
        ));
    }

    let identity_key = decode_array::<32>(&announcement.identity_key, "identity key")?;
    let derived_peer_id = peer_id_for_public_key(&identity_key);
    if announcement.peer_id != derived_peer_id {
        return Err(NetworkError::Discovery(
            "peer id does not match the advertised identity key".to_owned(),
        ));
    }
    let signature = decode_array::<64>(&announcement.signature, "signature")?;
    NetworkIdentity::verify(
        &identity_key,
        &signature_input(&announcement)?,
        &signature,
    )
    .map_err(|_| NetworkError::Discovery("announcement signature is invalid".to_owned()))?;

    let replay_key = format!("{}:{}", announcement.peer_id, announcement.nonce);
    Ok(VerifiedAnnouncement {
        peer: DiscoveredPeer {
            peer_id: announcement.peer_id,
            display_name: announcement.display_name,
            endpoints,
            observed_from: observed_from.to_string(),
            advertised_at_ms: announcement.timestamp_ms,
            protocol_versions: announcement.protocol_versions,
        },
        replay_key,
    })
}

fn signature_input(announcement: &SignedAnnouncement) -> Result<Vec<u8>> {
    let body = SignatureBody {
        magic: &announcement.magic,
        envelope_version: announcement.envelope_version,
        protocol_versions: &announcement.protocol_versions,
        peer_id: &announcement.peer_id,
        identity_key: &announcement.identity_key,
        display_name: &announcement.display_name,
        endpoints: &announcement.endpoints,
        timestamp_ms: announcement.timestamp_ms,
        nonce: &announcement.nonce,
    };
    let mut bytes = SIGNATURE_DOMAIN.to_vec();
    bytes.extend_from_slice(&serde_json::to_vec(&body)?);
    Ok(bytes)
}

fn validate_display_name(display_name: &str) -> Result<()> {
    if display_name.is_empty() || display_name.len() > 128 {
        return Err(NetworkError::Discovery(
            "display name must contain 1..=128 UTF-8 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_endpoints(endpoints: &[String], observed_ip: Option<IpAddr>) -> Result<Vec<String>> {
    if endpoints.is_empty() || endpoints.len() > MAX_ENDPOINTS {
        return Err(NetworkError::Discovery(format!(
            "announcement must contain 1..={MAX_ENDPOINTS} endpoints"
        )));
    }
    let mut validated = Vec::with_capacity(endpoints.len());
    for endpoint in endpoints {
        if endpoint.len() > 512 {
            return Err(NetworkError::Discovery(
                "endpoint exceeds 512 bytes".to_owned(),
            ));
        }
        let url = Url::parse(endpoint)
            .map_err(|error| NetworkError::Discovery(format!("invalid endpoint: {error}")))?;
        if url.scheme() != "tcp"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.path() != "" && url.path() != "/")
            || url.port().is_none()
        {
            return Err(NetworkError::Discovery(
                "endpoints must be plain tcp://host:port URLs".to_owned(),
            ));
        }
        let host = url
            .host()
            .ok_or_else(|| NetworkError::Discovery("endpoint has no host".to_owned()))?;
        // `tcp` is not a special URL scheme, so IP literals surface as
        // `Host::Domain` and must be parsed explicitly.
        let unspecified = match &host {
            Host::Ipv4(address) => address.is_unspecified(),
            Host::Ipv6(address) => address.is_unspecified(),
            Host::Domain(domain) => domain
                .parse::<IpAddr>()
                .map(|address| address.is_unspecified())
                .unwrap_or(false),
        };
        let port = url.port().expect("port checked above");
        // When creating our own announcement (no observed IP) the unspecified
        // host stays as-is; receivers replace it with the UDP source address.
        let normalized_host = match (unspecified, observed_ip) {
            (true, Some(replacement)) => replacement.to_string(),
            _ => host.to_string(),
        };
        validated.push(format!("tcp://{normalized_host}:{port}"));
    }
    validated.sort();
    validated.dedup();
    Ok(validated)
}

fn decode_array<const N: usize>(encoded: &str, label: &str) -> Result<[u8; N]> {
    let value = BASE64
        .decode(encoded)
        .map_err(|error| NetworkError::Discovery(format!("invalid {label}: {error}")))?;
    value.try_into().map_err(|value: Vec<u8>| {
        NetworkError::Discovery(format!(
            "invalid {label} length {}; expected {N}",
            value.len()
        ))
    })
}

pub(crate) struct ReplayCache {
    entries: HashMap<String, Instant>,
    insertion_order: VecDeque<(String, Instant)>,
    window: Duration,
    maximum_entries: usize,
}

impl ReplayCache {
    pub(crate) fn new(window: Duration, maximum_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            insertion_order: VecDeque::new(),
            window,
            maximum_entries,
        }
    }

    /// Returns false for a duplicate announcement still inside the replay window.
    pub(crate) fn record_if_fresh(&mut self, key: String, now: Instant) -> bool {
        self.prune(now);
        if self.entries.contains_key(&key) {
            return false;
        }
        while self.entries.len() >= self.maximum_entries {
            if let Some((old_key, inserted)) = self.insertion_order.pop_front() {
                if self.entries.get(&old_key) == Some(&inserted) {
                    self.entries.remove(&old_key);
                }
            } else {
                break;
            }
        }
        self.entries.insert(key.clone(), now);
        self.insertion_order.push_back((key, now));
        true
    }

    fn prune(&mut self, now: Instant) {
        while let Some((key, inserted)) = self.insertion_order.front() {
            if now.saturating_duration_since(*inserted) < self.window {
                break;
            }
            let key = key.clone();
            let inserted = *inserted;
            self.insertion_order.pop_front();
            if self.entries.get(&key) == Some(&inserted) {
                self.entries.remove(&key);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_announcement_verifies_and_normalizes_unspecified_host() {
        let identity = NetworkIdentity::generate().unwrap();
        let packet = create_announcement(
            &identity,
            "Alice",
            &["tcp://0.0.0.0:41236".to_owned()],
        )
        .unwrap();
        let verified = verify_announcement(
            &packet,
            "192.0.2.10:50000".parse().unwrap(),
            16 * 1024,
            Duration::from_secs(120),
        )
        .unwrap();
        assert_eq!(verified.peer.peer_id, identity.peer_id());
        assert_eq!(verified.peer.endpoints, vec!["tcp://192.0.2.10:41236"]);
    }

    #[test]
    fn tampering_and_stale_announcements_are_rejected() {
        let identity = NetworkIdentity::generate().unwrap();
        let packet = create_announcement(
            &identity,
            "Alice",
            &["tcp://127.0.0.1:41236".to_owned()],
        )
        .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&packet).unwrap();
        value["displayName"] = serde_json::json!("Mallory");
        let tampered = serde_json::to_vec(&value).unwrap();
        assert!(verify_announcement(
            &tampered,
            "127.0.0.1:50000".parse().unwrap(),
            16 * 1024,
            Duration::from_secs(120)
        )
        .is_err());

        let stale = create_announcement_at(
            &identity,
            "Alice",
            &["tcp://127.0.0.1:41236".to_owned()],
            unix_time_ms() - 10_000,
        )
        .unwrap();
        assert!(verify_announcement(
            &stale,
            "127.0.0.1:50000".parse().unwrap(),
            16 * 1024,
            Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    fn replay_cache_is_bounded_and_expires_entries() {
        let start = Instant::now();
        let mut cache = ReplayCache::new(Duration::from_secs(1), 2);
        assert!(cache.record_if_fresh("a".to_owned(), start));
        assert!(!cache.record_if_fresh("a".to_owned(), start));
        assert!(cache.record_if_fresh("b".to_owned(), start));
        assert!(cache.record_if_fresh("c".to_owned(), start));
        assert!(cache.record_if_fresh("a".to_owned(), start));
        assert!(cache.record_if_fresh("a".to_owned(), start + Duration::from_secs(2)));
    }
}

