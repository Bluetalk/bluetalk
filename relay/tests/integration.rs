//! End-to-End: Auth, Präsenz, Tunnel, Postfach.

use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use bluetalk_relay::Config;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{WebSocketStream, client_async, tungstenite::Message};

type Ws = WebSocketStream<TcpStream>;

fn pid_of(sk: &SigningKey) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "bt2_{}",
        hex::encode(Sha256::digest(sk.verifying_key().as_bytes()))
    )
}

fn key(seed: u8) -> SigningKey {
    SigningKey::from_bytes(&[seed; 32])
}

fn sign_auth(sk: &SigningKey, nonce: &str, host: &str) -> (String, String) {
    let msg = format!("bluetalk-relay-auth-v1\n{nonce}\n{host}");
    let sig = BASE64.encode(sk.sign(msg.as_bytes()).to_bytes());
    let pk = BASE64.encode(sk.verifying_key().as_bytes());
    (pk, sig)
}

async fn connect_ws(url: &str, addr: std::net::SocketAddr) -> Ws {
    let stream = TcpStream::connect(addr).await.expect("tcp");
    let (ws, _) = client_async(url, stream).await.expect("handshake");
    ws
}

async fn recv_json(ws: &mut Ws) -> Value {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("eof")
            .expect("ws");
        match msg {
            Message::Text(t) => return serde_json::from_str(t.as_str()).expect("json"),
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p)).await;
            }
            Message::Pong(_) => {}
            Message::Close(_) => panic!("close"),
            Message::Binary(_) => panic!("binary statt json"),
            Message::Frame(_) => {}
        }
    }
}

async fn recv_binary(ws: &mut Ws) -> Vec<u8> {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timeout")
            .expect("eof")
            .expect("ws");
        match msg {
            Message::Binary(b) => return b.to_vec(),
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p)).await;
            }
            Message::Pong(_) => {}
            Message::Text(t) => panic!("text statt binary: {t}"),
            Message::Close(_) => panic!("close"),
            Message::Frame(_) => {}
        }
    }
}

async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into()))
        .await
        .expect("send");
}

