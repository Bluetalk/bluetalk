use std::time::{SystemTime, UNIX_EPOCH};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use chacha20poly1305::{
    ChaCha20Poly1305, Key, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use zeroize::Zeroizing;

use crate::{
    NetworkError, NetworkIdentity, Result,
    identity::{peer_id_for_public_key, random_hex},
};

pub const PROTOCOL_VERSION: u16 = 2;
pub const SUPPORTED_PROTOCOL_VERSIONS: &[u16] = &[PROTOCOL_VERSION];

const HANDSHAKE_MAGIC: &str = "BLUETALK_SECURE_SESSION";
const HANDSHAKE_ENVELOPE_VERSION: u8 = 1;
const MAX_HANDSHAKE_BYTES: usize = 64 * 1024;
const MAX_HANDSHAKE_CLOCK_SKEW_MS: i64 = 5 * 60 * 1_000;
const CLIENT_SIGNATURE_DOMAIN: &[u8] = b"BlueTalk/v2/client-hello\0";
const SERVER_SIGNATURE_DOMAIN: &[u8] = b"BlueTalk/v2/server-hello\0";
const RECORD_AAD_DOMAIN: &[u8] = b"BlueTalk/v2/record\0";
const SESSION_KDF_INFO: &[u8] = b"BlueTalk/v2/session-keys/1";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientHello {
    magic: String,
    envelope_version: u8,
    protocol_version: u16,
    timestamp_ms: i64,
    nonce: String,
    identity_key: String,
    ephemeral_key: String,
    display_name: String,
    signature: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ServerHello {
    magic: String,
    envelope_version: u8,
    protocol_version: u16,
    timestamp_ms: i64,
    nonce: String,
    identity_key: String,
    ephemeral_key: String,
    display_name: String,
    client_hello_hash: String,
    signature: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientSignatureBody<'a> {
    magic: &'a str,
    envelope_version: u8,
    protocol_version: u16,
    timestamp_ms: i64,
    nonce: &'a str,
    identity_key: &'a str,
    ephemeral_key: &'a str,
    display_name: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerSignatureBody<'a> {
    magic: &'a str,
    envelope_version: u8,
    protocol_version: u16,
    timestamp_ms: i64,
    nonce: &'a str,
    identity_key: &'a str,
    ephemeral_key: &'a str,
    display_name: &'a str,
    client_hello_hash: &'a str,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HandshakeFinished {
    marker: String,
    role: String,
    transcript_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WireFrame {
    Message {
        message_id: String,
        sent_at_ms: i64,
        payload: serde_json::Value,
    },
    Ping {
        nonce: String,
    },
    Pong {
        nonce: String,
    },
    Close {
        reason: String,
    },
}

pub(crate) struct EstablishedSession {
    pub remote_peer_id: String,
    pub remote_display_name: String,
    pub connection_id: String,
    pub send_cipher: SendCipher,
    pub receive_cipher: ReceiveCipher,
}

pub(crate) struct SendCipher {
    cipher: ChaCha20Poly1305,
    nonce_prefix: [u8; 4],
    next_sequence: u64,
    transcript_hash: [u8; 32],
    max_plaintext_bytes: usize,
}

pub(crate) struct ReceiveCipher {
    cipher: ChaCha20Poly1305,
    nonce_prefix: [u8; 4],
    next_sequence: u64,
    transcript_hash: [u8; 32],
    max_plaintext_bytes: usize,
}

impl SendCipher {
    pub(crate) fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() > self.max_plaintext_bytes {
            return Err(NetworkError::FrameTooLarge {
                actual: plaintext.len(),
                maximum: self.max_plaintext_bytes,
            });
        }
        if self.next_sequence == u64::MAX {
            return Err(NetworkError::Protocol(
                "record sequence exhausted; reconnect required".to_owned(),
            ));
        }

        let sequence = self.next_sequence;
        let nonce = make_nonce(self.nonce_prefix, sequence);
        let aad = make_aad(&self.transcript_hash, sequence);
        let ciphertext = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| NetworkError::Crypto("record encryption failed".to_owned()))?;
        self.next_sequence += 1;

        let mut record = Vec::with_capacity(8 + ciphertext.len());
        record.extend_from_slice(&sequence.to_be_bytes());
        record.extend_from_slice(&ciphertext);
        Ok(record)
    }
}

impl ReceiveCipher {
    pub(crate) fn decrypt(&mut self, record: &[u8]) -> Result<Vec<u8>> {
        if record.len() < 8 + 16 {
            return Err(NetworkError::Protocol(
                "encrypted record is shorter than its header and tag".to_owned(),
            ));
        }
        if record.len() > self.max_plaintext_bytes + 8 + 16 {
            return Err(NetworkError::FrameTooLarge {
                actual: record.len() - 8 - 16,
                maximum: self.max_plaintext_bytes,
            });
        }
        let sequence = u64::from_be_bytes(record[..8].try_into().expect("length checked"));
        if sequence != self.next_sequence {
            return Err(NetworkError::Protocol(format!(
                "unexpected record sequence {sequence}; expected {}",
                self.next_sequence
            )));
        }
        let nonce = make_nonce(self.nonce_prefix, sequence);
        let aad = make_aad(&self.transcript_hash, sequence);
        let plaintext = self
            .cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &record[8..],
                    aad: &aad,
                },
            )
            .map_err(|_| NetworkError::Crypto("record authentication failed".to_owned()))?;
        self.next_sequence += 1;
        Ok(plaintext)
    }

    pub(crate) fn maximum_record_bytes(&self) -> usize {
        self.max_plaintext_bytes + 8 + 16
    }
}

