//! Medien-Bibliothek: Auflisten und Abrufen gehosteter Mediendaten.

use super::*;
use super::helpers::*;

impl Database {
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

}
