//! SQLite: gemeinsame Verbindung, Migrationen (Postfach + Konten).

use std::{path::Path, time::Duration};

use rusqlite::{Connection, params};

use crate::util::random_bytes;

pub fn open(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS mail (
            sender TEXT NOT NULL,
            id TEXT NOT NULL,
            recipient TEXT NOT NULL,
            ts INTEGER NOT NULL,
            body TEXT NOT NULL,
            size INTEGER NOT NULL,
            pushed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (sender, id)
        );
        CREATE INDEX IF NOT EXISTS mail_recipient_ts ON mail(recipient, ts);
        CREATE TABLE IF NOT EXISTS mail_ids (
            sender TEXT NOT NULL,
            id TEXT NOT NULL,
            recipient TEXT NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (sender, id)
        );
        CREATE INDEX IF NOT EXISTS mail_ids_ts ON mail_ids(ts);
        ",
    )
    .map_err(|e| e.to_string())?;
    migrate_accounts(&conn)?;
    Ok(conn)
}

fn migrate_accounts(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            peer_id TEXT NOT NULL UNIQUE,
            auth_key_hash BLOB NOT NULL,
            kdf TEXT NOT NULL,
            vault TEXT NOT NULL,
            public_key BLOB NOT NULL,
            created_at INTEGER NOT NULL,
            next_seq INTEGER NOT NULL DEFAULT 0,
            used_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS account_tokens (
            hash BLOB PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            last_used INTEGER NOT NULL,
            device_name TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS account_tokens_account
            ON account_tokens(account_id, last_used);
        CREATE TABLE IF NOT EXISTS sync_items (
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            seq INTEGER NOT NULL,
            data TEXT NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (account_id, key)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS sync_items_account_seq
            ON sync_items(account_id, seq);
        ",
    )
    .map_err(|e| e.to_string())?;

    ensure_server_secret(conn)?;
    migrate_used_bytes(conn)?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// user_version 2: `accounts.used_bytes` (ALTER + einmalige SUM-Initialisierung).
fn migrate_used_bytes(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version >= 2 {
        return Ok(());
    }
    if !column_exists(conn, "accounts", "used_bytes")? {
        conn.execute(
            "ALTER TABLE accounts ADD COLUMN used_bytes INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "UPDATE accounts SET used_bytes = (
            SELECT COALESCE(SUM(length(data)), 0)
            FROM sync_items
            WHERE sync_items.account_id = accounts.id
        )",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "user_version", 2)
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_server_secret(conn: &Connection) -> Result<(), String> {
    let mut secret = [0u8; 32];
    random_bytes(&mut secret);
    conn.execute(
        "INSERT OR IGNORE INTO meta (key, value) VALUES ('server_secret', ?1)",
        params![secret.as_slice()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn server_secret(conn: &Connection) -> Result<[u8; 32], String> {
    let blob: Vec<u8> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'server_secret'",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if blob.len() != 32 {
        return Err("server_secret".into());
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&blob);
    Ok(out)
}
