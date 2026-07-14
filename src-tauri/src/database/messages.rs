//! Nachrichten: Anhängen, Patchen, Löschen, paginierte Batches und Meta.

use super::*;
use super::helpers::*;

impl Database {
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

}
