//! HTTP: /v1/account/* und /v1/sync/* inkl. CORS und Rate-Limits.

use std::net::SocketAddr;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State, rejection::JsonRejection},
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tower_http::cors::{Any, CorsLayer};

use crate::AppState;
use crate::accounts::{
    AccountError, PasswordIn, PushItem, RegisterIn, SYNC_DELETE_MAX_KEYS, SYNC_PULL_DEFAULT,
    SYNC_PULL_MAX, SYNC_PUSH_MAX_ITEMS, normalize_device_name, normalize_username,
};
use crate::util::client_ip;

const ACCOUNT_BODY_MAX: usize = 256 * 1024;
const PUSH_BODY_MAX: usize = 8 * 1024 * 1024;
const LOGIN_MAX: usize = 5;
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const LOOKUP_MAX: usize = 30;
const LOOKUP_WINDOW: Duration = Duration::from_secs(60);
const REGISTER_MAX: usize = 5;
const REGISTER_WINDOW: Duration = Duration::from_secs(3600);
const AUTHKEY_MAX: usize = 5;
const AUTHKEY_WINDOW: Duration = Duration::from_secs(60);

pub fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

pub fn account_router() -> Router<AppState> {
    Router::new()
        .route("/prelogin", post(prelogin))
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/me", get(me))
        .route("/logout", post(logout))
        .route("/password", post(password))
        .route("/", delete(delete_account))
        .route("/lookup", get(lookup))
        .layer(DefaultBodyLimit::max(ACCOUNT_BODY_MAX))
        .layer(cors())
}

pub fn sync_router() -> Router<AppState> {
    Router::new()
        .route(
            "/push",
            post(sync_push).layer(DefaultBodyLimit::max(PUSH_BODY_MAX)),
        )
        .route("/pull", get(sync_pull))
        .route("/delete", post(sync_delete))
        .layer(cors())
}

#[derive(Deserialize)]
struct UsernameBody {
    username: String,
}

#[derive(Deserialize)]
struct RegisterBody {
    username: String,
    kdf: Value,
    #[serde(rename = "authKey")]
    auth_key: String,
    vault: Value,
    #[serde(rename = "publicKey")]
    public_key: String,
    signature: String,
    #[serde(rename = "deviceName")]
    device_name: Option<String>,
}

#[derive(Deserialize)]
struct LoginBody {
    username: String,
    #[serde(rename = "authKey")]
    auth_key: String,
    #[serde(rename = "deviceName")]
    device_name: Option<String>,
}

#[derive(Deserialize)]
struct PasswordBody {
    #[serde(rename = "currentAuthKey")]
    current_auth_key: String,
    kdf: Value,
    #[serde(rename = "authKey")]
    auth_key: String,
    vault: Value,
}

#[derive(Deserialize)]
struct AuthKeyBody {
    #[serde(rename = "authKey")]
    auth_key: String,
}

#[derive(Deserialize)]
struct LookupQuery {
    username: Option<String>,
}

#[derive(Deserialize)]
struct PushBody {
    items: Vec<PushItemBody>,
}

#[derive(Deserialize)]
struct PushItemBody {
    key: String,
    data: String,
}

#[derive(Deserialize)]
struct PullQuery {
    after: Option<i64>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
struct DeleteKeysBody {
    keys: Vec<String>,
}

fn err(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({"error": code, "message": message}))).into_response()
}

fn map_err(e: AccountError) -> Response {
    match e {
        AccountError::Invalid => err(StatusCode::BAD_REQUEST, "invalid", "invalid request"),
        AccountError::UsernameTaken => {
            err(StatusCode::CONFLICT, "username_taken", "username taken")
        }
        AccountError::PeerTaken => err(
            StatusCode::CONFLICT,
            "peer_taken",
            "peer already registered",
        ),
        AccountError::InvalidCredentials => err(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "invalid credentials",
        ),
        AccountError::Unauthorized => err(StatusCode::UNAUTHORIZED, "unauthorized", "unauthorized"),
        AccountError::TooLarge => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "item exceeds 3 MiB",
        ),
        AccountError::Quota => err(
            StatusCode::PAYLOAD_TOO_LARGE,
            "quota",
            "sync quota exceeded",
        ),
        AccountError::NotFound => err(StatusCode::NOT_FOUND, "not_found", "not found"),
    }
}

