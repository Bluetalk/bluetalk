//! Konten, Tokens und verschlüsselter Sync (Zero-Knowledge, ACCOUNTS.md).

use std::path::Path;

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE, URL_SAFE_NO_PAD},
};
use ed25519_dalek::{Signature, VerifyingKey};
use hmac::{Hmac, Mac};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot};

use crate::auth::peer_id_from_pubkey;
use crate::db;
use crate::util::{ct_eq, random_bytes, unix_ms};

type HmacSha256 = Hmac<Sha256>;

pub const VAULT_MAX_BYTES: usize = 64 * 1024;
pub const SYNC_ITEM_MAX_BYTES: usize = 3 * 1024 * 1024;
pub const SYNC_PUSH_MAX_ITEMS: usize = 100;
pub const SYNC_DELETE_MAX_KEYS: usize = 500;
pub const SYNC_PULL_DEFAULT: u32 = 200;
pub const SYNC_PULL_MAX: u32 = 500;
const TOKEN_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const MAX_TOKENS: i64 = 20;
const KDF_ITERATIONS: u64 = 600_000;
const DEVICE_NAME_MAX: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountError {
    Invalid,
    UsernameTaken,
    PeerTaken,
    InvalidCredentials,
    Unauthorized,
    TooLarge,
    Quota,
    NotFound,
}

#[derive(Debug, Clone)]
pub struct Session {
    pub account_id: i64,
    #[allow(dead_code)]
    pub username: String,
    pub peer_id: String,
}

#[derive(Debug, Clone)]
pub struct KdfOut {
    pub kdf: Value,
}

#[derive(Debug, Clone)]
pub struct RegisterOut {
    pub token: String,
    pub username: String,
    pub peer_id: String,
}

#[derive(Debug, Clone)]
pub struct LoginOut {
    pub token: String,
    pub username: String,
    pub peer_id: String,
    pub vault: Value,
    pub kdf: Value,
}

#[derive(Debug, Clone)]
pub struct MeOut {
    pub username: String,
    pub peer_id: String,
    pub created_at: i64,
    pub items: i64,
    pub bytes: i64,
}

#[derive(Debug, Clone)]
pub struct LookupOut {
    pub username: String,
    pub peer_id: String,
}