pub(crate) async fn initiator_handshake<S>(
    stream: &mut S,
    identity: &NetworkIdentity,
    display_name: &str,
    expected_peer_id: Option<&str>,
    max_frame_bytes: usize,
) -> Result<EstablishedSession>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    validate_display_name(display_name)?;
    let (ephemeral_secret, ephemeral_public) = generate_ephemeral()?;
    let mut hello = ClientHello {
        magic: HANDSHAKE_MAGIC.to_owned(),
        envelope_version: HANDSHAKE_ENVELOPE_VERSION,
        protocol_version: PROTOCOL_VERSION,
        timestamp_ms: unix_time_ms(),
        nonce: random_hex(32)?,
        identity_key: BASE64.encode(identity.public_key_bytes()),
        ephemeral_key: BASE64.encode(ephemeral_public),
        display_name: display_name.to_owned(),
        signature: String::new(),
    };
    hello.signature = BASE64.encode(identity.sign(&client_signature_input(&hello)?));
    let client_bytes = serde_json::to_vec(&hello)?;
    write_prefixed(stream, &client_bytes, MAX_HANDSHAKE_BYTES).await?;

    let server_bytes = read_prefixed(stream, MAX_HANDSHAKE_BYTES).await?;
    let server: ServerHello = serde_json::from_slice(&server_bytes)
        .map_err(|error| NetworkError::Handshake(format!("invalid server hello: {error}")))?;
    validate_server_hello(&server, &client_bytes)?;

    let server_identity = decode_array::<32>(&server.identity_key, "server identity key")?;
    let server_signature = decode_array::<64>(&server.signature, "server signature")?;
    NetworkIdentity::verify(
        &server_identity,
        &server_signature_input(&server)?,
        &server_signature,
    )
    .map_err(|_| NetworkError::Handshake("server signature is invalid".to_owned()))?;
    let remote_peer_id = peer_id_for_public_key(&server_identity);
    if let Some(expected) = expected_peer_id {
        if expected != remote_peer_id {
            return Err(NetworkError::PeerIdentityMismatch {
                expected: expected.to_owned(),
                actual: remote_peer_id,
            });
        }
    }

    let server_ephemeral = X25519PublicKey::from(decode_array::<32>(
        &server.ephemeral_key,
        "server ephemeral key",
    )?);
    let shared_secret = ephemeral_secret.diffie_hellman(&server_ephemeral);
    reject_all_zero_shared_secret(shared_secret.as_bytes())?;
    let transcript_hash = transcript_hash(&client_bytes, &server_bytes);
    let (mut send_cipher, mut receive_cipher) = derive_session_ciphers(
        shared_secret.as_bytes(),
        transcript_hash,
        true,
        max_frame_bytes,
    )?;

    send_finished(stream, &mut send_cipher, "initiator", transcript_hash).await?;
    receive_finished(stream, &mut receive_cipher, "responder", transcript_hash).await?;

    Ok(EstablishedSession {
        remote_peer_id,
        remote_display_name: server.display_name,
        connection_id: hex::encode(&transcript_hash[..16]),
        send_cipher,
        receive_cipher,
    })
}