#[allow(clippy::result_large_err)]
fn json_body<T: serde::de::DeserializeOwned>(
    body: Result<Json<T>, JsonRejection>,
) -> Result<T, Response> {
    match body {
        Ok(Json(v)) => Ok(v),
        Err(_) => Err(err(StatusCode::BAD_REQUEST, "invalid", "invalid json")),
    }
}

fn ip_of(state: &AppState, headers: &HeaderMap, addr: SocketAddr) -> std::net::IpAddr {
    client_ip(
        headers,
        addr,
        state.config.trust_proxy,
        state.config.client_ip_header.as_deref(),
    )
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = v
        .strip_prefix("Bearer ")
        .or_else(|| v.strip_prefix("bearer "))?;
    let t = rest.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

async fn session_of(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<crate::accounts::Session, Response> {
    let token = bearer(headers)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "unauthorized", "missing token"))?;
    state.accounts.auth(token).await.map_err(map_err)
}

async fn prelogin(
    State(state): State<AppState>,
    body: Result<Json<UsernameBody>, JsonRejection>,
) -> Response {
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(username) = normalize_username(&body.username) else {
        return err(StatusCode::BAD_REQUEST, "invalid", "invalid username");
    };
    match state.accounts.prelogin(username).await {
        Ok(out) => (StatusCode::OK, Json(json!({"kdf": out.kdf}))).into_response(),
        Err(e) => map_err(e),
    }
}

async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<RegisterBody>, JsonRejection>,
) -> Response {
    let ip = ip_of(&state, &headers, addr);
    if !state
        .windows
        .allow(&format!("reg:{ip}"), REGISTER_MAX, REGISTER_WINDOW)
    {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let Some(username) = normalize_username(&body.username) else {
        return err(StatusCode::BAD_REQUEST, "invalid", "invalid username");
    };
    let input = RegisterIn {
        username,
        kdf: body.kdf,
        auth_key: body.auth_key,
        vault: body.vault,
        public_key: body.public_key,
        signature: body.signature,
        device_name: normalize_device_name(body.device_name.as_deref().unwrap_or("")),
    };
    match state.accounts.register(input).await {
        Ok(out) => (
            StatusCode::CREATED,
            Json(json!({
                "token": out.token,
                "username": out.username,
                "peerId": out.peer_id,
            })),
        )
            .into_response(),
        Err(e) => map_err(e),
    }
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<LoginBody>, JsonRejection>,
) -> Response {
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let ip = ip_of(&state, &headers, addr);
    if !state
        .windows
        .allow(&format!("login-ip:{ip}"), LOGIN_MAX, LOGIN_WINDOW)
    {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    let Some(username) = normalize_username(&body.username) else {
        return err(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "invalid credentials",
        );
    };
    if !state
        .windows
        .allow(&format!("login-user:{username}"), LOGIN_MAX, LOGIN_WINDOW)
    {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    match state
        .accounts
        .login(
            username,
            body.auth_key,
            normalize_device_name(body.device_name.as_deref().unwrap_or("")),
        )
        .await
    {
        Ok(out) => (
            StatusCode::OK,
            Json(json!({
                "token": out.token,
                "username": out.username,
                "peerId": out.peer_id,
                "vault": out.vault,
                "kdf": out.kdf,
            })),
        )
            .into_response(),
        Err(e) => map_err(e),
    }
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    match state.accounts.me(sess.account_id).await {
        Ok(out) => (
            StatusCode::OK,
            Json(json!({
                "username": out.username,
                "peerId": out.peer_id,
                "createdAt": out.created_at,
                "usage": {"items": out.items, "bytes": out.bytes},
                "quota": {"bytes": state.config.sync_quota_bytes},
            })),
        )
            .into_response(),
        Err(e) => map_err(e),
    }
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let token = match bearer(&headers) {
        Some(t) => t,
        None => {
            return err(StatusCode::UNAUTHORIZED, "unauthorized", "missing token");
        }
    };
    match state.accounts.logout(token).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => map_err(e),
    }
}

fn allow_authkey(state: &AppState, ip: std::net::IpAddr, account_id: i64, kind: &str) -> bool {
    state
        .windows
        .allow(&format!("{kind}-ip:{ip}"), AUTHKEY_MAX, AUTHKEY_WINDOW)
        && state.windows.allow(
            &format!("{kind}-acct:{account_id}"),
            AUTHKEY_MAX,
            AUTHKEY_WINDOW,
        )
}

async fn password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<PasswordBody>, JsonRejection>,
) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let ip = ip_of(&state, &headers, addr);
    if !allow_authkey(&state, ip, sess.account_id, "password") {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    let input = PasswordIn {
        current_auth_key: body.current_auth_key,
        kdf: body.kdf,
        auth_key: body.auth_key,
        vault: body.vault,
    };
    match state
        .accounts
        .password(sess.account_id, input, String::new())
        .await
    {
        Ok(token) => (StatusCode::OK, Json(json!({"token": token}))).into_response(),
        Err(e) => map_err(e),
    }
}

async fn delete_account(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<AuthKeyBody>, JsonRejection>,
) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let ip = ip_of(&state, &headers, addr);
    if !allow_authkey(&state, ip, sess.account_id, "delete") {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    match state
        .accounts
        .delete_account(sess.account_id, body.auth_key)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => map_err(e),
    }
}