fn encode_frame(id: u32, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(4 + payload.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.extend_from_slice(payload);
    v
}

fn decode_frame(data: &[u8]) -> (u32, &[u8]) {
    let id = u32::from_be_bytes(data[0..4].try_into().unwrap());
    (id, &data[4..])
}

async fn auth_ready(ws: &mut Ws, sk: &SigningKey, host: &str, name: &str) -> String {
    let hello = recv_json(ws).await;
    assert_eq!(hello["t"], "hello");
    let nonce = hello["nonce"].as_str().expect("nonce");
    let (pk, sig) = sign_auth(sk, nonce, host);
    send_json(
        ws,
        json!({
            "t": "auth",
            "publicKey": pk,
            "signature": sig,
            "name": name,
            "client": "BlueTalk/test",
        }),
    )
    .await;
    let ready = recv_json(ws).await;
    assert_eq!(ready["t"], "ready", "{ready}");
    ready["peerId"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_auth_presence_tunnel_mailbox() {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config::test(dir.path().to_path_buf(), addr.port());
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        bluetalk_relay::serve_listener_until_cancelled(listener, config, stop_rx)
            .await
            .unwrap();
    });

    let host = format!("127.0.0.1:{}", addr.port());
    let url = format!("ws://{host}/v1/ws");
    let sk_a = key(1);
    let sk_b = key(2);
    let want_a = pid_of(&sk_a);
    let want_b = pid_of(&sk_b);

    let mut a = connect_ws(&url, addr).await;
    let mut b = connect_ws(&url, addr).await;
    let peer_a = auth_ready(&mut a, &sk_a, &host, "Alpha").await;
    let peer_b = auth_ready(&mut b, &sk_b, &host, "Beta").await;
    assert_eq!(peer_a, want_a);
    assert_eq!(peer_b, want_b);

    send_json(&mut a, json!({ "t": "watch", "peers": [peer_b] })).await;
    send_json(&mut b, json!({ "t": "watch", "peers": [peer_a] })).await;

    let mut a_saw_b = false;
    let mut b_saw_a = false;
    for _ in 0..4 {
        if !a_saw_b {
            let msg = recv_json(&mut a).await;
            assert_eq!(msg["t"], "presence");
            assert_eq!(msg["peerId"], peer_b);
            assert_eq!(msg["online"], true);
            a_saw_b = true;
        }
        if !b_saw_a {
            let msg = recv_json(&mut b).await;
            assert_eq!(msg["t"], "presence");
            assert_eq!(msg["peerId"], peer_a);
            assert_eq!(msg["online"], true);
            b_saw_a = true;
        }
        if a_saw_b && b_saw_a {
            break;
        }
    }
    assert!(a_saw_b && b_saw_a);

    send_json(&mut a, json!({ "t": "open", "tunnel": 7, "to": peer_b })).await;
    let incoming = recv_json(&mut b).await;
    assert_eq!(incoming["t"], "incoming");
    assert_eq!(incoming["from"], peer_a);
    let b_tid = incoming["tunnel"].as_u64().unwrap() as u32;
    send_json(&mut b, json!({ "t": "accept", "tunnel": b_tid })).await;
    let opened = recv_json(&mut a).await;
    assert_eq!(opened["t"], "opened");
    assert_eq!(opened["tunnel"], 7);

    a.send(Message::Binary(encode_frame(7, b"ping-a").into()))
        .await
        .unwrap();
    let bin_b = recv_binary(&mut b).await;
    let (id_b, payload_b) = decode_frame(&bin_b);
    assert_eq!(id_b, b_tid);
    assert_eq!(payload_b, b"ping-a");

    b.send(Message::Binary(encode_frame(b_tid, b"pong-b").into()))
        .await
        .unwrap();
    let bin_a = recv_binary(&mut a).await;
    let (id_a, payload_a) = decode_frame(&bin_a);
    assert_eq!(id_a, 7);
    assert_eq!(payload_a, b"pong-b");

    let _ = b.close(None).await;
    drop(b);

    let mut saw_off = false;
    for _ in 0..6 {
        let msg = recv_json(&mut a).await;
        if msg["t"] == "closed" {
            continue;
        }
        assert_eq!(msg["t"], "presence", "{msg}");
        assert_eq!(msg["peerId"], peer_b);
        assert_eq!(msg["online"], false);
        saw_off = true;
        break;
    }
    assert!(saw_off);

    let mail_id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    send_json(
        &mut a,
        json!({
            "t": "post",
            "id": mail_id,
            "to": peer_b,
            "body": { "enc": "ciphertext" },
        }),
    )
    .await;
    let posted = recv_json(&mut a).await;
    assert_eq!(posted["t"], "posted", "{posted}");
    assert_eq!(posted["id"], mail_id);
    assert_eq!(posted["status"], "stored");

    let mut b2 = connect_ws(&url, addr).await;
    let peer_b2 = auth_ready(&mut b2, &sk_b, &host, "Beta").await;
    assert_eq!(peer_b2, peer_b);
    let delivered = recv_json(&mut b2).await;
    assert_eq!(delivered["t"], "mail", "{delivered}");
    assert_eq!(delivered["id"], mail_id);
    assert_eq!(delivered["from"], peer_a);
    assert_eq!(delivered["body"]["enc"], "ciphertext");
    send_json(&mut b2, json!({ "t": "ack", "ids": [mail_id] })).await;

    send_json(
        &mut a,
        json!({
            "t": "post",
            "id": mail_id,
            "to": peer_b,
            "body": { "enc": "ciphertext" },
        }),
    )
    .await;
    let again = recv_json(&mut a).await;
    assert_eq!(again["t"], "posted");
    assert_eq!(again["status"], "delivered");

    let _ = stop_tx.send(true);
}

async fn recv_msg(ws: &mut Ws) -> Message {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(30), ws.next())
            .await
            .expect("timeout")
            .expect("eof")
            .expect("ws");
        match msg {
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p)).await;
            }
            Message::Pong(_) | Message::Frame(_) => {}
            other => return other,
        }
    }
}