pub(crate) async fn responder_handshake<S>(
    stream: &mut S,
    identity: &NetworkIdentity,
    display_name: &str,
    max_frame_bytes: usize,
) -> Result<EstablishedSession>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    validate_display_name(display_name)?;
    let client_bytes = read_prefixed(stream, MAX_HANDSHAKE_BYTES).await?;
    let client: ClientHello = serde_json::from_slice(&client_bytes)
        .map_err(|error| NetworkError::Handshake(format!("invalid client hello: {error}")))?;
    validate_client_hello(&client)?;

    let client_identity = decode_array::<32>(&client.identity_key, "client identity key")?;
    let client_signature = decode_array::<64>(&client.signature, "client signature")?;
    NetworkIdentity::verify(
        &client_identity,
        &client_signature_input(&client)?,
        &client_signature,
    )
    .map_err(|_| NetworkError::Handshake("client signature is invalid".to_owned()))?;
    let remote_peer_id = peer_id_for_public_key(&client_identity);

    let (ephemeral_secret, ephemeral_public) = generate_ephemeral()?;
    let client_hash = Sha256::digest(&client_bytes);
    let mut server = ServerHello {
        magic: HANDSHAKE_MAGIC.to_owned(),
        envelope_version: HANDSHAKE_ENVELOPE_VERSION,
        protocol_version: PROTOCOL_VERSION,
        timestamp_ms: unix_time_ms(),
        nonce: random_hex(32)?,
        identity_key: BASE64.encode(identity.public_key_bytes()),
        ephemeral_key: BASE64.encode(ephemeral_public),
        display_name: display_name.to_owned(),
        client_hello_hash: hex::encode(client_hash),
        signature: String::new(),
    };
    server.signature = BASE64.encode(identity.sign(&server_signature_input(&server)?));
    let server_bytes = serde_json::to_vec(&server)?;
    write_prefixed(stream, &server_bytes, MAX_HANDSHAKE_BYTES).await?;

    let client_ephemeral = X25519PublicKey::from(decode_array::<32>(
        &client.ephemeral_key,
        "client ephemeral key",
    )?);
    let shared_secret = ephemeral_secret.diffie_hellman(&client_ephemeral);
    reject_all_zero_shared_secret(shared_secret.as_bytes())?;
    let transcript_hash = transcript_hash(&client_bytes, &server_bytes);
    let (mut send_cipher, mut receive_cipher) = derive_session_ciphers(
        shared_secret.as_bytes(),
        transcript_hash,
        false,
        max_frame_bytes,
    )?;

    receive_finished(stream, &mut receive_cipher, "initiator", transcript_hash).await?;
    send_finished(stream, &mut send_cipher, "responder", transcript_hash).await?;

    Ok(EstablishedSession {
        remote_peer_id,
        remote_display_name: client.display_name,
        connection_id: hex::encode(&transcript_hash[..16]),
        send_cipher,
        receive_cipher,
    })
}

pub(crate) fn encode_wire_frame(frame: &WireFrame, maximum: usize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(frame)?;
    if bytes.len() > maximum {
        return Err(NetworkError::FrameTooLarge {
            actual: bytes.len(),
            maximum,
        });
    }
    Ok(bytes)
}

pub(crate) fn decode_wire_frame(bytes: &[u8], maximum: usize) -> Result<WireFrame> {
    if bytes.len() > maximum {
        return Err(NetworkError::FrameTooLarge {
            actual: bytes.len(),
            maximum,
        });
    }
    let frame: WireFrame = serde_json::from_slice(bytes)
        .map_err(|error| NetworkError::Protocol(format!("invalid wire frame: {error}")))?;
    match &frame {
        WireFrame::Message { message_id, .. } if message_id.len() > 128 => Err(
            NetworkError::Protocol("message id exceeds 128 bytes".to_owned()),
        ),
        WireFrame::Ping { nonce } | WireFrame::Pong { nonce } if nonce.len() > 128 => Err(
            NetworkError::Protocol("heartbeat nonce exceeds 128 bytes".to_owned()),
        ),
        WireFrame::Close { reason } if reason.len() > 512 => Err(NetworkError::Protocol(
            "close reason exceeds 512 bytes".to_owned(),
        )),
        _ => Ok(frame),
    }
}

pub(crate) async fn write_encrypted<W>(
    writer: &mut W,
    cipher: &mut SendCipher,
    plaintext: &[u8],
) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let record = cipher.encrypt(plaintext)?;
    write_prefixed(writer, &record, cipher.max_plaintext_bytes + 8 + 16).await
}

