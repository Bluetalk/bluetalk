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

    pub fn get(&self, key: &str, default_value: Value) -> Result<Value> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Ok(default_value);
        }
        let connection = self.connection.lock();
        let Some(mut value) = self.load_top(&connection, segments[0])? else {
            return Ok(default_value);
        };

        for segment in &segments[1..] {
            let Some(next) = value.as_object().and_then(|object| object.get(*segment)) else {
                return Ok(default_value);
            };
            value = next.clone();
        }
        Ok(value)
    }

    pub fn set(&self, key: &str, value: Value) -> Result<bool> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Err(AppError::InvalidInput(
                "messages must be changed through the paginated message API".into(),
            ));
        }

        let connection = self.connection.lock();
        let top_value = if segments.len() == 1 {
            value
        } else {
            let mut root = self
                .load_top(&connection, segments[0])?
                .filter(Value::is_object)
                .unwrap_or_else(|| Value::Object(Map::new()));
            set_nested(&mut root, &segments[1..], value);
            root
        };
        self.write_top(&connection, segments[0], &top_value)?;
        Ok(true)
    }

    pub fn delete(&self, key: &str) -> Result<bool> {
        let segments = split_key(key)?;
        if segments[0] == "messages" {
            return Err(AppError::InvalidInput(
                "messages must be changed through the message API".into(),
            ));
        }

        let connection = self.connection.lock();
        if segments.len() == 1 {
            return Ok(connection.execute("DELETE FROM kv WHERE key = ?1", [segments[0]])? > 0);
        }

        let Some(mut root) = self.load_top(&connection, segments[0])? else {
            return Ok(false);
        };
        if !delete_nested(&mut root, &segments[1..]) {
            return Ok(false);
        }
        self.write_top(&connection, segments[0], &root)?;
        Ok(true)
    }

    pub fn append_message(&self, peer_id: &str, message: Value) -> Result<MessageMeta> {
        validate_peer_storage_id(peer_id)?;
        let message_object = message
            .as_object()
            .ok_or_else(|| AppError::InvalidInput("message must be an object".into()))?;
        let message_id = message_object
            .get("messageId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(validate_message_id)
            .transpose()?;
        let storage_id = message_id
            .clone()
            .unwrap_or_else(|| format!("anonymous-{}", Uuid::new_v4()));
        let timestamp = message_object
            .get("timestamp")
            .and_then(Value::as_i64)
            .unwrap_or_else(now_millis);

        let bytes = serde_json::to_vec(&message)?;
        ensure_size(bytes.len(), MAX_MESSAGE_BYTES, "message")?;
        let aad = message_aad(peer_id, &storage_id);
        let encrypted = self.cipher.encrypt(&bytes, aad.as_bytes())?;
        let connection = self.connection.lock();

        let inserted = connection.execute(
            "INSERT OR IGNORE INTO messages(peer_id, message_id, storage_id, timestamp, value) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![peer_id, message_id, storage_id, timestamp, encrypted],
        )?;

        if inserted == 0 {
            // Idempotent append: return the current chat summary without rewriting the record.
        }
        self.chat_meta_locked(&connection, peer_id)
    }

    pub fn patch_message(&self, peer_id: &str, message_id: &str, patch: Value) -> Result<bool> {
        validate_peer_storage_id(peer_id)?;
        let message_id = validate_message_id(message_id)?;
        let patch = patch
            .as_object()
            .ok_or_else(|| AppError::InvalidInput("message patch must be an object".into()))?;

        let connection = self.connection.lock();
        let row: Option<(String, Vec<u8>)> = connection
            .query_row(
                "SELECT storage_id, value FROM messages WHERE peer_id = ?1 AND message_id = ?2",
                params![peer_id, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((storage_id, encrypted)) = row else {
            return Ok(false);
        };
        let aad = message_aad(peer_id, &storage_id);
        let plaintext = self.cipher.decrypt(&encrypted, aad.as_bytes())?;
        let mut message: Value = serde_json::from_slice(&plaintext)?;
        let object = message
            .as_object_mut()
            .ok_or_else(|| AppError::Storage("stored message is not an object".into()))?;
        for (key, value) in patch {
            if key != "messageId" {
                object.insert(key.clone(), value.clone());
            }
        }
        let bytes = serde_json::to_vec(&message)?;
        ensure_size(bytes.len(), MAX_MESSAGE_BYTES, "message")?;
        let encrypted = self.cipher.encrypt(&bytes, aad.as_bytes())?;
        connection.execute(
            "UPDATE messages SET value = ?3 WHERE peer_id = ?1 AND message_id = ?2",
            params![peer_id, message_id, encrypted],
        )?;
        Ok(true)
    }

    pub fn delete_message(&self, peer_id: &str, message_id: &str) -> Result<bool> {
        validate_peer_storage_id(peer_id)?;
        let message_id = validate_message_id(message_id)?;
        let connection = self.connection.lock();
        Ok(connection.execute(
            "DELETE FROM messages WHERE peer_id = ?1 AND message_id = ?2",
            params![peer_id, message_id],
        )? > 0)
    }

    pub fn delete_chat(&self, peer_id: &str) -> Result<bool> {
        validate_peer_storage_id(peer_id)?;
        let connection = self.connection.lock();
        Ok(connection.execute("DELETE FROM messages WHERE peer_id = ?1", [peer_id])? > 0)
    }

    pub fn get_message_batch(&self, peer_id: &str, options: BatchOptions) -> Result<MessageBatch> {
        validate_peer_storage_id(peer_id)?;
        let limit = options
            .limit
            .unwrap_or(DEFAULT_BATCH_SIZE)
            .clamp(1, MAX_BATCH_SIZE);
        let connection = self.connection.lock();
        let total: usize = connection.query_row(
            "SELECT COUNT(*) FROM messages WHERE peer_id = ?1",
            [peer_id],
            |row| row.get(0),
        )?;
        let end = total.saturating_sub(options.skip);
        let start = end.saturating_sub(limit);
        let count = end.saturating_sub(start);

        let mut statement = connection.prepare(
            "SELECT storage_id, value FROM messages WHERE peer_id = ?1 ORDER BY seq ASC LIMIT ?2 OFFSET ?3",
        )?;
        let rows = statement.query_map(params![peer_id, count, start], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;

        let mut messages = Vec::with_capacity(count);
        for row in rows {
            let (storage_id, envelope) = row?;
            let aad = message_aad(peer_id, &storage_id);
            let plaintext = self.cipher.decrypt(&envelope, aad.as_bytes())?;
            messages.push(serde_json::from_slice(&plaintext)?);
        }

        Ok(MessageBatch {
            batch_size: messages.len(),
            messages,
            total,
            remaining: start,
            has_more: start > 0,
        })
    }

    pub fn get_message_meta(&self) -> Result<BTreeMap<String, MessageMeta>> {
        let connection = self.connection.lock();
        let mut peers_statement = connection.prepare(
            "SELECT DISTINCT peer_id FROM messages WHERE peer_id <> 'self' ORDER BY peer_id",
        )?;
        let peer_rows = peers_statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut peer_ids = Vec::new();
        for peer in peer_rows {
            peer_ids.push(peer?);
        }
        drop(peers_statement);

        let mut result = BTreeMap::new();
        for peer_id in peer_ids {
            let meta = self.chat_meta_locked(&connection, &peer_id)?;
            if meta.count > 0 {
                result.insert(peer_id, meta);
            }
        }
        Ok(result)
    }

    fn chat_meta_locked(&self, connection: &Connection, peer_id: &str) -> Result<MessageMeta> {
        let count: usize = connection.query_row(
            "SELECT COUNT(*) FROM messages WHERE peer_id = ?1",
            [peer_id],
            |row| row.get(0),
        )?;
        let latest: Option<(String, Vec<u8>)> = connection
            .query_row(
                "SELECT storage_id, value FROM messages WHERE peer_id = ?1 ORDER BY seq DESC LIMIT 1",
                [peer_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let last_message = if let Some((storage_id, envelope)) = latest {
            let aad = message_aad(peer_id, &storage_id);
            let plaintext = self.cipher.decrypt(&envelope, aad.as_bytes())?;
            summarize_message(serde_json::from_slice(&plaintext)?)
        } else {
            Value::Null
        };
        Ok(MessageMeta {
            count,
            last_message,
        })
    }

    pub fn list_library_media(&self) -> Result<Vec<Value>> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare(
            "SELECT peer_id, storage_id, value FROM messages ORDER BY timestamp DESC, seq DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        let mut items = Vec::new();
        for row in rows {
            let (peer_id, storage_id, envelope) = row?;
            if peer_id == "self" {
                continue;
            }
            let plaintext = self
                .cipher
                .decrypt(&envelope, message_aad(&peer_id, &storage_id).as_bytes())?;
            let message: Value = serde_json::from_slice(&plaintext)?;
            let Some(object) = message.as_object() else {
                continue;
            };
            let kind = object
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(kind, "file" | "sticker")
                || object.get("from").and_then(Value::as_str) == Some("self")
            {
                continue;
            }
            let file_name = object
                .get("fileName")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let file_type = object
                .get("fileType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            items.push(json!({
                "messageId": object.get("messageId").cloned().unwrap_or(Value::Null),
                "peerId": peer_id,
                "from": object.get("from").cloned().unwrap_or(Value::Null),
                "sender": object.get("sender").cloned().unwrap_or(Value::Null),
                "timestamp": object.get("timestamp").cloned().unwrap_or(json!(0)),
                "kind": kind,
                "fileName": file_name,
                "fileType": file_type,
                "fileSize": object.get("fileSize").cloned().unwrap_or(json!(0)),
                "stickerId": object.get("stickerId").cloned().unwrap_or(Value::Null),
                "packId": object.get("packId").cloned().unwrap_or(Value::Null),
                "category": if kind == "sticker" { "sticker" } else { media_category(file_type, file_name) },
                "hasData": object.get("fileData").and_then(Value::as_str).is_some_and(|value| !value.is_empty())
            }));
        }
        Ok(items)
    }

    pub fn get_library_media_data(&self, peer_id: &str, message_id: &str) -> Result<Value> {
        validate_peer_storage_id(peer_id)?;
        let message_id = validate_message_id(message_id)?;
        let connection = self.connection.lock();
        let row: Option<(String, Vec<u8>)> = connection
            .query_row(
                "SELECT storage_id, value FROM messages WHERE peer_id = ?1 AND message_id = ?2",
                params![peer_id, message_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((storage_id, envelope)) = row else {
            return Ok(Value::Null);
        };
        let plaintext = self
            .cipher
            .decrypt(&envelope, message_aad(peer_id, &storage_id).as_bytes())?;
        let message: Value = serde_json::from_slice(&plaintext)?;
        let Some(object) = message.as_object() else {
            return Ok(Value::Null);
        };
        let kind = object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(kind, "file" | "sticker") {
            return Ok(Value::Null);
        }
        Ok(json!({
            "fileData": object.get("fileData").cloned().unwrap_or(Value::Null),
            "fileName": object.get("fileName").cloned().unwrap_or(Value::Null),
            "fileType": object.get("fileType").cloned().unwrap_or(Value::Null),
            "fileSize": object.get("fileSize").cloned().unwrap_or(Value::Null),
            "kind": kind
        }))
    }

    pub fn clear_messages(&self) -> Result<usize> {
        let connection = self.connection.lock();
        Ok(connection.execute("DELETE FROM messages", [])?)
    }

    pub fn clear_all(&self) -> Result<()> {
        let mut connection = self.connection.lock();
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM messages", [])?;
        transaction.execute("DELETE FROM kv", [])?;
        transaction.execute("DELETE FROM metadata WHERE key <> 'cipher-check'", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn import_legacy(&self, source_path: &Path, mut root: Map<String, Value>) -> Result<bool> {
        let mut connection = self.connection.lock();
        let already_imported: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM metadata WHERE key = 'migration-v1')",
            [],
            |row| row.get(0),
        )?;
        if already_imported {
            return Ok(false);
        }
        let has_user_data: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM kv) OR EXISTS(SELECT 1 FROM messages)",
            [],
            |row| row.get(0),
        )?;
        if has_user_data {
            return Ok(false);
        }

        let messages = root.remove("messages");
        let transaction = connection.transaction()?;
        for (key, value) in root {
            if split_key(&key).is_err() {
                continue;
            }
            let bytes = serde_json::to_vec(&value)?;
            ensure_size(bytes.len(), MAX_STORE_VALUE_BYTES, "legacy store value")?;
            let aad = format!("kv:{key}");
            let envelope = self.cipher.encrypt(&bytes, aad.as_bytes())?;
            transaction.execute(
                "INSERT INTO kv(key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![key, envelope, now_millis()],
            )?;
        }

        if let Some(message_map) = messages.and_then(|value| value.as_object().cloned()) {
            for (peer_id, entries) in message_map {
                if validate_peer_storage_id(&peer_id).is_err() {
                    continue;
                }
                let Some(entries) = entries.as_array() else {
                    continue;
                };
                for message in entries {
                    let bytes = serde_json::to_vec(message)?;
                    ensure_size(bytes.len(), MAX_MESSAGE_BYTES, "legacy message")?;
                    let message_id = message
                        .get("messageId")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .and_then(|value| validate_message_id(value).ok());
                    let storage_id = message_id
                        .clone()
                        .unwrap_or_else(|| format!("legacy-{}", Uuid::new_v4()));
                    let timestamp = message
                        .get("timestamp")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                    let envelope = self
                        .cipher
                        .encrypt(&bytes, message_aad(&peer_id, &storage_id).as_bytes())?;
                    transaction.execute(
                        "INSERT OR IGNORE INTO messages(peer_id, message_id, storage_id, timestamp, value) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![peer_id, message_id, storage_id, timestamp, envelope],
                    )?;
                }
            }
        }

        let marker = serde_json::to_vec(&json!({
            "source": source_path.to_string_lossy(),
            "importedAt": chrono::Utc::now().to_rfc3339(),
            "schema": 1
        }))?;
        let marker = self.cipher.encrypt(&marker, b"metadata:migration-v1")?;
        transaction.execute(
            "INSERT INTO metadata(key, value) VALUES ('migration-v1', ?1)",
            [marker],
        )?;
        transaction.commit()?;
        Ok(true)
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

fn split_key(key: &str) -> Result<Vec<&str>> {
    if key.is_empty() || key.len() > MAX_KEY_LENGTH || key.contains('\0') {
        return Err(AppError::InvalidInput("invalid store key".into()));
    }
    let segments: Vec<_> = key.split('.').collect();
    if segments.len() > MAX_KEY_SEGMENTS
        || segments
            .iter()
            .any(|segment| segment.is_empty() || FORBIDDEN_SEGMENTS.contains(segment))
    {
        return Err(AppError::InvalidInput("invalid store key".into()));
    }
    Ok(segments)
}

fn set_nested(root: &mut Value, segments: &[&str], value: Value) {
    if segments.is_empty() {
        *root = value;
        return;
    }
    if !root.is_object() {
        *root = Value::Object(Map::new());
    }
    let object = root
        .as_object_mut()
        .expect("root was normalized to an object");
    if segments.len() == 1 {
        object.insert(segments[0].to_owned(), value);
        return;
    }
    let child = object
        .entry(segments[0].to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    set_nested(child, &segments[1..], value);
}

fn delete_nested(root: &mut Value, segments: &[&str]) -> bool {
    let Some(object) = root.as_object_mut() else {
        return false;
    };
    if segments.len() == 1 {
        return object.remove(segments[0]).is_some();
    }
    let Some(child) = object.get_mut(segments[0]) else {
        return false;
    };
    delete_nested(child, &segments[1..])
}

fn validate_peer_storage_id(value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 192 || value.contains(['\0', '\r', '\n']) {
        return Err(AppError::InvalidInput(
            "invalid peer or conversation id".into(),
        ));
    }
    Ok(())
}

fn validate_message_id(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 192 || value.contains(['\0', '\r', '\n']) {
        return Err(AppError::InvalidInput("invalid message id".into()));
    }
    Ok(value.to_owned())
}

fn ensure_size(actual: usize, limit: usize, kind: &str) -> Result<()> {
    if actual > limit {
        return Err(AppError::InvalidInput(format!(
            "{kind} exceeds the {} MiB limit",
            limit / 1024 / 1024
        )));
    }
    Ok(())
}

fn summarize_message(mut message: Value) -> Value {
    if let Some(object) = message.as_object_mut() {
        object.remove("fileData");
        object.remove("localPreviewUrl");
    }
    message
}

fn message_aad(peer_id: &str, storage_id: &str) -> String {
    format!("message:{peer_id}:{storage_id}")
}

fn media_category(mime: &str, name: &str) -> &'static str {
    let mime = mime.to_ascii_lowercase();
    let extension = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if mime.starts_with("image/")
        || matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
        )
    {
        "image"
    } else if mime.starts_with("video/")
        || matches!(extension.as_str(), "mp4" | "webm" | "mov" | "mkv" | "avi")
    {
        "video"
    } else if mime.starts_with("audio/")
        || matches!(
            extension.as_str(),
            "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" | "opus"
        )
    {
        "audio"
    } else {
        "other"
    }
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

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
