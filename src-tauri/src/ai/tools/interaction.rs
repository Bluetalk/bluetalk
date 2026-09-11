//! Interaktive Rückfrage an den Nutzer (`ask_user`) und die
//! Berechtigungs-Abfrage.

use base64::Engine;

use super::*;

pub fn is_affirmative_answer(text: &str) -> bool {
    let answer = text.trim().to_lowercase();
    if answer.is_empty() {
        return false;
    }
    ["ja", "yes", "y", "ok", "j", "klar", "gerne"]
        .iter()
        .any(|word| answer == *word || answer.starts_with(&format!("{word} ")))
}

pub fn is_placeholder_bot_reply(text: &str) -> bool {
    let lowered = text.trim().to_lowercase();
    if lowered.is_empty() {
        return true;
    }
    let stripped: String = lowered
        .chars()
        .filter(|c| !matches!(c, '(' | ')' | '[' | ']' | '"' | '\'' | '.' | '!' | '?' | '*'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    stripped.contains("siehe oben")
        || stripped.contains("see above")
        || stripped.contains("gesendete nachricht")
        || stripped.contains("nachricht gesendet")
        || stripped.contains("message sent")
        || stripped.contains("already sent")
        || stripped.contains("bereits gesendet")
}

const MAX_ATTACH_BYTES: u64 = 8 * 1024 * 1024;

fn parse_ask_options(args: &Value) -> Vec<String> {
    args.get("options")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .take(8)
                .map(|text| text.chars().take(80).collect::<String>())
                .collect()
        })
        .unwrap_or_default()
}

fn mime_for_filename(name: &str) -> &'static str {
    match std::path::Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "csv" => "text/csv",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

pub(super) fn tool_message_send(args: &Value, ctx: &ToolCtx) -> Value {
    let content = arg_str(args, "content").trim().to_string();
    if content.is_empty() {
        return json!({"ok": false, "error": "empty_content"});
    }
    if is_placeholder_bot_reply(&content) {
        return json!({"ok": true, "ignored": true, "reason": "placeholder_reply"});
    }
    if !catalog::is_ai_chat_peer_id(&ctx.peer_id) {
        return json!({"ok": false, "error": "not_bot_chat"});
    }
    ctx.manager.append_bot_chat_message(&ctx.peer_id, &content)
}

pub(super) async fn tool_ask_user(args: &Value, ctx: &ToolCtx) -> Value {
    let question = arg_str(args, "question").trim().to_string();
    if question.is_empty() {
        return json!({"ok": false, "error": "empty_question"});
    }
    if !ctx.interactive_ask {
        return json!({
            "ok": true,
            "pending_user": true,
            "answered": false,
            "question": question,
            "note": "Kein interaktiver Dialog verfügbar. Stelle die Frage im Text.",
        });
    }
    let options = parse_ask_options(args);
    let result = ctx
        .manager
        .run_ask_user(&ctx.peer_id, &ctx.request_id, &question, &options)
        .await;
    // v1-Zusatz: unbeantwortete Fragen mit Hinweis versehen.
    if result.get("answered").and_then(Value::as_bool) == Some(false)
        && result.get("note").is_none()
    {
        let mut object = result.as_object().cloned().unwrap_or_default();
        object.insert(
            "note".into(),
            json!("Der Nutzer hat die Frage übersprungen. Fahre ohne Antwort fort."),
        );
        return Value::Object(object);
    }
    result
}

pub(super) async fn ask_user_permission(ctx: &ToolCtx, question: &str) -> Value {
    if !ctx.interactive_ask {
        return json!({"ok": false, "error": "permission_unavailable"});
    }
    let options = vec!["Ja".to_string(), "Nein".to_string()];
    let reply = ctx
        .manager
        .run_ask_user(&ctx.peer_id, &ctx.request_id, question, &options)
        .await;
    let answer = reply.get("answer").and_then(Value::as_str).unwrap_or("");
    if !is_affirmative_answer(answer) {
        return json!({"ok": false, "error": "permission_denied", "answered": !answer.trim().is_empty()});
    }
    json!({"ok": true})
}

pub(super) fn tool_attach_file(args: &Value, ctx: &ToolCtx) -> Value {
    let raw_path = arg_str(args, "path");
    if raw_path.trim().is_empty() {
        return json!({"ok": false, "error": "empty_path"});
    }
    if !catalog::is_ai_chat_peer_id(&ctx.peer_id) {
        return json!({"ok": false, "error": "not_bot_chat"});
    }
    let target = resolve_path(&ctx.work_dir, &raw_path);
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    if !target.is_file() {
        return json!({"ok": false, "error": "not_a_file", "path": rel_of_work_dir(&ctx.work_dir, &target)});
    }
    let meta = match std::fs::metadata(&target) {
        Ok(meta) => meta,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };
    let file_size = meta.len();
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Datei".to_string());
    let caption = arg_str(args, "caption");
    let as_mode = arg_str(args, "as").to_ascii_lowercase();
    let want_link = as_mode == "link" || file_size > MAX_ATTACH_BYTES;
    if want_link {
        return ctx.manager.append_bot_chat_file_link(
            &ctx.peer_id,
            &file_name,
            file_size,
            &target.to_string_lossy(),
            caption.trim(),
        );
    }
    let bytes = match std::fs::read(&target) {
        Ok(bytes) => bytes,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };
    let file_data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    ctx.manager.append_bot_chat_file(
        &ctx.peer_id,
        &file_name,
        file_size,
        mime_for_filename(&file_name),
        &file_data,
        caption.trim(),
    )
}

// ---------------------------------------------------------------------------
// BlueTalk-Tools
// ---------------------------------------------------------------------------