#[derive(Debug, Clone)]
pub struct PushItem {
    pub key: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct PushOut {
    pub results: Vec<(String, i64)>,
    pub latest_seq: i64,
}

#[derive(Debug, Clone)]
pub struct SyncRow {
    pub seq: i64,
    pub key: String,
    pub data: String,
    pub ts: i64,
}

#[derive(Debug, Clone)]
pub struct PullOut {
    pub items: Vec<SyncRow>,
    pub latest_seq: i64,
    pub more: bool,
}

pub struct RegisterIn {
    pub username: String,
    pub kdf: Value,
    pub auth_key: String,
    pub vault: Value,
    pub public_key: String,
    pub signature: String,
    pub device_name: String,
}

pub struct PasswordIn {
    pub current_auth_key: String,
    pub kdf: Value,
    pub auth_key: String,
    pub vault: Value,
}

enum Job {
    Prelogin {
        username: String,
        reply: oneshot::Sender<Result<KdfOut, AccountError>>,
    },
    Register {
        input: Box<RegisterIn>,
        reply: oneshot::Sender<Result<RegisterOut, AccountError>>,
    },
    Login {
        username: String,
        auth_key: String,
        device_name: String,
        reply: oneshot::Sender<Result<LoginOut, AccountError>>,
    },
    Auth {
        token: String,
        reply: oneshot::Sender<Result<Session, AccountError>>,
    },
    Logout {
        token: String,
        reply: oneshot::Sender<Result<(), AccountError>>,
    },
    Me {
        account_id: i64,
        reply: oneshot::Sender<Result<MeOut, AccountError>>,
    },
    Password {
        account_id: i64,
        input: Box<PasswordIn>,
        device_name: String,
        reply: oneshot::Sender<Result<String, AccountError>>,
    },
    DeleteAccount {
        account_id: i64,
        auth_key: String,
        reply: oneshot::Sender<Result<(), AccountError>>,
    },
    Lookup {
        username: String,
        reply: oneshot::Sender<Result<LookupOut, AccountError>>,
    },
    Push {
        account_id: i64,
        items: Vec<PushItem>,
        quota: i64,
        reply: oneshot::Sender<Result<PushOut, AccountError>>,
    },
    Pull {
        account_id: i64,
        after: i64,
        limit: u32,
        reply: oneshot::Sender<Result<PullOut, AccountError>>,
    },
    DeleteKeys {
        account_id: i64,
        keys: Vec<String>,
        reply: oneshot::Sender<Result<u64, AccountError>>,
    },
}

#[derive(Clone)]
pub struct AccountStore {
    tx: mpsc::Sender<Job>,
}

impl AccountStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = db::open(path)?;
        let (tx, mut rx) = mpsc::channel::<Job>(64);
        std::thread::Builder::new()
            .name("bluetalk-accounts".into())
            .spawn(move || {
                let mut conn = conn;
                while let Some(job) = rx.blocking_recv() {
                    handle(&mut conn, job);
                }
            })
            .map_err(|e| format!("accounts thread: {e}"))?;
        Ok(Self { tx })
    }

    pub async fn prelogin(&self, username: String) -> Result<KdfOut, AccountError> {
        self.call(|reply| Job::Prelogin { username, reply }).await
    }

    pub async fn register(&self, input: RegisterIn) -> Result<RegisterOut, AccountError> {
        self.call(|reply| Job::Register {
            input: Box::new(input),
            reply,
        })
        .await
    }

    pub async fn login(
        &self,
        username: String,
        auth_key: String,
        device_name: String,
    ) -> Result<LoginOut, AccountError> {
        self.call(|reply| Job::Login {
            username,
            auth_key,
            device_name,
            reply,
        })
        .await
    }

    pub async fn auth(&self, token: String) -> Result<Session, AccountError> {
        self.call(|reply| Job::Auth { token, reply }).await
    }

    pub async fn logout(&self, token: String) -> Result<(), AccountError> {
        self.call(|reply| Job::Logout { token, reply }).await
    }

    pub async fn me(&self, account_id: i64) -> Result<MeOut, AccountError> {
        self.call(|reply| Job::Me { account_id, reply }).await
    }

    pub async fn password(
        &self,
        account_id: i64,
        input: PasswordIn,
        device_name: String,
    ) -> Result<String, AccountError> {
        self.call(|reply| Job::Password {
            account_id,
            input: Box::new(input),
            device_name,
            reply,
        })
        .await
    }

    pub async fn delete_account(
        &self,
        account_id: i64,
        auth_key: String,
    ) -> Result<(), AccountError> {
        self.call(|reply| Job::DeleteAccount {
            account_id,
            auth_key,
            reply,
        })
        .await
    }

    pub async fn lookup(&self, username: String) -> Result<LookupOut, AccountError> {
        self.call(|reply| Job::Lookup { username, reply }).await
    }

    pub async fn push(
        &self,
        account_id: i64,
        items: Vec<PushItem>,
        quota: i64,
    ) -> Result<PushOut, AccountError> {
        self.call(|reply| Job::Push {
            account_id,
            items,
            quota,
            reply,
        })
        .await
    }

    pub async fn pull(
        &self,
        account_id: i64,
        after: i64,
        limit: u32,
    ) -> Result<PullOut, AccountError> {
        self.call(|reply| Job::Pull {
            account_id,
            after,
            limit,
            reply,
        })
        .await
    }

    pub async fn delete_keys(
        &self,
        account_id: i64,
        keys: Vec<String>,
    ) -> Result<u64, AccountError> {
        self.call(|reply| Job::DeleteKeys {
            account_id,
            keys,
            reply,
        })
        .await
    }

    async fn call<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, AccountError>>) -> Job,
    ) -> Result<T, AccountError> {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(make(reply)).await.is_err() {
            return Err(AccountError::Invalid);
        }
        rx.await.unwrap_or(Err(AccountError::Invalid))
    }
}

fn handle(conn: &mut Connection, job: Job) {
    match job {
        Job::Prelogin { username, reply } => {
            let _ = reply.send(prelogin_sql(conn, &username));
        }
        Job::Register { input, reply } => {
            let _ = reply.send(register_sql(conn, &input));
        }
        Job::Login {
            username,
            auth_key,
            device_name,
            reply,
        } => {
            let _ = reply.send(login_sql(conn, &username, &auth_key, &device_name));
        }
        Job::Auth { token, reply } => {
            let _ = reply.send(auth_sql(conn, &token));
        }
        Job::Logout { token, reply } => {
            let _ = reply.send(logout_sql(conn, &token));
        }
        Job::Me { account_id, reply } => {
            let _ = reply.send(me_sql(conn, account_id));
        }
        Job::Password {
            account_id,
            input,
            device_name,
            reply,
        } => {
            let _ = reply.send(password_sql(conn, account_id, &input, &device_name));
        }
        Job::DeleteAccount {
            account_id,
            auth_key,
            reply,
        } => {
            let _ = reply.send(delete_account_sql(conn, account_id, &auth_key));
        }
        Job::Lookup { username, reply } => {
            let _ = reply.send(lookup_sql(conn, &username));
        }
        Job::Push {
            account_id,
            items,
            quota,
            reply,
        } => {
            let _ = reply.send(push_sql(conn, account_id, &items, quota));
        }
        Job::Pull {
            account_id,
            after,
            limit,
            reply,
        } => {
            let _ = reply.send(pull_sql(conn, account_id, after, limit));
        }
        Job::DeleteKeys {
            account_id,
            keys,
            reply,
        } => {
            let _ = reply.send(delete_keys_sql(conn, account_id, &keys));
        }
    }
}

