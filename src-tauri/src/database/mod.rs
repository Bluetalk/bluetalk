use std::{collections::BTreeMap, path::Path};

use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use uuid::Uuid;

use crate::{
    crypto::DataCipher,
    error::{AppError, Result},
};

const MAX_KEY_LENGTH: usize = 256;
const MAX_KEY_SEGMENTS: usize = 32;
const MAX_STORE_VALUE_BYTES: usize = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES: usize = 32 * 1024 * 1024;
const DEFAULT_BATCH_SIZE: usize = 24;
const MAX_BATCH_SIZE: usize = 100;
const CIPHER_CHECK: &[u8] = b"BlueTalk v2 encrypted database";
const FORBIDDEN_SEGMENTS: &[&str] = &["__proto__", "prototype", "constructor"];

pub struct Database {
    connection: Mutex<Connection>,
    cipher: DataCipher,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOptions {
    #[serde(default)]
    pub skip: usize,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBatch {
    pub messages: Vec<Value>,
    pub total: usize,
    pub remaining: usize,
    pub has_more: bool,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMeta {
    pub count: usize,
    pub last_message: Value,
}

impl Database {
    pub fn open(path: &Path, cipher: DataCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA secure_delete = ON;
            PRAGMA temp_store = MEMORY;

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY NOT NULL,
                value BLOB NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY NOT NULL,
                value BLOB NOT NULL,
                updated_at INTEGER NOT NULL
            ) STRICT;

            CREATE TABLE IF NOT EXISTS messages (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                peer_id TEXT NOT NULL,
                message_id TEXT,
                storage_id TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                value BLOB NOT NULL,
                UNIQUE(peer_id, storage_id)
            ) STRICT;

            CREATE UNIQUE INDEX IF NOT EXISTS messages_peer_message_id
                ON messages(peer_id, message_id)
                WHERE message_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS messages_peer_seq
                ON messages(peer_id, seq DESC);
            CREATE INDEX IF NOT EXISTS messages_timestamp
                ON messages(timestamp DESC);

            PRAGMA user_version = 1;
            "#,
        )?;

        let database = Self {
            connection: Mutex::new(connection),
            cipher,
        };
        database.verify_or_create_cipher_check()?;
        Ok(database)
    }

    pub fn cipher_backend(&self) -> &str {
        self.cipher.backend()
    }

    fn verify_or_create_cipher_check(&self) -> Result<()> {
        let connection = self.connection.lock();
        let existing: Option<Vec<u8>> = connection
            .query_row(
                "SELECT value FROM metadata WHERE key = 'cipher-check'",
                [],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(envelope) = existing {
            let plaintext = self.cipher.decrypt(&envelope, b"metadata:cipher-check")?;
            if plaintext != CIPHER_CHECK {
                return Err(AppError::Crypto(
                    "the database key does not match this profile".into(),
                ));
            }
        } else {
            let envelope = self
                .cipher
                .encrypt(CIPHER_CHECK, b"metadata:cipher-check")?;
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES ('cipher-check', ?1)",
                [envelope],
            )?;
        }
        Ok(())
    }

    fn load_top(&self, connection: &Connection, key: &str) -> Result<Option<Value>> {
        let envelope: Option<Vec<u8>> = connection
            .query_row("SELECT value FROM kv WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(envelope) = envelope else {
            return Ok(None);
        };
        let aad = format!("kv:{key}");
        let plaintext = self.cipher.decrypt(&envelope, aad.as_bytes())?;
        Ok(Some(serde_json::from_slice(&plaintext)?))
    }

    fn write_top(&self, connection: &Connection, key: &str, value: &Value) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        ensure_size(bytes.len(), MAX_STORE_VALUE_BYTES, "store value")?;
        let aad = format!("kv:{key}");
        let envelope = self.cipher.encrypt(&bytes, aad.as_bytes())?;
        connection.execute(
            r#"
            INSERT INTO kv(key, value, updated_at) VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            "#,
            params![key, envelope, now_millis()],
        )?;
        Ok(())
    }
}

mod helpers;
mod kv;
mod library;
mod maintenance;
mod messages;

use helpers::*;

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> (tempfile::TempDir, Database) {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(
            &directory.path().join("test.sqlite3"),
            DataCipher::for_test([9; 32]),
        )
        .unwrap();
        (directory, database)
    }

    #[test]
    fn nested_store_rejects_prototype_pollution_and_persists_values() {
        let (_directory, database) = database();
        assert!(database.set("settings.theme", json!("dark")).unwrap());
        assert_eq!(database.get("settings.theme", Value::Null).unwrap(), "dark");
        assert!(
            database
                .set("settings.__proto__.polluted", json!(true))
                .is_err()
        );
        assert!(database.delete("settings.theme").unwrap());
        assert_eq!(
            database.get("settings.theme", json!("system")).unwrap(),
            "system"
        );
    }

    #[test]
    fn messages_are_idempotent_paginated_and_patchable() {
        let (_directory, database) = database();
        for index in 0..30 {
            database
                .append_message(
                    "bt-peer",
                    json!({"messageId": format!("m-{index}"), "timestamp": index, "text": index}),
                )
                .unwrap();
        }
        database
            .append_message("bt-peer", json!({"messageId": "m-29", "text": "duplicate"}))
            .unwrap();
        let batch = database
            .get_message_batch("bt-peer", BatchOptions::default())
            .unwrap();
        assert_eq!(batch.total, 30);
        assert_eq!(batch.messages.len(), DEFAULT_BATCH_SIZE);
        assert_eq!(batch.messages[0]["messageId"], "m-6");
        assert!(
            database
                .patch_message("bt-peer", "m-29", json!({"seen": true}))
                .unwrap()
        );
        let latest = database
            .get_message_batch(
                "bt-peer",
                BatchOptions {
                    skip: 0,
                    limit: Some(1),
                },
            )
            .unwrap();
        assert_eq!(latest.messages[0]["seen"], true);
    }

    #[test]
    fn legacy_import_is_atomic_and_idempotent() {
        let (_directory, database) = database();
        let root = json!({
            "peerId": "bt-old",
            "settings": {"displayName": "Ada"},
            "messages": {"bt-peer": [{"messageId": "one", "text": "hello"}]}
        })
        .as_object()
        .unwrap()
        .clone();
        assert!(
            database
                .import_legacy(Path::new("legacy.json"), root.clone())
                .unwrap()
        );
        assert!(
            !database
                .import_legacy(Path::new("legacy.json"), root)
                .unwrap()
        );
        assert_eq!(database.get("peerId", Value::Null).unwrap(), "bt-old");
        assert_eq!(database.get_message_meta().unwrap()["bt-peer"].count, 1);
    }
}