async fn lookup(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<LookupQuery>,
) -> Response {
    let ip = ip_of(&state, &headers, addr);
    if !state
        .windows
        .allow(&format!("lookup:{ip}"), LOOKUP_MAX, LOOKUP_WINDOW)
    {
        return err(StatusCode::TOO_MANY_REQUESTS, "rate", "rate limit");
    }
    let Some(raw) = q.username else {
        return err(StatusCode::BAD_REQUEST, "invalid", "invalid username");
    };
    let Some(username) = normalize_username(&raw) else {
        return err(StatusCode::BAD_REQUEST, "invalid", "invalid username");
    };
    match state.accounts.lookup(username).await {
        Ok(out) => (
            StatusCode::OK,
            Json(json!({"username": out.username, "peerId": out.peer_id})),
        )
            .into_response(),
        Err(e) => map_err(e),
    }
}

async fn sync_push(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<PushBody>, JsonRejection>,
) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if body.items.len() > SYNC_PUSH_MAX_ITEMS {
        return err(StatusCode::BAD_REQUEST, "invalid", "too many items");
    }
    let items: Vec<PushItem> = body
        .items
        .into_iter()
        .map(|i| PushItem {
            key: i.key,
            data: i.data,
        })
        .collect();
    match state
        .accounts
        .push(sess.account_id, items, state.config.sync_quota_bytes)
        .await
    {
        Ok(out) => {
            state.hub.notify_sync(&sess.peer_id, out.latest_seq);
            let results: Vec<Value> = out
                .results
                .iter()
                .map(|(k, seq)| json!({"key": k, "seq": seq}))
                .collect();
            (
                StatusCode::OK,
                Json(json!({"results": results, "latestSeq": out.latest_seq})),
            )
                .into_response()
        }
        Err(e) => map_err(e),
    }
}

async fn sync_pull(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PullQuery>,
) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let after = q.after.unwrap_or(0).max(0);
    let limit = q.limit.unwrap_or(SYNC_PULL_DEFAULT).clamp(1, SYNC_PULL_MAX);
    match state.accounts.pull(sess.account_id, after, limit).await {
        Ok(out) => {
            let items: Vec<Value> = out
                .items
                .iter()
                .map(|r| {
                    json!({
                        "seq": r.seq,
                        "key": r.key,
                        "data": r.data,
                        "ts": r.ts,
                    })
                })
                .collect();
            (
                StatusCode::OK,
                Json(json!({
                    "items": items,
                    "latestSeq": out.latest_seq,
                    "more": out.more,
                })),
            )
                .into_response()
        }
        Err(e) => map_err(e),
    }
}

async fn sync_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<DeleteKeysBody>, JsonRejection>,
) -> Response {
    let sess = match session_of(&state, &headers).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    let body = match json_body(body) {
        Ok(b) => b,
        Err(r) => return r,
    };
    if body.keys.len() > SYNC_DELETE_MAX_KEYS {
        return err(StatusCode::BAD_REQUEST, "invalid", "too many keys");
    }
    match state.accounts.delete_keys(sess.account_id, body.keys).await {
        Ok(n) => (StatusCode::OK, Json(json!({"deleted": n}))).into_response(),
        Err(e) => map_err(e),
    }
}
