//! Verschlüsselter Handshake (Initiator/Responder): signierte ephemere
//! Schlüssel, Hello-Validierung und Finished-Austausch.

use super::*;

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