pub fn normalize_username(raw: &str) -> Option<String> {
    let s = raw.trim().to_ascii_lowercase();
    if s.len() < 3 || s.len() > 32 {
        return None;
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    {
        return None;
    }
    Some(s)
}

pub fn normalize_device_name(raw: &str) -> String {
    let s: String = raw.chars().take(DEVICE_NAME_MAX).collect();
    s.trim().to_string()
}

pub fn valid_sync_key(k: &str) -> bool {
    let len = k.len();
    (1..=64).contains(&len)
        && k.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    BASE64
        .decode(s)
        .ok()
        .or_else(|| URL_SAFE_NO_PAD.decode(s).ok())
        .or_else(|| URL_SAFE.decode(s).ok())
}

fn hash_auth_key(auth_key_b64: &str) -> Option<[u8; 32]> {
    let raw = decode_b64(auth_key_b64)?;
    if raw.len() != 32 {
        return None;
    }
    Some(Sha256::digest(&raw).into())
}

fn dummy_auth_hash(secret: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(secret);
    h.update(b"dummy-auth");
    h.finalize().into()
}

fn fake_salt(secret: &[u8; 32], username: &str) -> [u8; 16] {
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac");
    mac.update(b"fake-salt:");
    mac.update(username.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&out[..16]);
    salt
}

fn fake_kdf(secret: &[u8; 32], username: &str) -> Value {
    json!({
        "alg": "pbkdf2-sha256",
        "iterations": KDF_ITERATIONS,
        "salt": BASE64.encode(fake_salt(secret, username)),
    })
}

fn parse_kdf(v: &Value) -> Option<Value> {
    let alg = v.get("alg")?.as_str()?;
    if alg != "pbkdf2-sha256" {
        return None;
    }
    let iterations = v.get("iterations")?.as_u64()?;
    if iterations != KDF_ITERATIONS {
        return None;
    }
    let salt = v.get("salt")?.as_str()?;
    let raw = decode_b64(salt)?;
    if raw.len() != 16 {
        return None;
    }
    Some(json!({
        "alg": "pbkdf2-sha256",
        "iterations": KDF_ITERATIONS,
        "salt": salt,
    }))
}

fn vault_json(v: &Value) -> Result<String, AccountError> {
    if !v.is_object() {
        return Err(AccountError::Invalid);
    }
    let raw = serde_json::to_vec(v).map_err(|_| AccountError::Invalid)?;
    if raw.len() > VAULT_MAX_BYTES {
        return Err(AccountError::Invalid);
    }
    String::from_utf8(raw).map_err(|_| AccountError::Invalid)
}

fn verify_register_sig(
    public_key: &[u8; 32],
    signature_b64: &str,
    username: &str,
    auth_key: &str,
) -> bool {
    let Some(sig_raw) = decode_b64(signature_b64) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_raw.as_slice()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    let payload = format!("bluetalk-account-register-v1\n{username}\n{auth_key}");
    vk.verify_strict(payload.as_bytes(), &Signature::from_bytes(&sig_arr))
        .is_ok()
}

fn issue_token(
    conn: &Connection,
    account_id: i64,
    device_name: &str,
) -> Result<String, AccountError> {
    prune_expired(conn, account_id);
    let mut raw = [0u8; 32];
    random_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let hash: [u8; 32] = Sha256::digest(raw).into();
    let now = unix_ms();
    conn.execute(
        "INSERT INTO account_tokens (hash, account_id, created_at, last_used, device_name)
         VALUES (?1, ?2, ?3, ?3, ?4)",
        params![hash.as_slice(), account_id, now, device_name],
    )
    .map_err(|_| AccountError::Invalid)?;
    cap_tokens(conn, account_id);
    Ok(token)
}

fn prune_expired(conn: &Connection, account_id: i64) {
    let cutoff = unix_ms() - TOKEN_TTL_MS;
    let _ = conn.execute(
        "DELETE FROM account_tokens WHERE account_id = ?1 AND last_used < ?2",
        params![account_id, cutoff],
    );
}

fn cap_tokens(conn: &Connection, account_id: i64) {
    let _ = conn.execute(
        "DELETE FROM account_tokens WHERE hash IN (
            SELECT hash FROM account_tokens
            WHERE account_id = ?1
            ORDER BY last_used ASC, created_at ASC
            LIMIT -1 OFFSET ?2
        )",
        params![account_id, MAX_TOKENS],
    );
}

