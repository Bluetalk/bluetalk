//! Mehrere Geräte pro Peer-ID, Präsenz mit devices, Sync-Hinweis.

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

async fn recv_until(ws: &mut Ws, t: &str) -> Value {
    for _ in 0..16 {
        let msg = recv_json(ws).await;
        if msg["t"] == t {
            return msg;
        }
    }
    panic!("kein {t}");
}

async fn try_recv_json(ws: &mut Ws, ms: u64) -> Option<Value> {
    loop {
        let msg = tokio::time::timeout(Duration::from_millis(ms), ws.next())
            .await
            .ok()?
            .expect("eof")
            .expect("ws");
        match msg {
            Message::Text(t) => return Some(serde_json::from_str(t.as_str()).expect("json")),
            Message::Ping(p) => {
                let _ = ws.send(Message::Pong(p)).await;
            }
            Message::Pong(_) | Message::Frame(_) => {}
            Message::Close(_) => return None,
            Message::Binary(_) => panic!("binary statt json"),
        }
    }
}

async fn send_json(ws: &mut Ws, v: Value) {
    ws.send(Message::Text(v.to_string().into()))
        .await
        .expect("send");
}

async fn auth_ready(
    ws: &mut Ws,
    sk: &SigningKey,
    host: &str,
    name: &str,
    device: Option<&str>,
    device_name: Option<&str>,
) -> Value {
    let hello = recv_json(ws).await;
    assert_eq!(hello["t"], "hello");
    let nonce = hello["nonce"].as_str().expect("nonce");
    let (pk, sig) = sign_auth(sk, nonce, host);
    let mut body = json!({
        "t": "auth",
        "publicKey": pk,
        "signature": sig,
        "name": name,
        "client": "BlueTalk/test",
    });
    if let Some(d) = device {
        body["device"] = json!(d);
    }
    if let Some(n) = device_name {
        body["deviceName"] = json!(n);
    }
    send_json(ws, body).await;
    let ready = recv_json(ws).await;
    assert_eq!(ready["t"], "ready", "{ready}");
    ready
}

async fn spawn_relay() -> (
    std::net::SocketAddr,
    String,
    String,
    tokio::sync::watch::Sender<bool>,
) {
    let dir = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let config = Config::test(dir.path().to_path_buf(), addr.port());
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _dir = dir;
        bluetalk_relay::serve_listener_until_cancelled(listener, config, stop_rx)
            .await
            .unwrap();
    });
    let host = format!("127.0.0.1:{}", addr.port());
    let url = format!("ws://{host}/v1/ws");
    (addr, host, url, stop_tx)
}

fn b64_32(seed: u8) -> String {
    BASE64.encode([seed; 32])
}

fn register_body(seed: u8, user: &str, auth_seed: u8) -> Value {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let auth_key = b64_32(auth_seed);
    let payload = format!("bluetalk-account-register-v1\n{user}\n{auth_key}");
    let sig = BASE64.encode(sk.sign(payload.as_bytes()).to_bytes());
    json!({
        "username": user,
        "kdf": {
            "alg": "pbkdf2-sha256",
            "iterations": 600000,
            "salt": BASE64.encode([0x11u8; 16]),
        },
        "authKey": auth_key,
        "vault": {"v": 1, "iv": BASE64.encode([3u8; 12]), "ct": BASE64.encode([4u8; 24])},
        "publicKey": BASE64.encode(sk.verifying_key().as_bytes()),
        "signature": sig,
        "deviceName": "test",
    })
}