pub(crate) async fn read_encrypted<R>(
    reader: &mut R,
    cipher: &mut ReceiveCipher,
) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let record = read_prefixed(reader, cipher.maximum_record_bytes()).await?;
    cipher.decrypt(&record)
}

fn validate_client_hello(hello: &ClientHello) -> Result<()> {
    validate_common_hello(
        &hello.magic,
        hello.envelope_version,
        hello.protocol_version,
        hello.timestamp_ms,
        &hello.nonce,
        &hello.display_name,
    )?;
    let _ = decode_array::<32>(&hello.identity_key, "client identity key")?;
    let _ = decode_array::<32>(&hello.ephemeral_key, "client ephemeral key")?;
    let _ = decode_array::<64>(&hello.signature, "client signature")?;
    Ok(())
}

fn validate_server_hello(hello: &ServerHello, client_bytes: &[u8]) -> Result<()> {
    validate_common_hello(
        &hello.magic,
        hello.envelope_version,
        hello.protocol_version,
        hello.timestamp_ms,
        &hello.nonce,
        &hello.display_name,
    )?;
    let _ = decode_array::<32>(&hello.identity_key, "server identity key")?;
    let _ = decode_array::<32>(&hello.ephemeral_key, "server ephemeral key")?;
    let _ = decode_array::<64>(&hello.signature, "server signature")?;
    if hello.client_hello_hash != hex::encode(Sha256::digest(client_bytes)) {
        return Err(NetworkError::Handshake(
            "server response is not bound to this client hello".to_owned(),
        ));
    }
    Ok(())
}

fn validate_common_hello(
    magic: &str,
    envelope_version: u8,
    protocol_version: u16,
    timestamp_ms: i64,
    nonce: &str,
    display_name: &str,
) -> Result<()> {
    if magic != HANDSHAKE_MAGIC {
        return Err(NetworkError::Handshake("incorrect protocol magic".to_owned()));
    }
    if envelope_version != HANDSHAKE_ENVELOPE_VERSION {
        return Err(NetworkError::Handshake(format!(
            "unsupported handshake envelope {envelope_version}"
        )));
    }
    if protocol_version != PROTOCOL_VERSION {
        return Err(NetworkError::Handshake(format!(
            "unsupported protocol version {protocol_version}"
        )));
    }
    validate_timestamp(timestamp_ms)?;
    if nonce.len() != 64 || hex::decode(nonce).map_or(true, |value| value.len() != 32) {
        return Err(NetworkError::Handshake(
            "handshake nonce must be 32 random bytes".to_owned(),
        ));
    }
    validate_display_name(display_name)
}

