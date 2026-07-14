//! Reine Helfer: Key-Zerlegung, verschachteltes Setzen/Löschen, Validierung,
//! Größenprüfung, Nachrichten-Zusammenfassung und Zeit.

use super::*;

pub(super) fn split_key(key: &str) -> Result<Vec<&str>> {
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

pub(super) fn set_nested(root: &mut Value, segments: &[&str], value: Value) {
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

pub(super) fn delete_nested(root: &mut Value, segments: &[&str]) -> bool {
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

pub(super) fn validate_peer_storage_id(value: &str) -> Result<()> {
    let value = value.trim();
    if value.is_empty() || value.len() > 192 || value.contains(['\0', '\r', '\n']) {
        return Err(AppError::InvalidInput(
            "invalid peer or conversation id".into(),
        ));
    }
    Ok(())
}

pub(super) fn validate_message_id(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 192 || value.contains(['\0', '\r', '\n']) {
        return Err(AppError::InvalidInput("invalid message id".into()));
    }
    Ok(value.to_owned())
}

pub(super) fn ensure_size(actual: usize, limit: usize, kind: &str) -> Result<()> {
    if actual > limit {
        return Err(AppError::InvalidInput(format!(
            "{kind} exceeds the {} MiB limit",
            limit / 1024 / 1024
        )));
    }
    Ok(())
}

pub(super) fn summarize_message(mut message: Value) -> Value {
    if let Some(object) = message.as_object_mut() {
        object.remove("fileData");
        object.remove("localPreviewUrl");
    }
    message
}

pub(super) fn message_aad(peer_id: &str, storage_id: &str) -> String {
    format!("message:{peer_id}:{storage_id}")
}

pub(super) fn media_category(mime: &str, name: &str) -> &'static str {
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

pub(super) fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

