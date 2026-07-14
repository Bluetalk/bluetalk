//! Wartung: Löschen von Nachrichten/allem und Legacy-Import.

use super::*;
use super::helpers::*;

impl Database {
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

}