fn decode_token(token: &str) -> Option<[u8; 32]> {
    let raw = URL_SAFE_NO_PAD
        .decode(token)
        .ok()
        .or_else(|| URL_SAFE.decode(token).ok())?;
    raw.try_into().ok()
}

fn secret_or_err(conn: &Connection) -> Result<[u8; 32], AccountError> {
    db::server_secret(conn).map_err(|_| AccountError::Invalid)
}

fn prelogin_sql(conn: &Connection, username: &str) -> Result<KdfOut, AccountError> {
    let secret = secret_or_err(conn)?;
    let fake = fake_kdf(&secret, username);
    let stored: Option<String> = conn
        .query_row(
            "SELECT kdf FROM accounts WHERE username = ?1",
            params![username],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| AccountError::Invalid)?;
    let kdf = match stored {
        Some(raw) => serde_json::from_str(&raw).unwrap_or(fake),
        None => fake,
    };
    Ok(KdfOut { kdf })
}

fn register_sql(conn: &Connection, input: &RegisterIn) -> Result<RegisterOut, AccountError> {
    let kdf = parse_kdf(&input.kdf).ok_or(AccountError::Invalid)?;
    let auth_hash = hash_auth_key(&input.auth_key).ok_or(AccountError::Invalid)?;
    let vault = vault_json(&input.vault)?;
    let pk_raw = decode_b64(&input.public_key).ok_or(AccountError::Invalid)?;
    let pk: [u8; 32] = pk_raw.try_into().map_err(|_| AccountError::Invalid)?;
    if !verify_register_sig(&pk, &input.signature, &input.username, &input.auth_key) {
        return Err(AccountError::Invalid);
    }
    let peer_id = peer_id_from_pubkey(&pk);
    let exists_user: Option<i64> = conn
        .query_row(
            "SELECT id FROM accounts WHERE username = ?1",
            params![input.username],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| AccountError::Invalid)?;
    if exists_user.is_some() {
        return Err(AccountError::UsernameTaken);
    }
    let exists_peer: Option<i64> = conn
        .query_row(
            "SELECT id FROM accounts WHERE peer_id = ?1",
            params![peer_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| AccountError::Invalid)?;
    if exists_peer.is_some() {
        return Err(AccountError::PeerTaken);
    }
    let kdf_s = serde_json::to_string(&kdf).map_err(|_| AccountError::Invalid)?;
    let now = unix_ms();
    conn.execute(
        "INSERT INTO accounts (username, peer_id, auth_key_hash, kdf, vault, public_key, created_at, next_seq, used_bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, 0)",
        params![
            input.username,
            peer_id,
            auth_hash.as_slice(),
            kdf_s,
            vault,
            pk.as_slice(),
            now
        ],
    )
    .map_err(|e| {
        if is_unique(&e) {
            AccountError::UsernameTaken
        } else {
            AccountError::Invalid
        }
    })?;
    let account_id = conn.last_insert_rowid();
    let token = issue_token(conn, account_id, &input.device_name)?;
    tracing::info!(user = %input.username, peer = %crate::util::short_id(&peer_id), "konto");
    Ok(RegisterOut {
        token,
        username: input.username.clone(),
        peer_id,
    })
}

fn login_sql(
    conn: &Connection,
    username: &str,
    auth_key: &str,
    device_name: &str,
) -> Result<LoginOut, AccountError> {
    let secret = secret_or_err(conn)?;
    let dummy = dummy_auth_hash(&secret);
    let row = conn
        .query_row(
            "SELECT id, peer_id, auth_key_hash, kdf, vault FROM accounts WHERE username = ?1",
            params![username],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|_| AccountError::Invalid)?;
    let provided = hash_auth_key(auth_key);
    let (account_id, peer_id, stored_hash, kdf_s, vault_s) = match row {
        Some(r) => r,
        None => {
            let h = provided.unwrap_or([0u8; 32]);
            let _ = ct_eq(&h, &dummy);
            return Err(AccountError::InvalidCredentials);
        }
    };
    let Some(h) = provided else {
        let _ = ct_eq(&dummy, stored_hash.as_slice());
        return Err(AccountError::InvalidCredentials);
    };
    if !ct_eq(&h, stored_hash.as_slice()) {
        return Err(AccountError::InvalidCredentials);
    }
    let kdf: Value = serde_json::from_str(&kdf_s).unwrap_or(Value::Null);
    let vault: Value = serde_json::from_str(&vault_s).unwrap_or(Value::Null);
    let token = issue_token(conn, account_id, device_name)?;
    Ok(LoginOut {
        token,
        username: username.to_string(),
        peer_id,
        vault,
        kdf,
    })
}

fn auth_sql(conn: &Connection, token: &str) -> Result<Session, AccountError> {
    let raw = decode_token(token).ok_or(AccountError::Unauthorized)?;
    let hash: [u8; 32] = Sha256::digest(raw).into();
    let now = unix_ms();
    let cutoff = now - TOKEN_TTL_MS;
    let row = conn
        .query_row(
            "SELECT t.account_id, a.username, a.peer_id, t.last_used
             FROM account_tokens t
             JOIN accounts a ON a.id = t.account_id
             WHERE t.hash = ?1",
            params![hash.as_slice()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| AccountError::Unauthorized)?;
    let Some((account_id, username, peer_id, last_used)) = row else {
        return Err(AccountError::Unauthorized);
    };
    if last_used < cutoff {
        let _ = conn.execute(
            "DELETE FROM account_tokens WHERE hash = ?1",
            params![hash.as_slice()],
        );
        return Err(AccountError::Unauthorized);
    }
    let _ = conn.execute(
        "UPDATE account_tokens SET last_used = ?1 WHERE hash = ?2",
        params![now, hash.as_slice()],
    );
    Ok(Session {
        account_id,
        username,
        peer_id,
    })
}

fn logout_sql(conn: &Connection, token: &str) -> Result<(), AccountError> {
    let raw = decode_token(token).ok_or(AccountError::Unauthorized)?;
    let hash: [u8; 32] = Sha256::digest(raw).into();
    let n = conn
        .execute(
            "DELETE FROM account_tokens WHERE hash = ?1",
            params![hash.as_slice()],
        )
        .map_err(|_| AccountError::Invalid)?;
    if n == 0 {
        return Err(AccountError::Unauthorized);
    }
    Ok(())
}

fn me_sql(conn: &Connection, account_id: i64) -> Result<MeOut, AccountError> {
    let (username, peer_id, created_at, bytes): (String, String, i64, i64) = conn
        .query_row(
            "SELECT username, peer_id, created_at, used_bytes FROM accounts WHERE id = ?1",
            params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| AccountError::Unauthorized)?;
    let items: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sync_items WHERE account_id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    Ok(MeOut {
        username,
        peer_id,
        created_at,
        items,
        bytes,
    })
}

fn password_sql(
    conn: &Connection,
    account_id: i64,
    input: &PasswordIn,
    device_name: &str,
) -> Result<String, AccountError> {
    let stored: Vec<u8> = conn
        .query_row(
            "SELECT auth_key_hash FROM accounts WHERE id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| AccountError::Unauthorized)?;
    let Some(h) = hash_auth_key(&input.current_auth_key) else {
        return Err(AccountError::InvalidCredentials);
    };
    if !ct_eq(&h, stored.as_slice()) {
        return Err(AccountError::InvalidCredentials);
    }
    let kdf = parse_kdf(&input.kdf).ok_or(AccountError::Invalid)?;
    let new_hash = hash_auth_key(&input.auth_key).ok_or(AccountError::Invalid)?;
    let vault = vault_json(&input.vault)?;
    let kdf_s = serde_json::to_string(&kdf).map_err(|_| AccountError::Invalid)?;
    conn.execute(
        "UPDATE accounts SET auth_key_hash = ?1, kdf = ?2, vault = ?3 WHERE id = ?4",
        params![new_hash.as_slice(), kdf_s, vault, account_id],
    )
    .map_err(|_| AccountError::Invalid)?;
    let _ = conn.execute(
        "DELETE FROM account_tokens WHERE account_id = ?1",
        params![account_id],
    );
    issue_token(conn, account_id, device_name)
}

fn delete_account_sql(
    conn: &mut Connection,
    account_id: i64,
    auth_key: &str,
) -> Result<(), AccountError> {
    let tx = conn.transaction().map_err(|_| AccountError::Invalid)?;
    let stored: Vec<u8> = tx
        .query_row(
            "SELECT auth_key_hash FROM accounts WHERE id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| AccountError::Unauthorized)?;
    let Some(h) = hash_auth_key(auth_key) else {
        return Err(AccountError::InvalidCredentials);
    };
    if !ct_eq(&h, stored.as_slice()) {
        return Err(AccountError::InvalidCredentials);
    }
    tx.execute("DELETE FROM accounts WHERE id = ?1", params![account_id])
        .map_err(|_| AccountError::Invalid)?;
    tx.commit().map_err(|_| AccountError::Invalid)?;
    Ok(())
}

fn lookup_sql(conn: &Connection, username: &str) -> Result<LookupOut, AccountError> {
    conn.query_row(
        "SELECT username, peer_id FROM accounts WHERE username = ?1",
        params![username],
        |row| {
            Ok(LookupOut {
                username: row.get(0)?,
                peer_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(|_| AccountError::Invalid)?
    .ok_or(AccountError::NotFound)
}

fn push_sql(
    conn: &mut Connection,
    account_id: i64,
    items: &[PushItem],
    quota: i64,
) -> Result<PushOut, AccountError> {
    if items.len() > SYNC_PUSH_MAX_ITEMS {
        return Err(AccountError::Invalid);
    }
    for item in items {
        if !valid_sync_key(&item.key) {
            return Err(AccountError::Invalid);
        }
        if item.data.len() > SYNC_ITEM_MAX_BYTES {
            return Err(AccountError::TooLarge);
        }
    }
    let tx = conn.transaction().map_err(|_| AccountError::Invalid)?;
    let (mut current, mut next_seq): (i64, i64) = tx
        .query_row(
            "SELECT used_bytes, next_seq FROM accounts WHERE id = ?1",
            params![account_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| AccountError::Unauthorized)?;
    let now = unix_ms();
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        let old: i64 = tx
            .query_row(
                "SELECT length(data) FROM sync_items WHERE account_id = ?1 AND key = ?2",
                params![account_id, item.key],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten()
            .unwrap_or(0);
        let new_total = current
            .saturating_sub(old)
            .saturating_add(item.data.len() as i64);
        if new_total > quota {
            return Err(AccountError::Quota);
        }
        next_seq += 1;
        tx.execute(
            "INSERT INTO sync_items (account_id, key, seq, data, ts)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(account_id, key) DO UPDATE SET
                seq = excluded.seq,
                data = excluded.data,
                ts = excluded.ts",
            params![account_id, item.key, next_seq, item.data, now],
        )
        .map_err(|_| AccountError::Invalid)?;
        current = new_total;
        results.push((item.key.clone(), next_seq));
    }
    tx.execute(
        "UPDATE accounts SET next_seq = ?1, used_bytes = ?2 WHERE id = ?3",
        params![next_seq, current, account_id],
    )
    .map_err(|_| AccountError::Invalid)?;
    tx.commit().map_err(|_| AccountError::Invalid)?;
    Ok(PushOut {
        results,
        latest_seq: next_seq,
    })
}

fn pull_sql(
    conn: &Connection,
    account_id: i64,
    after: i64,
    limit: u32,
) -> Result<PullOut, AccountError> {
    let latest_seq: i64 = conn
        .query_row(
            "SELECT next_seq FROM accounts WHERE id = ?1",
            params![account_id],
            |row| row.get(0),
        )
        .map_err(|_| AccountError::Unauthorized)?;
    let fetch = i64::from(limit) + 1;
    let mut stmt = conn
        .prepare(
            "SELECT seq, key, data, ts FROM sync_items
             WHERE account_id = ?1 AND seq > ?2
             ORDER BY seq ASC
             LIMIT ?3",
        )
        .map_err(|_| AccountError::Invalid)?;
    let rows = stmt
        .query_map(params![account_id, after, fetch], |row| {
            Ok(SyncRow {
                seq: row.get(0)?,
                key: row.get(1)?,
                data: row.get(2)?,
                ts: row.get(3)?,
            })
        })
        .map_err(|_| AccountError::Invalid)?;
    let mut items: Vec<SyncRow> = rows.flatten().collect();
    let more = items.len() as u32 > limit;
    if more {
        items.truncate(limit as usize);
    }
    Ok(PullOut {
        items,
        latest_seq,
        more,
    })
}

fn delete_keys_sql(
    conn: &mut Connection,
    account_id: i64,
    keys: &[String],
) -> Result<u64, AccountError> {
    if keys.len() > SYNC_DELETE_MAX_KEYS {
        return Err(AccountError::Invalid);
    }
    let tx = conn.transaction().map_err(|_| AccountError::Invalid)?;
    let mut n = 0u64;
    let mut freed = 0i64;
    {
        let mut sel = tx
            .prepare("SELECT length(data) FROM sync_items WHERE account_id = ?1 AND key = ?2")
            .map_err(|_| AccountError::Invalid)?;
        let mut del = tx
            .prepare("DELETE FROM sync_items WHERE account_id = ?1 AND key = ?2")
            .map_err(|_| AccountError::Invalid)?;
        for key in keys {
            if !valid_sync_key(key) {
                continue;
            }
            let len: Option<i64> = sel
                .query_row(params![account_id, key], |row| row.get(0))
                .optional()
                .map_err(|_| AccountError::Invalid)?;
            let Some(len) = len else {
                continue;
            };
            let deleted = del
                .execute(params![account_id, key])
                .map_err(|_| AccountError::Invalid)?;
            if deleted > 0 {
                n += deleted as u64;
                freed = freed.saturating_add(len);
            }
        }
    }
    if n > 0 {
        tx.execute(
            "UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?1) WHERE id = ?2",
            params![freed, account_id],
        )
        .map_err(|_| AccountError::Invalid)?;
    }
    tx.commit().map_err(|_| AccountError::Invalid)?;
    Ok(n)
}

fn is_unique(e: &rusqlite::Error) -> bool {
    matches!(
        e.sqlite_error_code(),
        Some(rusqlite::ErrorCode::ConstraintViolation)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn store() -> (AccountStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let s = AccountStore::open(&dir.path().join("relay.db")).unwrap();
        (s, dir)
    }

    fn b64_32(seed: u8) -> String {
        BASE64.encode([seed; 32])
    }

    fn kdf() -> Value {
        json!({
            "alg": "pbkdf2-sha256",
            "iterations": 600000,
            "salt": BASE64.encode([0xABu8; 16]),
        })
    }

    fn vault() -> Value {
        json!({"v": 1, "iv": BASE64.encode([1u8; 12]), "ct": BASE64.encode([2u8; 32])})
    }

    fn register_for(seed: u8, user: &str, auth_seed: u8) -> RegisterIn {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let auth_key = b64_32(auth_seed);
        let payload = format!("bluetalk-account-register-v1\n{user}\n{auth_key}");
        let sig = BASE64.encode(sk.sign(payload.as_bytes()).to_bytes());
        RegisterIn {
            username: user.to_string(),
            kdf: kdf(),
            auth_key,
            vault: vault(),
            public_key: BASE64.encode(sk.verifying_key().as_bytes()),
            signature: sig,
            device_name: "test".into(),
        }
    }

    #[test]
    fn username_regeln() {
        assert_eq!(
            normalize_username("  Alice_1  ").as_deref(),
            Some("alice_1")
        );
        assert!(normalize_username("ab").is_none());
        assert!(normalize_username("bad name").is_none());
        assert!(valid_sync_key("AbC_-123"));
        assert!(!valid_sync_key("has.dot"));
        assert!(!valid_sync_key(""));
    }

    #[tokio::test]
    async fn fake_salt_stabil() {
        let (s, _dir) = store();
        let a = s.prelogin("nobody_here".into()).await.unwrap();
        let b = s.prelogin("nobody_here".into()).await.unwrap();
        assert_eq!(a.kdf, b.kdf);
        let c = s.prelogin("other_nobody".into()).await.unwrap();
        assert_ne!(a.kdf["salt"], c.kdf["salt"]);
        assert_eq!(a.kdf["alg"], "pbkdf2-sha256");
        assert_eq!(a.kdf["iterations"], 600000);
    }

    #[tokio::test]
    async fn register_login_token_sync() {
        let (s, _dir) = store();
        let user = "alice_test";
        let auth = b64_32(9);
        let mut input = register_for(3, user, 9);
        input.auth_key = auth.clone();
        let sk = SigningKey::from_bytes(&[3u8; 32]);
        let payload = format!("bluetalk-account-register-v1\n{user}\n{auth}");
        input.signature = BASE64.encode(sk.sign(payload.as_bytes()).to_bytes());

        let pre = s.prelogin(user.into()).await.unwrap();
        let fake_salt = pre.kdf["salt"].clone();

        let reg = s.register(input).await.unwrap();
        assert_eq!(reg.username, user);
        assert!(reg.peer_id.starts_with("bt2_"));

        let pre2 = s.prelogin(user.into()).await.unwrap();
        assert_ne!(pre2.kdf["salt"], fake_salt);
        assert_eq!(pre2.kdf["salt"], kdf()["salt"]);

        let taken = s.register(register_for(4, user, 10)).await.err();
        assert_eq!(taken, Some(AccountError::UsernameTaken));

        let peer_again = register_for(3, "bob_test", 11);
        assert_eq!(
            s.register(peer_again).await.err(),
            Some(AccountError::PeerTaken)
        );

        assert_eq!(
            s.login(user.into(), b64_32(1), "x".into()).await.err(),
            Some(AccountError::InvalidCredentials)
        );
        let login = s
            .login(user.into(), auth.clone(), "phone".into())
            .await
            .unwrap();
        assert_eq!(login.username, user);
        assert_eq!(login.peer_id, reg.peer_id);

        s.auth(login.token.clone()).await.unwrap();
        s.logout(login.token.clone()).await.unwrap();
        assert_eq!(
            s.auth(login.token).await.err(),
            Some(AccountError::Unauthorized)
        );

        let login = s
            .login(user.into(), auth.clone(), "phone".into())
            .await
            .unwrap();
        let sess = s.auth(login.token.clone()).await.unwrap();

        let a = s
            .push(
                sess.account_id,
                vec![PushItem {
                    key: "k1".into(),
                    data: "aaa".into(),
                }],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(a.results[0].1, 1);
        let b = s
            .push(
                sess.account_id,
                vec![PushItem {
                    key: "k1".into(),
                    data: "bbbb".into(),
                }],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(b.results[0].1, 2);
        assert_eq!(b.latest_seq, 2);
        let pull = s.pull(sess.account_id, 0, 200).await.unwrap();
        assert_eq!(pull.items.len(), 1);
        assert_eq!(pull.items[0].seq, 2);
        assert_eq!(pull.items[0].data, "bbbb");
        assert_eq!(pull.latest_seq, 2);

        let n = s
            .delete_keys(sess.account_id, vec!["k1".into()])
            .await
            .unwrap();
        assert_eq!(n, 1);
        let c = s
            .push(
                sess.account_id,
                vec![PushItem {
                    key: "k2".into(),
                    data: "x".into(),
                }],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(c.results[0].1, 3, "seq nie wiederverwendet");
        assert_eq!(c.latest_seq, 3);

        let too = s
            .push(
                sess.account_id,
                vec![PushItem {
                    key: "big".into(),
                    data: "y".repeat(SYNC_ITEM_MAX_BYTES + 1),
                }],
                10_000_000,
            )
            .await
            .err();
        assert_eq!(too, Some(AccountError::TooLarge));

        let q = s
            .push(
                sess.account_id,
                vec![PushItem {
                    key: "q".into(),
                    data: "12345".into(),
                }],
                4,
            )
            .await
            .err();
        assert_eq!(q, Some(AccountError::Quota));

        let me = s.me(sess.account_id).await.unwrap();
        assert_eq!(me.items, 1);
        assert_eq!(me.bytes, 1, "used_bytes nach upsert/delete");
    }

    #[tokio::test]
    async fn used_bytes_migration_und_pflege() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.db");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "
                CREATE TABLE accounts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE,
                    peer_id TEXT NOT NULL UNIQUE,
                    auth_key_hash BLOB NOT NULL,
                    kdf TEXT NOT NULL,
                    vault TEXT NOT NULL,
                    public_key BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    next_seq INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE sync_items (
                    account_id INTEGER NOT NULL,
                    key TEXT NOT NULL,
                    seq INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    ts INTEGER NOT NULL,
                    PRIMARY KEY (account_id, key)
                );
                PRAGMA user_version = 1;
                ",
            )
            .unwrap();
            let blob = [0u8; 32];
            conn.execute(
                "INSERT INTO accounts (username, peer_id, auth_key_hash, kdf, vault, public_key, created_at, next_seq)
                 VALUES ('old_user', 'bt2_old', ?1, '{}', '{}', ?1, 1, 1)",
                rusqlite::params![blob.as_slice()],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_items (account_id, key, seq, data, ts)
                 VALUES (1, 'k', 1, 'hello', 1)",
                [],
            )
            .unwrap();
        }
        let s = AccountStore::open(&path).unwrap();
        let me = s.me(1).await.unwrap();
        assert_eq!(me.bytes, 5, "Migration initialisiert used_bytes aus SUM");
        assert_eq!(me.items, 1);

        s.push(
            1,
            vec![PushItem {
                key: "k".into(),
                data: "hellos".into(),
            }],
            1000,
        )
        .await
        .unwrap();
        let me = s.me(1).await.unwrap();
        assert_eq!(me.bytes, 6);
        assert_eq!(me.items, 1);

        s.push(
            1,
            vec![PushItem {
                key: "n".into(),
                data: "xy".into(),
            }],
            1000,
        )
        .await
        .unwrap();
        let me = s.me(1).await.unwrap();
        assert_eq!(me.bytes, 8);
        assert_eq!(me.items, 2);

        let n = s.delete_keys(1, vec!["k".into()]).await.unwrap();
        assert_eq!(n, 1);
        let me = s.me(1).await.unwrap();
        assert_eq!(me.bytes, 2);
        assert_eq!(me.items, 1);
    }

    #[tokio::test]
    async fn ct_eq_gleich_und_ungleich() {
        assert!(ct_eq(&[1, 2, 3], &[1, 2, 3]));
        assert!(!ct_eq(&[1, 2, 3], &[1, 2, 4]));
        assert!(!ct_eq(&[1], &[1, 2]));
    }
}
