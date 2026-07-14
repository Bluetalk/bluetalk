//! Aufbau der KI-Nachrichten: Anhänge (Bilder/Dateien), Agent-Kontext
//! (aus `aiChat.agents`) und Chat-History (v1 `_buildChatHistory`).

use serde_json::{Map, Value, json};

use crate::ai::{catalog, manager::OllamaManager, tools};

fn strip_data_url_prefix(data: &str) -> String {
    if data.starts_with("data:")
        && let Some(comma) = data.find(',')
    {
        return data[comma + 1..].to_string();
    }
    data.to_string()
}

fn is_image_attachment(file_type: &str, file_name: &str, raw_data: &str) -> bool {
    let mime = file_type.trim().to_lowercase();
    if mime.starts_with("image/") {
        return true;
    }
    if raw_data.to_lowercase().starts_with("data:image/") {
        return true;
    }
    let extension = file_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_lowercase();
    matches!(
        extension.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg"
    )
}

fn attachment_string(attachment: &Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = attachment.get(*key).and_then(Value::as_str)
            && !value.trim().is_empty()
        {
            return value.to_string();
        }
    }
    String::new()
}

fn build_ai_user_message(text: &str, attachments: &[Value]) -> Value {
    let mut images: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    for attachment in attachments {
        if attachment.is_null() {
            continue;
        }
        let file_name = {
            let name = attachment_string(attachment, &["fileName", "name"]);
            let trimmed = name.trim().to_string();
            if trimmed.is_empty() { "Anhang".to_string() } else { trimmed }
        };
        let file_type = attachment_string(attachment, &["fileType", "type"]);
        let raw_data = attachment_string(attachment, &["fileData", "base64"]);
        if !raw_data.is_empty() && is_image_attachment(&file_type, &file_name, &raw_data) {
            images.push(strip_data_url_prefix(&raw_data));
            continue;
        }
        if file_type.trim().is_empty() {
            notes.push(format!("[Datei: {file_name}]"));
        } else {
            notes.push(format!("[Datei: {file_name} ({file_type})]"));
        }
    }
    let trimmed = text.trim();
    let mut parts: Vec<String> = Vec::new();
    if !trimmed.is_empty() {
        parts.push(trimmed.to_string());
    }
    parts.extend(notes);
    let content = if parts.is_empty() {
        if images.is_empty() {
            String::new()
        } else {
            "Siehe angehängtes Bild.".to_string()
        }
    } else {
        parts.join("\n\n")
    };
    let mut message = Map::new();
    message.insert("role".into(), json!("user"));
    message.insert("content".into(), json!(content));
    if !images.is_empty() {
        message.insert("images".into(), json!(images));
    }
    Value::Object(message)
}

/// Agent-Kontext (aus aiChat.agents), vgl. v1 `_resolveAgentContext`.
pub(super) struct AgentContext {
    pub(super) prompt_config: catalog::AgentPromptConfig,
    pub(super) work_dir: std::path::PathBuf,
    pub(super) thinking_mode: String,
    pub(super) allow_bluetalk: bool,
}

pub(super) fn resolve_agent_context(manager: &OllamaManager, peer_id: &str) -> AgentContext {
    let agent = manager.get_agent(peer_id);
    let personality_id = agent
        .as_ref()
        .and_then(|a| a.get("personality"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let personality_custom = agent
        .as_ref()
        .and_then(|a| a.get("personalityCustom"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(catalog::AI_PERSONALITY_CUSTOM_MAX_CHARS)
        .collect::<String>();
    let work_dir_raw = agent
        .as_ref()
        .and_then(|a| a.get("agentWorkDir"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let work_dir = if work_dir_raw.is_empty() {
        tools::default_work_dir()
    } else {
        std::path::PathBuf::from(&work_dir_raw)
    };
    let thinking_mode = catalog::resolve_thinking_mode(
        agent
            .as_ref()
            .and_then(|a| a.get("thinkingMode"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .to_string();
    let allow_bluetalk = agent
        .as_ref()
        .and_then(|a| a.get("allowBluetalkMessaging"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    AgentContext {
        prompt_config: catalog::AgentPromptConfig {
            personality_id,
            personality_custom,
            agent_mode: true,
            agent_work_dir: work_dir.to_string_lossy().to_string(),
        },
        work_dir,
        thinking_mode,
        allow_bluetalk,
    }
}

/// Baut die Chat-History aus den letzten 24 gespeicherten Nachrichten
/// (v1 `_buildChatHistory`).
pub(super) fn build_chat_history(
    manager: &OllamaManager,
    peer_id: &str,
    tier_id: &str,
    prompt: &str,
    attachments: &[Value],
    agent_ctx: &AgentContext,
) -> Vec<Value> {
    let (stored, _, _, _) = manager.message_batch(peer_id, 0, 24);
    let mut messages: Vec<Value> = Vec::new();
    for item in &stored {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let from = item.get("from").and_then(Value::as_str).unwrap_or("");
        if kind == "chat" {
            let content = item
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if content.is_empty() {
                continue;
            }
            messages.push(json!({
                "role": if from == "self" { "user" } else { "assistant" },
                "content": content,
            }));
            continue;
        }
        if kind == "file" && from == "self" {
            let file_name = {
                let name = attachment_string(item, &["fileName", "content"]);
                let trimmed = name.trim().to_string();
                if trimmed.is_empty() { "Anhang".to_string() } else { trimmed }
            };
            let file_type = attachment_string(item, &["fileType"]);
            let file_data = attachment_string(item, &["fileData"]);
            if !file_data.is_empty() && is_image_attachment(&file_type, &file_name, &file_data) {
                let caption = item
                    .get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                messages.push(json!({
                    "role": "user",
                    "content": if caption.is_empty() { format!("Bild: {file_name}") } else { caption },
                    "images": [strip_data_url_prefix(&file_data)],
                }));
            } else if file_type.trim().is_empty() {
                messages.push(json!({"role": "user", "content": format!("[Datei: {file_name}]")}));
            } else {
                messages.push(json!({"role": "user", "content": format!("[Datei: {file_name} ({file_type})]")}));
            }
        }
    }

    let trimmed_prompt = prompt.trim();
    if !trimmed_prompt.is_empty() || !attachments.is_empty() {
        while messages
            .last()
            .map(|m| m.get("role").and_then(Value::as_str) == Some("user"))
            .unwrap_or(false)
        {
            messages.pop();
        }
        messages.push(build_ai_user_message(trimmed_prompt, attachments));
    }

    let system_prompt = catalog::get_system_prompt_for_agent(tier_id, &agent_ctx.prompt_config);
    let mut history = vec![json!({"role": "system", "content": system_prompt})];
    history.extend(messages);
    history
}