fn validate_display_name(display_name: &str) -> Result<()> {
    if display_name.is_empty() || display_name.len() > 128 {
        return Err(NetworkError::Handshake(
            "display name must contain 1..=128 UTF-8 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_timestamp(timestamp_ms: i64) -> Result<()> {
    let delta = unix_time_ms().abs_diff(timestamp_ms);
    if delta > MAX_HANDSHAKE_CLOCK_SKEW_MS as u64 {
        return Err(NetworkError::Handshake(
            "handshake timestamp is outside the permitted clock skew".to_owned(),
        ));
    }
    Ok(())
}

fn client_signature_input(hello: &ClientHello) -> Result<Vec<u8>> {
    let body = ClientSignatureBody {
        magic: &hello.magic,
        envelope_version: hello.envelope_version,
        protocol_version: hello.protocol_version,
        timestamp_ms: hello.timestamp_ms,
        nonce: &hello.nonce,
        identity_key: &hello.identity_key,
        ephemeral_key: &hello.ephemeral_key,
        display_name: &hello.display_name,
    };
    let mut bytes = CLIENT_SIGNATURE_DOMAIN.to_vec();
    bytes.extend_from_slice(&serde_json::to_vec(&body)?);
    Ok(bytes)
}

fn server_signature_input(hello: &ServerHello) -> Result<Vec<u8>> {
    let body = ServerSignatureBody {
        magic: &hello.magic,
        envelope_version: hello.envelope_version,
        protocol_version: hello.protocol_version,
        timestamp_ms: hello.timestamp_ms,
        nonce: &hello.nonce,
        identity_key: &hello.identity_key,
        ephemeral_key: &hello.ephemeral_key,
        display_name: &hello.display_name,
        client_hello_hash: &hello.client_hello_hash,
    };
    let mut bytes = SERVER_SIGNATURE_DOMAIN.to_vec();
    bytes.extend_from_slice(&serde_json::to_vec(&body)?);
    Ok(bytes)
}

fn generate_ephemeral() -> Result<(StaticSecret, [u8; 32])> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|error| {
        NetworkError::Crypto(format!("operating-system RNG unavailable: {error}"))
    })?;
    let secret = StaticSecret::from(*bytes);
    let public = X25519PublicKey::from(&secret).to_bytes();
    Ok((secret, public))
}

fn reject_all_zero_shared_secret(shared_secret: &[u8; 32]) -> Result<()> {
    if shared_secret.iter().all(|byte| *byte == 0) {
        return Err(NetworkError::Handshake(
            "invalid low-order X25519 public key".to_owned(),
        ));
    }
    Ok(())
}

fn transcript_hash(client: &[u8], server: &[u8]) -> [u8; 32] {
    let mut digest = Sha256::new();
    digest.update(b"BlueTalk/v2/transcript/1\0");
    digest.update((client.len() as u64).to_be_bytes());
    digest.update(client);
    digest.update((server.len() as u64).to_be_bytes());
    digest.update(server);
    digest.finalize().into()
}

fn derive_session_ciphers(
    shared_secret: &[u8; 32],
    transcript_hash: [u8; 32],
    initiator: bool,
    max_frame_bytes: usize,
) -> Result<(SendCipher, ReceiveCipher)> {
    let hkdf = Hkdf::<Sha256>::new(Some(&transcript_hash), shared_secret);
    let mut material = Zeroizing::new([0_u8; 72]);
    hkdf.expand(SESSION_KDF_INFO, material.as_mut())
        .map_err(|_| NetworkError::Crypto("HKDF session derivation failed".to_owned()))?;

    let initiator_key: [u8; 32] = material[..32].try_into().expect("fixed slice");
    let responder_key: [u8; 32] = material[32..64].try_into().expect("fixed slice");
    let initiator_prefix: [u8; 4] = material[64..68].try_into().expect("fixed slice");
    let responder_prefix: [u8; 4] = material[68..72].try_into().expect("fixed slice");
    let (send_key, receive_key, send_prefix, receive_prefix) = if initiator {
        (
            initiator_key,
            responder_key,
            initiator_prefix,
            responder_prefix,
        )
    } else {
        (
            responder_key,
            initiator_key,
            responder_prefix,
            initiator_prefix,
        )
    };

    Ok((
        SendCipher {
            cipher: ChaCha20Poly1305::new(Key::from_slice(&send_key)),
            nonce_prefix: send_prefix,
            next_sequence: 0,
            transcript_hash,
            max_plaintext_bytes: max_frame_bytes,
        },
        ReceiveCipher {
            cipher: ChaCha20Poly1305::new(Key::from_slice(&receive_key)),
            nonce_prefix: receive_prefix,
            next_sequence: 0,
            transcript_hash,
            max_plaintext_bytes: max_frame_bytes,
        },
    ))
}

async fn send_finished<S>(
    stream: &mut S,
    cipher: &mut SendCipher,
    role: &str,
    transcript_hash: [u8; 32],
) -> Result<()>
where
    S: AsyncWrite + Unpin,
{
    let finished = HandshakeFinished {
        marker: "finished".to_owned(),
        role: role.to_owned(),
        transcript_hash: hex::encode(transcript_hash),
    };
    let bytes = serde_json::to_vec(&finished)?;
    write_encrypted(stream, cipher, &bytes).await
}

async fn receive_finished<S>(
    stream: &mut S,
    cipher: &mut ReceiveCipher,
    expected_role: &str,
    transcript_hash: [u8; 32],
) -> Result<()>
where
    S: AsyncRead + Unpin,
{
    let bytes = read_encrypted(stream, cipher).await?;
    let finished: HandshakeFinished = serde_json::from_slice(&bytes)
        .map_err(|error| NetworkError::Handshake(format!("invalid finished record: {error}")))?;
    if finished.marker != "finished"
        || finished.role != expected_role
        || finished.transcript_hash != hex::encode(transcript_hash)
    {
        return Err(NetworkError::Handshake(
            "finished record does not match the negotiated transcript".to_owned(),
        ));
    }
    Ok(())
}

async fn write_prefixed<W>(writer: &mut W, bytes: &[u8], maximum: usize) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    if bytes.len() > maximum || bytes.len() > u32::MAX as usize {
        return Err(NetworkError::FrameTooLarge {
            actual: bytes.len(),
            maximum,
        });
    }
    writer.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    writer.write_all(bytes).await?;
    writer.flush().await?;
    Ok(())
}

