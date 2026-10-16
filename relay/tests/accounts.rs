//! HTTP: Konto, Fake-Salt, Token, Sync, CORS, statisches Web.

use std::collections::HashMap;
use std::io::Write;
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use bluetalk_relay::Config;
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn spawn_server(
    mut config: Config,
) -> (std::net::SocketAddr, tokio::sync::watch::Sender<bool>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    config.port = addr.port();
    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        bluetalk_relay::serve_listener_until_cancelled(listener, config, stop_rx)
            .await
            .unwrap();
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    (addr, stop_tx)
}

async fn http(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    extra: &[(&str, &str)],
    body: Option<&[u8]>,
) -> (u16, HashMap<String, String>, Vec<u8>) {
    let mut stream = TcpStream::connect(addr).await.expect("tcp");
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(b) = body {
        req.push_str("Content-Type: application/json\r\n");
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    for (k, v) in extra {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes()).await.unwrap();
    if let Some(b) = body {
        stream.write_all(b).await.unwrap();
    }
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    parse_http(&buf)
}

fn parse_http(buf: &[u8]) -> (u16, HashMap<String, String>, Vec<u8>) {
    let text = String::from_utf8_lossy(buf);
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let mut lines = head.split("\r\n");
    let status: u16 = lines
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let body_start = head.len() + 4;
    let body = if body_start <= buf.len() {
        buf[body_start..].to_vec()
    } else {
        rest.as_bytes().to_vec()
    };
    (status, headers, body)
}

fn json_body(v: &Value) -> Vec<u8> {
    v.to_string().into_bytes()
}

fn parse_json(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn b64_32(seed: u8) -> String {
    BASE64.encode([seed; 32])
}

fn kdf() -> Value {
    json!({
        "alg": "pbkdf2-sha256",
        "iterations": 600000,
        "salt": BASE64.encode([0x11u8; 16]),
    })
}

fn vault() -> Value {
    json!({"v": 1, "iv": BASE64.encode([3u8; 12]), "ct": BASE64.encode([4u8; 24])})
}

fn register_body(seed: u8, user: &str, auth_seed: u8) -> Value {
    let sk = SigningKey::from_bytes(&[seed; 32]);
    let auth_key = b64_32(auth_seed);
    let payload = format!("bluetalk-account-register-v1\n{user}\n{auth_key}");
    let sig = BASE64.encode(sk.sign(payload.as_bytes()).to_bytes());
    json!({
        "username": user,
        "kdf": kdf(),
        "authKey": auth_key,
        "vault": vault(),
        "publicKey": BASE64.encode(sk.verifying_key().as_bytes()),
        "signature": sig,
        "deviceName": "test",
    })
}

async fn json_post(
    addr: std::net::SocketAddr,
    path: &str,
    token: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let mut extra = Vec::new();
    let auth;
    if let Some(t) = token {
        auth = format!("Bearer {t}");
        extra.push(("Authorization", auth.as_str()));
    }
    let raw = json_body(body);
    let (st, _, b) = http(addr, "POST", path, &extra, Some(&raw)).await;
    (st, parse_json(&b))
}

async fn json_get(
    addr: std::net::SocketAddr,
    path: &str,
    token: Option<&str>,
) -> (u16, HashMap<String, String>, Value) {
    let mut extra = Vec::new();
    let auth;
    if let Some(t) = token {
        auth = format!("Bearer {t}");
        extra.push(("Authorization", auth.as_str()));
    }
    let (st, h, b) = http(addr, "GET", path, &extra, None).await;
    (st, h, parse_json(&b))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn account_register_login_fake_salt_token_sync() {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::test(dir.path().to_path_buf(), 0);
    let (addr, stop) = spawn_server(config).await;

    let user = "cloud_alice";
    let (st, pre) = json_post(
        addr,
        "/v1/account/prelogin",
        None,
        &json!({"username": user}),
    )
    .await;
    assert_eq!(st, 200, "{pre}");
    let fake = pre["kdf"]["salt"].clone();

    let (st, pre2) = json_post(
        addr,
        "/v1/account/prelogin",
        None,
        &json!({"username": user}),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(pre2["kdf"]["salt"], fake);

    let (st, other) = json_post(
        addr,
        "/v1/account/prelogin",
        None,
        &json!({"username": "cloud_bobxx"}),
    )
    .await;
    assert_eq!(st, 200);
    assert_ne!(other["kdf"]["salt"], fake);

    let (st, reg) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(7, user, 9),
    )
    .await;
    assert_eq!(st, 201, "{reg}");
    let token = reg["token"].as_str().unwrap().to_string();
    assert!(!token.is_empty());

    let (st, pre3) = json_post(
        addr,
        "/v1/account/prelogin",
        None,
        &json!({"username": user}),
    )
    .await;
    assert_eq!(st, 200);
    assert_ne!(pre3["kdf"]["salt"], fake);
    assert_eq!(pre3["kdf"]["salt"], kdf()["salt"]);

    let (st, taken) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(8, user, 10),
    )
    .await;
    assert_eq!(st, 409, "{taken}");
    assert_eq!(taken["error"], "username_taken");

    let (st, _, me) = json_get(addr, "/v1/account/me", Some(&token)).await;
    assert_eq!(st, 200, "{me}");
    assert_eq!(me["username"], user);

    let (st, _) = json_post(addr, "/v1/account/logout", Some(&token), &json!({})).await;
    assert_eq!(st, 204);
    let (st, _, body) = json_get(addr, "/v1/account/me", Some(&token)).await;
    assert_eq!(st, 401, "{body}");

    let (st, login) = json_post(
        addr,
        "/v1/account/login",
        None,
        &json!({"username": user, "authKey": b64_32(9), "deviceName": "pc"}),
    )
    .await;
    assert_eq!(st, 200, "{login}");
    let token = login["token"].as_str().unwrap().to_string();
    assert_eq!(login["vault"]["v"], 1);

    let (st, push) = json_post(
        addr,
        "/v1/sync/push",
        Some(&token),
        &json!({"items":[{"key":"k1","data":"aaa"},{"key":"k2","data":"bb"}]}),
    )
    .await;
    assert_eq!(st, 200, "{push}");
    assert_eq!(push["results"][0]["seq"], 1);
    assert_eq!(push["results"][1]["seq"], 2);
    assert_eq!(push["latestSeq"], 2);
    let (st, _, me) = json_get(addr, "/v1/account/me", Some(&token)).await;
    assert_eq!(st, 200, "{me}");
    assert_eq!(me["usage"]["items"], 2);
    assert_eq!(me["usage"]["bytes"], 5);

    let (st, push2) = json_post(
        addr,
        "/v1/sync/push",
        Some(&token),
        &json!({"items":[{"key":"k1","data":"AAAA"}]}),
    )
    .await;
    assert_eq!(st, 200, "{push2}");
    assert_eq!(push2["results"][0]["seq"], 3);
    assert_eq!(push2["latestSeq"], 3);
    let (st, _, me) = json_get(addr, "/v1/account/me", Some(&token)).await;
    assert_eq!(st, 200, "{me}");
    assert_eq!(me["usage"]["bytes"], 6);

    let (st, _, pull) = json_get(addr, "/v1/sync/pull?after=0&limit=10", Some(&token)).await;
    assert_eq!(st, 200, "{pull}");
    assert_eq!(pull["latestSeq"], 3);
    assert_eq!(pull["more"], false);
    let items = pull["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["seq"], 2);
    assert_eq!(items[1]["seq"], 3);
    assert_eq!(items[1]["data"], "AAAA");

    let (st, del) = json_post(
        addr,
        "/v1/sync/delete",
        Some(&token),
        &json!({"keys":["k2"]}),
    )
    .await;
    assert_eq!(st, 200, "{del}");
    assert_eq!(del["deleted"], 1);
    let (st, _, me) = json_get(addr, "/v1/account/me", Some(&token)).await;
    assert_eq!(st, 200, "{me}");
    assert_eq!(me["usage"]["items"], 1);
    assert_eq!(me["usage"]["bytes"], 4);

    let (st, push3) = json_post(
        addr,
        "/v1/sync/push",
        Some(&token),
        &json!({"items":[{"key":"k3","data":"z"}]}),
    )
    .await;
    assert_eq!(st, 200, "{push3}");
    assert_eq!(
        push3["results"][0]["seq"], 4,
        "seq nach delete nicht wiederverwendet"
    );

    let (st, too) = json_post(
        addr,
        "/v1/sync/push",
        Some(&token),
        &json!({"items":[{"key":"huge","data": "x".repeat(3 * 1024 * 1024 + 1)}]}),
    )
    .await;
    assert_eq!(st, 413, "{too}");
    assert_eq!(too["error"], "too_large");

    let (st, _, look) = json_get(addr, &format!("/v1/account/lookup?username={user}"), None).await;
    assert_eq!(st, 200, "{look}");
    assert_eq!(look["username"], user);

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_quota_und_cors() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::test(dir.path().to_path_buf(), 0);
    config.sync_quota_bytes = 8;
    let (addr, stop) = spawn_server(config).await;
    let user = "quota_user";
    let (st, reg) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(21, user, 22),
    )
    .await;
    assert_eq!(st, 201, "{reg}");
    let token = reg["token"].as_str().unwrap().to_string();

    let (st, q) = json_post(
        addr,
        "/v1/sync/push",
        Some(&token),
        &json!({"items":[{"key":"a","data":"123456789"}]}),
    )
    .await;
    assert_eq!(st, 413, "{q}");
    assert_eq!(q["error"], "quota");

    let (st, headers, _) = http(
        addr,
        "OPTIONS",
        "/v1/account/login",
        &[
            ("Origin", "https://example.com"),
            ("Access-Control-Request-Method", "POST"),
            (
                "Access-Control-Request-Headers",
                "authorization,content-type",
            ),
        ],
        None,
    )
    .await;
    assert!(st == 200 || st == 204, "preflight {st}");
    let allow_origin = headers
        .get("access-control-allow-origin")
        .map(String::as_str)
        .unwrap_or("");
    assert_eq!(allow_origin, "*");

    let (_, headers, _) = http(
        addr,
        "GET",
        "/v1/account/lookup?username=quota_user",
        &[("Origin", "https://example.com")],
        None,
    )
    .await;
    assert_eq!(
        headers
            .get("access-control-allow-origin")
            .map(String::as_str),
        Some("*")
    );

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn static_web_und_info_fallback() {
    let web = tempfile::tempdir().unwrap();
    std::fs::write(
        web.path().join("index.html"),
        "<!doctype html><title>web</title>APP",
    )
    .unwrap();
    std::fs::create_dir_all(web.path().join("assets")).unwrap();
    let mut f = std::fs::File::create(web.path().join("assets").join("app.js")).unwrap();
    f.write_all(b"console.log(1)").unwrap();

    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::test(dir.path().to_path_buf(), 0);
    config.web_dir = web.path().to_path_buf();
    let (addr, stop) = spawn_server(config).await;

    let (st, headers, body) = http(addr, "GET", "/", &[], None).await;
    assert_eq!(st, 200);
    let page = String::from_utf8_lossy(&body);
    assert!(page.contains("APP"), "{page}");
    assert_eq!(
        headers.get("cache-control").map(String::as_str),
        Some("no-cache")
    );
    assert!(
        headers
            .get("content-security-policy")
            .map(|s| s.contains("frame-ancestors 'none'"))
            .unwrap_or(false),
        "{headers:?}"
    );
    assert_eq!(
        headers.get("permissions-policy").map(String::as_str),
        Some("microphone=(self)")
    );

    let (st, _, body) = http(addr, "GET", "/does/not/exist", &[], None).await;
    assert_eq!(st, 200);
    assert!(String::from_utf8_lossy(&body).contains("APP"));

    let (st, headers, body) = http(addr, "GET", "/assets/app.js", &[], None).await;
    assert_eq!(st, 200);
    assert_eq!(body, b"console.log(1)");
    assert!(
        headers
            .get("cache-control")
            .map(|s| s.contains("immutable"))
            .unwrap_or(false),
        "{headers:?}"
    );
    let ct = headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    assert!(
        ct.contains("javascript") || ct.contains("ecmascript"),
        "{ct}"
    );

    let (st, headers, body) = http(addr, "GET", "/assets/fehlt.js", &[], None).await;
    assert_eq!(st, 404);
    assert!(
        !String::from_utf8_lossy(&body).contains("APP"),
        "fehlendes Asset darf kein SPA-index sein"
    );
    assert!(
        headers
            .get("cache-control")
            .map(|s| !s.contains("immutable"))
            .unwrap_or(true),
        "404 unter /assets/* ohne immutable: {headers:?}"
    );

    let (st, _, body) = http(addr, "GET", "/v1/gibtsnicht", &[], None).await;
    assert_eq!(st, 404);
    let missing = parse_json(&body);
    assert_eq!(missing["error"], "not_found");
    assert!(
        !String::from_utf8_lossy(&body).contains("APP"),
        "/v1/* darf kein index.html sein"
    );

    let (st, _, body) = http(addr, "GET", "/info", &[], None).await;
    assert_eq!(st, 200);
    assert!(String::from_utf8_lossy(&body).contains("BlueTalk Cloud Relay"));

    let _ = stop.send(true);

    let dir2 = tempfile::tempdir().unwrap();
    let config = Config::test(dir2.path().to_path_buf(), 0);
    let (addr, stop) = spawn_server(config).await;
    let (st, _, body) = http(addr, "GET", "/", &[], None).await;
    assert_eq!(st, 200);
    assert!(String::from_utf8_lossy(&body).contains("BlueTalk Cloud Relay"));
    let (st, _, body) = http(addr, "GET", "/info", &[], None).await;
    assert_eq!(st, 200);
    assert!(String::from_utf8_lossy(&body).contains("Offener Nachrichten-Vermittler"));
    let (st, _, body) = http(addr, "GET", "/v1/gibtsnicht", &[], None).await;
    assert_eq!(st, 404);
    assert_eq!(parse_json(&body)["error"], "not_found");
    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accounts_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::test(dir.path().to_path_buf(), 0);
    config.accounts_enabled = false;
    let (addr, stop) = spawn_server(config).await;
    let (st, _, _) = http(
        addr,
        "POST",
        "/v1/account/prelogin",
        &[],
        Some(br#"{"username":"abc"}"#),
    )
    .await;
    assert!(st == 404 || st == 405, "disabled {st}");
    let _ = stop.send(true);
}

async fn json_delete(
    addr: std::net::SocketAddr,
    path: &str,
    token: Option<&str>,
    body: &Value,
) -> (u16, Value) {
    let mut extra = Vec::new();
    let auth;
    if let Some(t) = token {
        auth = format!("Bearer {t}");
        extra.push(("Authorization", auth.as_str()));
    }
    let raw = json_body(body);
    let (st, _, b) = http(addr, "DELETE", path, &extra, Some(&raw)).await;
    (st, parse_json(&b))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn password_und_delete_rate_limit() {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::test(dir.path().to_path_buf(), 0);
    let (addr, stop) = spawn_server(config).await;
    let user = "pw_rate_user";
    let (st, reg) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(31, user, 32),
    )
    .await;
    assert_eq!(st, 201, "{reg}");
    let token = reg["token"].as_str().unwrap().to_string();

    let wrong_pw = json!({
        "currentAuthKey": b64_32(1),
        "kdf": kdf(),
        "authKey": b64_32(2),
        "vault": vault(),
    });
    for i in 0..5 {
        let (st, body) = json_post(addr, "/v1/account/password", Some(&token), &wrong_pw).await;
        assert_eq!(st, 401, "password {i} {body}");
        assert_eq!(body["error"], "invalid_credentials");
    }
    let (st, body) = json_post(addr, "/v1/account/password", Some(&token), &wrong_pw).await;
    assert_eq!(st, 429, "{body}");
    assert_eq!(body["error"], "rate");

    let user2 = "del_rate_user";
    let (st, reg2) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(33, user2, 34),
    )
    .await;
    assert_eq!(st, 201, "{reg2}");
    let token2 = reg2["token"].as_str().unwrap().to_string();
    let wrong_del = json!({"authKey": b64_32(1)});
    for i in 0..5 {
        let (st, body) = json_delete(addr, "/v1/account", Some(&token2), &wrong_del).await;
        assert_eq!(st, 401, "delete {i} {body}");
        assert_eq!(body["error"], "invalid_credentials");
    }
    let (st, body) = json_delete(addr, "/v1/account", Some(&token2), &wrong_del).await;
    assert_eq!(st, 429, "{body}");
    assert_eq!(body["error"], "rate");

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn login_ungueltiger_name_ohne_user_bucket() {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::test(dir.path().to_path_buf(), 0);
    let (addr, stop) = spawn_server(config).await;
    let user = "valid_login";
    let (st, reg) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(41, user, 42),
    )
    .await;
    assert_eq!(st, 201, "{reg}");

    for i in 0..4 {
        let name = format!("x{i}");
        let (st, body) = json_post(
            addr,
            "/v1/account/login",
            None,
            &json!({"username": name, "authKey": b64_32(1)}),
        )
        .await;
        assert_eq!(st, 401, "invalid name {name} {body}");
        assert_eq!(body["error"], "invalid_credentials");
    }

    let (st, login) = json_post(
        addr,
        "/v1/account/login",
        None,
        &json!({"username": user, "authKey": b64_32(42), "deviceName": "pc"}),
    )
    .await;
    assert_eq!(
        st, 200,
        "ungültige Namen dürfen keinen User-Bucket anlegen und das IP-Budget nicht sprengen: {login}"
    );

    let _ = stop.send(true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn register_rate_limit() {
    let dir = tempfile::tempdir().unwrap();
    let config = Config::test(dir.path().to_path_buf(), 0);
    let (addr, stop) = spawn_server(config).await;
    for i in 0..5 {
        let user = format!("reguser{i:02}");
        let seed = 50 + i as u8;
        let (st, body) = json_post(
            addr,
            "/v1/account/register",
            None,
            &register_body(seed, &user, seed.wrapping_add(10)),
        )
        .await;
        assert_eq!(st, 201, "{user} {body}");
    }
    let (st, body) = json_post(
        addr,
        "/v1/account/register",
        None,
        &register_body(99, "reguser99", 100),
    )
    .await;
    assert_eq!(st, 429, "{body}");
    assert_eq!(body["error"], "rate");
    let _ = stop.send(true);
}
