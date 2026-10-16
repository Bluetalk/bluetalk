//! Deterministische Peer-Protokoll-v2-Testvektoren für den JS-Port.

use std::{fs, path::PathBuf};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use x25519_dalek::PublicKey as X25519PublicKey;

use super::{
    handshake::{HandshakeSecrets, client_hello_from_secrets, server_hello_from_secrets},
    *,
};
use crate::NetworkIdentity;

const TIMESTAMP_MS: i64 = 1_700_000_000_000;
const INITIATOR_NAME: &str = "Alice";
const RESPONDER_NAME: &str = "Bob";
const MAX_FRAME: usize = 1024;

fn fill_seed(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn hex_bytes(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

fn vectors_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/peer-v2-vectors.json")
}

fn build_vectors() -> Result<Value> {
    let initiator_seed = fill_seed(0x11);
    let responder_seed = fill_seed(0x22);
    let initiator = NetworkIdentity::from_seed(initiator_seed);
    let responder = NetworkIdentity::from_seed(responder_seed);

    let initiator_secrets = HandshakeSecrets {
        timestamp_ms: TIMESTAMP_MS,
        nonce_hex: hex_bytes(&fill_seed(0xa1)),
        ephemeral_seed: fill_seed(0x33),
    };
    let responder_secrets = HandshakeSecrets {
        timestamp_ms: TIMESTAMP_MS + 1,
        nonce_hex: hex_bytes(&fill_seed(0xb2)),
        ephemeral_seed: fill_seed(0x44),
    };

    let (client_bytes, initiator_eph) =
        client_hello_from_secrets(&initiator, INITIATOR_NAME, &initiator_secrets)?;
    let (server_bytes, responder_eph) = server_hello_from_secrets(
        &responder,
        RESPONDER_NAME,
        &client_bytes,
        &responder_secrets,
    )?;

    let initiator_eph_pub = X25519PublicKey::from(&initiator_eph);
    let responder_eph_pub = X25519PublicKey::from(&responder_eph);
    let shared_initiator = initiator_eph.diffie_hellman(&responder_eph_pub);
    let shared_responder = responder_eph.diffie_hellman(&initiator_eph_pub);
    assert_eq!(shared_initiator.as_bytes(), shared_responder.as_bytes());
    reject_all_zero_shared_secret(shared_initiator.as_bytes())?;

    let transcript = transcript_hash(&client_bytes, &server_bytes);
    let (mut initiator_send, mut initiator_recv) = derive_session_ciphers(
        shared_initiator.as_bytes(),
        transcript,
        true,
        MAX_FRAME,
    )?;
    let (mut responder_send, mut responder_recv) = derive_session_ciphers(
        shared_responder.as_bytes(),
        transcript,
        false,
        MAX_FRAME,
    )?;

    let finished_initiator = serde_json::to_vec(&HandshakeFinished {
        marker: "finished".to_owned(),
        role: "initiator".to_owned(),
        transcript_hash: hex_bytes(&transcript),
    })?;
    let finished_responder = serde_json::to_vec(&HandshakeFinished {
        marker: "finished".to_owned(),
        role: "responder".to_owned(),
        transcript_hash: hex_bytes(&transcript),
    })?;
    let finished_init_record = initiator_send.encrypt(&finished_initiator)?;
    assert_eq!(
        responder_recv.decrypt(&finished_init_record)?,
        finished_initiator
    );
    let finished_resp_record = responder_send.encrypt(&finished_responder)?;
    assert_eq!(
        initiator_recv.decrypt(&finished_resp_record)?,
        finished_responder
    );

    let ping_plain = b"hello-record";
    let ping_record = initiator_send.encrypt(ping_plain)?;
    assert_eq!(responder_recv.decrypt(&ping_record)?, ping_plain);

    let frame = WireFrame::Message {
        message_id: "msg-vector-1".to_owned(),
        sent_at_ms: TIMESTAMP_MS,
        payload: json!({ "kind": "text", "body": "ping" }),
    };
    let frame_bytes = encode_wire_frame(&frame, MAX_FRAME)?;
    let frame_record = initiator_send.encrypt(&frame_bytes)?;
    assert_eq!(responder_recv.decrypt(&frame_record)?, frame_bytes);
    assert_eq!(decode_wire_frame(&frame_bytes, MAX_FRAME)?, frame);

    let pong_frame = WireFrame::Pong {
        nonce: "aabbccddeeff0011".to_owned(),
    };
    let pong_bytes = encode_wire_frame(&pong_frame, MAX_FRAME)?;

    let close_frame = WireFrame::Close {
        reason: "vector-close".to_owned(),
    };
    let close_bytes = encode_wire_frame(&close_frame, MAX_FRAME)?;

    Ok(json!({
        "version": 2,
        "timestampMs": TIMESTAMP_MS,
        "maxFrameBytes": MAX_FRAME,
        "initiator": {
            "seedB64": BASE64.encode(initiator_seed),
            "identityKeyB64": BASE64.encode(initiator.public_key_bytes()),
            "peerId": initiator.peer_id(),
            "displayName": INITIATOR_NAME,
            "ephemeralSeedB64": BASE64.encode(initiator_secrets.ephemeral_seed),
            "ephemeralPublicB64": BASE64.encode(initiator_eph_pub.to_bytes()),
            "nonceHex": initiator_secrets.nonce_hex,
            "timestampMs": initiator_secrets.timestamp_ms,
        },
        "responder": {
            "seedB64": BASE64.encode(responder_seed),
            "identityKeyB64": BASE64.encode(responder.public_key_bytes()),
            "peerId": responder.peer_id(),
            "displayName": RESPONDER_NAME,
            "ephemeralSeedB64": BASE64.encode(responder_secrets.ephemeral_seed),
            "ephemeralPublicB64": BASE64.encode(responder_eph_pub.to_bytes()),
            "nonceHex": responder_secrets.nonce_hex,
            "timestampMs": responder_secrets.timestamp_ms,
        },
        "clientHelloB64": BASE64.encode(&client_bytes),
        "serverHelloB64": BASE64.encode(&server_bytes),
        "transcriptHashHex": hex_bytes(&transcript),
        "connectionId": hex_bytes(&transcript[..16]),
        "finished": {
            "initiatorPlaintextB64": BASE64.encode(&finished_initiator),
            "initiatorRecordHex": hex_bytes(&finished_init_record),
            "responderPlaintextB64": BASE64.encode(&finished_responder),
            "responderRecordHex": hex_bytes(&finished_resp_record),
        },
        "records": [
            {
                "from": "initiator",
                "sequence": 1,
                "plaintextHex": hex_bytes(ping_plain),
                "recordHex": hex_bytes(&ping_record),
            },
            {
                "from": "initiator",
                "sequence": 2,
                "plaintextHex": hex_bytes(&frame_bytes),
                "recordHex": hex_bytes(&frame_record),
            }
        ],
        "frames": [
            {
                "type": "message",
                "utf8": String::from_utf8(frame_bytes).expect("wire frame is utf-8 json"),
            },
            {
                "type": "pong",
                "utf8": String::from_utf8(pong_bytes).expect("wire frame is utf-8 json"),
            },
            {
                "type": "close",
                "utf8": String::from_utf8(close_bytes).expect("wire frame is utf-8 json"),
            }
        ],
    }))
}

#[test]
fn peer_v2_vectors_match_committed_fixture() {
    let generated = build_vectors().expect("vector generation");
    let path = vectors_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("fixtures dir");
    }
    if !path.exists() || std::env::var("BLUETALK_WRITE_VECTORS").is_ok() {
        let pretty = serde_json::to_string_pretty(&generated).expect("pretty json");
        fs::write(&path, pretty + "\n").expect("write vectors");
    }
    let existing: Value = serde_json::from_slice(&fs::read(&path).expect("read vectors"))
        .expect("parse committed vectors");
    assert_eq!(
        existing, generated,
        "peer-v2 vectors drifted; set BLUETALK_WRITE_VECTORS=1 to refresh {}",
        path.display()
    );
}