async fn read_prefixed<R>(reader: &mut R, maximum: usize) -> Result<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(NetworkError::Closed);
        }
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_be_bytes(header) as usize;
    if length > maximum {
        return Err(NetworkError::FrameTooLarge {
            actual: length,
            maximum,
        });
    }
    let mut bytes = vec![0_u8; length];
    match reader.read_exact(&mut bytes).await {
        Ok(_) => Ok(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            Err(NetworkError::Closed)
        }
        Err(error) => Err(error.into()),
    }
}

fn decode_array<const N: usize>(encoded: &str, label: &str) -> Result<[u8; N]> {
    let value = BASE64
        .decode(encoded)
        .map_err(|error| NetworkError::Handshake(format!("invalid {label}: {error}")))?;
    value.try_into().map_err(|value: Vec<u8>| {
        NetworkError::Handshake(format!(
            "invalid {label} length {}; expected {N}",
            value.len()
        ))
    })
}

fn make_nonce(prefix: [u8; 4], sequence: u64) -> [u8; 12] {
    let mut nonce = [0_u8; 12];
    nonce[..4].copy_from_slice(&prefix);
    nonce[4..].copy_from_slice(&sequence.to_be_bytes());
    nonce
}

fn make_aad(transcript_hash: &[u8; 32], sequence: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(RECORD_AAD_DOMAIN.len() + 32 + 8);
    aad.extend_from_slice(RECORD_AAD_DOMAIN);
    aad.extend_from_slice(transcript_hash);
    aad.extend_from_slice(&sequence.to_be_bytes());
    aad
}

pub(crate) fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_authenticate_and_reject_replay() {
        let shared = [7_u8; 32];
        let transcript = [9_u8; 32];
        let (mut sender, _) = derive_session_ciphers(&shared, transcript, true, 1024).unwrap();
        let (_, mut receiver) = derive_session_ciphers(&shared, transcript, false, 1024).unwrap();

        let record = sender.encrypt(b"hello").unwrap();
        assert_eq!(receiver.decrypt(&record).unwrap(), b"hello");
        assert!(receiver.decrypt(&record).is_err());
    }

    #[test]
    fn records_reject_tampering_and_oversized_plaintext() {
        let shared = [7_u8; 32];
        let transcript = [9_u8; 32];
        let (mut sender, _) = derive_session_ciphers(&shared, transcript, true, 5).unwrap();
        let (_, mut receiver) = derive_session_ciphers(&shared, transcript, false, 5).unwrap();

        assert!(matches!(
            sender.encrypt(b"123456"),
            Err(NetworkError::FrameTooLarge { .. })
        ));
        let mut record = sender.encrypt(b"12345").unwrap();
        *record.last_mut().unwrap() ^= 1;
        assert!(matches!(
            receiver.decrypt(&record),
            Err(NetworkError::Crypto(_))
        ));
    }

    #[tokio::test]
    async fn signed_handshake_establishes_matching_session_keys() {
        let client_identity = NetworkIdentity::generate().unwrap();
        let server_identity = NetworkIdentity::generate().unwrap();
        let expected_server = server_identity.peer_id();
        let expected_client = client_identity.peer_id();
        let (mut client_stream, mut server_stream) = tokio::io::duplex(128 * 1024);

        let client = tokio::spawn(async move {
            initiator_handshake(
                &mut client_stream,
                &client_identity,
                "client",
                Some(&expected_server),
                1024,
            )
            .await
        });
        let server = tokio::spawn(async move {
            responder_handshake(&mut server_stream, &server_identity, "server", 1024).await
        });

        let mut client = client.await.unwrap().unwrap();
        let mut server = server.await.unwrap().unwrap();
        assert_eq!(server.remote_peer_id, expected_client);
        let record = client.send_cipher.encrypt(b"secret").unwrap();
        assert_eq!(server.receive_cipher.decrypt(&record).unwrap(), b"secret");
        let response = server.send_cipher.encrypt(b"response").unwrap();
        assert_eq!(client.receive_cipher.decrypt(&response).unwrap(), b"response");
    }
}