async fn http_json(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> (u16, Value) {
    let mut stream = TcpStream::connect(addr).await.expect("tcp");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let raw = body.map(|b| b.to_string().into_bytes());
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(b) = &raw {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    if let Some(b) = raw {
        stream.write_all(&b).await.unwrap();
    }
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let body_start = head.len() + 4;
    let body_bytes = if body_start <= buf.len() {
        &buf[body_start..]
    } else {
        rest.as_bytes()
    };
    (
        status,
        serde_json::from_slice(body_bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zwei_geraete_presence_open_self_mail_legacy() {
    let (addr, host, url, stop) = spawn_relay().await;
    let sk_a = key(21);
    let sk_b = key(22);
    let want_a = pid_of(&sk_a);
    let want_b = pid_of(&sk_b);

    let mut a1 = connect_ws(&url, addr).await;
    let mut b = connect_ws(&url, addr).await;

    let r1 = auth_ready(
        &mut a1,
        &sk_a,
        &host,
        "Alpha",
        Some("testdev-a1"),
        Some("PC"),
    )
    .await;
    assert_eq!(r1["peerId"], want_a);
    assert_eq!(r1["device"], "testdev-a1");
    assert_eq!(r1["devices"].as_array().unwrap().len(), 0);

    let rb = auth_ready(
        &mut b,
        &sk_b,
        &host,
        "Beta",
        Some("testdev-b1"),
        Some("Phone"),
    )
    .await;
    assert_eq!(rb["peerId"], want_b);

    send_json(&mut a1, json!({ "t": "watch", "peers": [want_b] })).await;
    send_json(&mut b, json!({ "t": "watch", "peers": [want_a] })).await;

    let pa1 = recv_until(&mut a1, "presence").await;
    assert_eq!(pa1["peerId"], want_b);
    assert_eq!(pa1["online"], true);
    assert_eq!(pa1["devices"][0]["id"], "testdev-b1");

    let pb = recv_until(&mut b, "presence").await;
    assert_eq!(pb["peerId"], want_a);
    assert_eq!(pb["online"], true);
    assert_eq!(pb["devices"].as_array().unwrap().len(), 1);
    assert_eq!(pb["devices"][0]["id"], "testdev-a1");

    let mut a2 = connect_ws(&url, addr).await;
    let r2 = auth_ready(
        &mut a2,
        &sk_a,
        &host,
        "Alpha",
        Some("testdev-a2"),
        Some("Web"),
    )
    .await;
    assert_eq!(r2["peerId"], want_a);
    assert_eq!(r2["device"], "testdev-a2");
    assert_eq!(r2["devices"][0]["id"], "testdev-a1");
    assert_eq!(r2["devices"][0]["name"], "PC");

    let devices_a1 = recv_until(&mut a1, "devices").await;
    assert_eq!(devices_a1["devices"][0]["id"], "testdev-a2");

    let pb2 = recv_until(&mut b, "presence").await;
    assert_eq!(pb2["peerId"], want_a);
    assert_eq!(pb2["online"], true);
    let ids: Vec<&str> = pb2["devices"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| d["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"testdev-a1"));
    assert!(ids.contains(&"testdev-a2"));

    send_json(&mut a2, json!({ "t": "watch", "peers": [want_b] })).await;
    let pa2 = recv_until(&mut a2, "presence").await;
    assert_eq!(pa2["peerId"], want_b);
    assert_eq!(pa2["online"], true);

    send_json(
        &mut b,
        json!({ "t": "open", "tunnel": 7, "to": want_a, "device": "testdev-a1" }),
    )
    .await;
    let inc = recv_until(&mut a1, "incoming").await;
    assert_eq!(inc["from"], want_b);
    assert_eq!(inc["fromDevice"], "testdev-b1");
    let a1_tid = inc["tunnel"].as_u64().unwrap() as u32;
    send_json(&mut a1, json!({ "t": "accept", "tunnel": a1_tid })).await;
    let opened = recv_until(&mut b, "opened").await;
    assert_eq!(opened["tunnel"], 7);

    send_json(&mut b, json!({ "t": "close", "tunnel": 7 })).await;
    let _ = recv_until(&mut a1, "closed").await;

    send_json(&mut b, json!({ "t": "open", "tunnel": 8, "to": want_a })).await;
    let inc2 = recv_until(&mut a2, "incoming").await;
    assert_eq!(inc2["fromDevice"], "testdev-b1");
    send_json(
        &mut a2,
        json!({ "t": "accept", "tunnel": inc2["tunnel"].as_u64().unwrap() }),
    )
    .await;
    assert_eq!(recv_until(&mut b, "opened").await["t"], "opened");
    send_json(&mut b, json!({ "t": "close", "tunnel": 8 })).await;
    let _ = recv_until(&mut a2, "closed").await;

    send_json(&mut a1, json!({ "t": "open", "tunnel": 3, "to": want_a })).await;
    let fail = recv_until(&mut a1, "open_failed").await;
    assert_eq!(fail["code"], "self");

    send_json(
        &mut a1,
        json!({ "t": "open", "tunnel": 4, "to": want_a, "device": "testdev-a2" }),
    )
    .await;
    let fail2 = recv_until(&mut a1, "open_failed").await;
    assert_eq!(fail2["code"], "self");

    send_json(
        &mut b,
        json!({
            "t": "post",
            "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "to": want_a,
            "body": { "enc": "hi" },
        }),
    )
    .await;
    let posted = recv_until(&mut b, "posted").await;
    assert_eq!(posted["status"], "delivered");
    let m1 = recv_until(&mut a1, "mail").await;
    let m2 = recv_until(&mut a2, "mail").await;
    assert_eq!(m1["id"], "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert_eq!(m2["id"], m1["id"]);
    send_json(
        &mut a1,
        json!({ "t": "ack", "ids": ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"] }),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(80)).await;

    let mut a3 = connect_ws(&url, addr).await;
    let r3 = auth_ready(&mut a3, &sk_a, &host, "Alpha", Some("testdev-a3"), None).await;
    assert_eq!(r3["t"], "ready");
    let leftover = try_recv_json(&mut a3, 300).await;
    if let Some(msg) = leftover {
        assert_ne!(msg["t"], "mail", "{msg}");
    }
    let _ = a3.close(None).await;

    let mut a_legacy = connect_ws(&url, addr).await;
    let rl = auth_ready(&mut a_legacy, &sk_a, &host, "Alpha", None, None).await;
    assert_eq!(rl["device"], "legacy");
    let mut a_legacy2 = connect_ws(&url, addr).await;
    let _ = auth_ready(&mut a_legacy2, &sk_a, &host, "Alpha", None, None).await;
    let replaced = recv_until(&mut a_legacy, "error").await;
    assert_eq!(replaced["code"], "replaced");

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn neuntes_geraet_und_ungueltiges_device() {
    let (addr, host, url, stop) = spawn_relay().await;
    let sk = key(31);
    let mut sockets = Vec::new();
    for i in 1u8..=8 {
        let mut ws = connect_ws(&url, addr).await;
        let d = format!("testdev-{i:02}");
        let ready = auth_ready(&mut ws, &sk, &host, "N", Some(&d), None).await;
        assert_eq!(ready["t"], "ready");
        sockets.push(ws);
    }
    let mut ninth = connect_ws(&url, addr).await;
    let r9 = auth_ready(&mut ninth, &sk, &host, "N", Some("testdev-09"), None).await;
    assert_eq!(r9["t"], "ready");
    let err = recv_until(&mut sockets[0], "error").await;
    assert_eq!(err["code"], "replaced");

    let mut bad = connect_ws(&url, addr).await;
    let hello = recv_json(&mut bad).await;
    let nonce = hello["nonce"].as_str().unwrap();
    let (pk, sig) = sign_auth(&sk, nonce, &host);
    send_json(
        &mut bad,
        json!({
            "t": "auth",
            "publicKey": pk,
            "signature": sig,
            "name": "N",
            "device": "short",
        }),
    )
    .await;
    let fail = recv_json(&mut bad).await;
    assert_eq!(fail["t"], "error");
    assert_eq!(fail["code"], "auth_failed");

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_hinweis_an_beide_geraete_gebuendelt() {
    let (addr, host, url, stop) = spawn_relay().await;
    let seed = 41u8;
    let user = "multidev_alice";
    let (st, reg) = http_json(
        addr,
        "POST",
        "/v1/account/register",
        None,
        Some(&register_body(seed, user, 9)),
    )
    .await;
    assert_eq!(st, 201, "{reg}");
    let token = reg["token"].as_str().unwrap().to_string();
    let sk = key(seed);

    let mut d1 = connect_ws(&url, addr).await;
    let mut d2 = connect_ws(&url, addr).await;
    let _ = auth_ready(&mut d1, &sk, &host, "A", Some("testdev-s1"), None).await;
    let _ = auth_ready(&mut d2, &sk, &host, "A", Some("testdev-s2"), None).await;
    let _ = recv_until(&mut d1, "devices").await;

    let (st, push) = http_json(
        addr,
        "POST",
        "/v1/sync/push",
        Some(&token),
        Some(&json!({"items":[{"key":"k1","data":"aaa"}]})),
    )
    .await;
    assert_eq!(st, 200, "{push}");
    assert_eq!(push["latestSeq"], 1);
    let s1 = recv_until(&mut d1, "sync").await;
    let s2 = recv_until(&mut d2, "sync").await;
    assert_eq!(s1["latestSeq"], 1);
    assert_eq!(s2["latestSeq"], 1);

    let (st, push2) = http_json(
        addr,
        "POST",
        "/v1/sync/push",
        Some(&token),
        Some(&json!({"items":[{"key":"k2","data":"bbb"}]})),
    )
    .await;
    assert_eq!(st, 200, "{push2}");
    assert_eq!(push2["latestSeq"], 2);

    let early = try_recv_json(&mut d1, 250).await;
    if let Some(msg) = &early {
        panic!("zweites sync zu früh: {msg}");
    }
    let late1 = recv_until(&mut d1, "sync").await;
    let late2 = recv_until(&mut d2, "sync").await;
    assert_eq!(late1["latestSeq"], 2);
    assert_eq!(late2["latestSeq"], 2);

    let _ = stop.send(true);
}