/// 24 MiB in 64-KiB-Frames, langsamer Empfänger; Steuernachricht dazwischen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_grosser_tunnel_und_steuer_waehrenddessen() {
    const FRAME: usize = 65_536;
    const TOTAL: usize = 24 * 1024 * 1024;
    const FRAMES: usize = TOTAL / FRAME;

    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config::test(dir.path().to_path_buf(), addr.port());
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        bluetalk_relay::serve_listener_until_cancelled(listener, config, stop_rx)
            .await
            .unwrap();
    });

    let host = format!("127.0.0.1:{}", addr.port());
    let url = format!("ws://{host}/v1/ws");
    let sk_a = key(11);
    let sk_b = key(12);
    let sk_c = key(13);

    let mut a = connect_ws(&url, addr).await;
    let mut b = connect_ws(&url, addr).await;
    let mut c = connect_ws(&url, addr).await;
    let peer_a = auth_ready(&mut a, &sk_a, &host, "Alpha").await;
    let peer_b = auth_ready(&mut b, &sk_b, &host, "Beta").await;
    let peer_c = auth_ready(&mut c, &sk_c, &host, "Gamma").await;

    send_json(&mut a, json!({ "t": "watch", "peers": [peer_b] })).await;
    send_json(&mut b, json!({ "t": "watch", "peers": [peer_a, peer_c] })).await;
    send_json(&mut c, json!({ "t": "watch", "peers": [peer_b] })).await;

    let mut a_saw_b = false;
    let mut b_saw_a = false;
    let mut b_saw_c = false;
    let mut c_saw_b = false;
    for _ in 0..12 {
        if !a_saw_b {
            let msg = recv_json(&mut a).await;
            assert_eq!(msg["t"], "presence", "{msg}");
            assert_eq!(msg["peerId"], peer_b);
            a_saw_b = true;
        }
        if !(b_saw_a && b_saw_c) {
            let msg = recv_json(&mut b).await;
            assert_eq!(msg["t"], "presence", "{msg}");
            if msg["peerId"] == peer_a {
                b_saw_a = true;
            } else if msg["peerId"] == peer_c {
                b_saw_c = true;
            }
        }
        if !c_saw_b {
            let msg = recv_json(&mut c).await;
            assert_eq!(msg["t"], "presence", "{msg}");
            assert_eq!(msg["peerId"], peer_b);
            c_saw_b = true;
        }
        if a_saw_b && b_saw_a && b_saw_c && c_saw_b {
            break;
        }
    }
    assert!(a_saw_b && b_saw_a && b_saw_c && c_saw_b);

    send_json(&mut a, json!({ "t": "open", "tunnel": 7, "to": peer_b })).await;
    let incoming = recv_json(&mut b).await;
    assert_eq!(incoming["t"], "incoming");
    let b_tid = incoming["tunnel"].as_u64().unwrap() as u32;
    send_json(&mut b, json!({ "t": "accept", "tunnel": b_tid })).await;
    let opened = recv_json(&mut a).await;
    assert_eq!(opened["t"], "opened");

    let send_task = tokio::spawn(async move {
        for i in 0..FRAMES {
            let mut payload = vec![0u8; FRAME];
            payload[0..4].copy_from_slice(&(i as u32).to_be_bytes());
            a.send(Message::Binary(encode_frame(7, &payload).into()))
                .await
                .expect("send frame");
        }
        a
    });

    tokio::time::sleep(Duration::from_millis(80)).await;
    let _ = c.close(None).await;
    drop(c);

    let mut next = 0u32;
    let mut saw_presence = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(90);
    while next < FRAMES as u32 || !saw_presence {
        assert!(tokio::time::Instant::now() < deadline, "zu langsam");
        match recv_msg(&mut b).await {
            Message::Binary(bin) => {
                let (id, payload) = decode_frame(&bin);
                assert_eq!(id, b_tid);
                assert_eq!(payload.len(), FRAME);
                let seq = u32::from_be_bytes(payload[0..4].try_into().unwrap());
                assert_eq!(seq, next, "Reihenfolge");
                next += 1;
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
            Message::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).expect("json");
                assert_ne!(
                    v.get("code").and_then(|c| c.as_str()),
                    Some("overflow"),
                    "{v}"
                );
                if v["t"] == "closed" {
                    panic!("Tunnel geschlossen: {v}");
                }
                if v["t"] == "presence" && v["peerId"] == peer_c && v["online"] == false {
                    saw_presence = true;
                }
            }
            Message::Close(_) => panic!("WebSocket Close"),
            other => panic!("unerwartet: {other:?}"),
        }
    }
    assert_eq!(next, FRAMES as u32);
    assert!(saw_presence, "presence während Transfer fehlt");

    send_task.await.expect("send task");
    let _ = stop_tx.send(true);
}
