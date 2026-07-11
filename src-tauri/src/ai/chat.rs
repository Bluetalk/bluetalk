//! Chat mit Agent-Loop: Portierung von v1 `ollama-manager.js#chat`,
//! `_chatRequestStream`, `_buildChatHistory`, `_runSubagent` sowie der
//! Segment-Helfer aus `ai-stream-segments.js`/`agent-segments.js` und der
//! (reduzierten) Text-Fallback-Extraktion aus `agent-tools.js`.
//!
//! Reduzierungen gegenüber v1 (siehe Bericht):
//! - Text-Fallback-Extraktion: nur Code-Fences (```json/```tool) und rohe
//!   `{…}`-Objekte mit Klammer-Balancing; die exotischen Ornith-Formate
//!   ([SYSTEM-TOOL-CALL], [TOOL_CALLS]-Tabellen, XML-Tags, Pseudo-Zeilen,
//!   "kind"-JSON) sind weggelassen.
//! - Sub-Agent: Start/Ende werden als Segment + Progress-Event gemeldet;
//!   Live-Streaming des Sub-Agenten-Texts in das Haupt-Segment entfällt.

use std::{
    sync::{Arc, LazyLock},
    time::Instant,
};

use regex::Regex;
use serde_json::{Map, Value, json};
use tauri::Emitter;
use uuid::Uuid;

use super::{
    catalog,
    manager::{CancelToken, OllamaManager},
    tools::{self, ToolCtx},
};

const MAX_AGENT_ROUNDS: usize = 64;
const MAX_SUBAGENT_ROUNDS: usize = 25;

const SYSTEM_CORRECTION_PROMPT: &str = "SYSTEM-KORREKTUR: Deine vorige Ausgabe hat ein Tool-Ergebnis simuliert und wurde verworfen. Führe jetzt den nächsten nötigen Schritt ausschließlich als nativen Function-Call aus. Für send_bluetalk_reply brauchst du peer_id, content und die echte reply_to_message_id aus einem Tool-Ergebnis. Schreibe keinen Begleittext, keinen SYSTEM-TOOL-ERGEBNIS-Marker und kein Erfolgs-JSON.";

// ---------------------------------------------------------------------------
// Regexe
// ---------------------------------------------------------------------------

#[allow(clippy::expect_used)]
fn static_regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("statische Regex ist gültig")
}

static THINK_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)<(?:redacted_thinking|think|redacted_reasoning)>"));
static THINK_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)</(?:redacted_thinking|think|redacted_reasoning)>"));
static THINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)</?(?:redacted_thinking|think|redacted_reasoning)>"));
static MULTI_NEWLINE_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\n{3,}"));
static FORGED_RESULT_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)\[SYSTEM-TOOL-ERGEBNIS\b[^\]]*\]"));
static CODE_FENCE_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?is)```(?:json|tool_call|tool)?\s*(.*?)```"));

// ---------------------------------------------------------------------------
// Thinking-Text-Aufteilung
// ---------------------------------------------------------------------------

pub fn strip_orphan_thinking_tags(text: &str) -> String {
    let removed = THINK_TAG_RE.replace_all(text, "");
    MULTI_NEWLINE_RE.replace_all(&removed, "\n\n").trim().to_string()
}

/// Trennt `<think>…</think>`-Blöcke vom sichtbaren Inhalt.
pub fn split_thinking_text(raw: &str) -> (String, String) {
    if raw.is_empty() {
        return (String::new(), String::new());
    }
    let mut content = String::new();
    let mut thinking = String::new();
    let mut cursor = 0usize;

    while cursor <= raw.len() {
        let Some(open) = THINK_OPEN_RE.find_at(raw, cursor) else {
            break;
        };
        content.push_str(&raw[cursor..open.start()]);
        let body_start = open.end();
        match THINK_CLOSE_RE.find_at(raw, body_start) {
            Some(close) => {
                if !thinking.is_empty() {
                    thinking.push_str("\n\n");
                }
                thinking.push_str(&raw[body_start..close.start()]);
                cursor = close.end();
            }
            None => {
                if !thinking.is_empty() {
                    thinking.push_str("\n\n");
                }
                thinking.push_str(&raw[body_start..]);
                cursor = raw.len();
                break;
            }
        }
    }
    content.push_str(&raw[cursor.min(raw.len())..]);
    (thinking.trim().to_string(), strip_orphan_thinking_tags(&content))
}

// ---------------------------------------------------------------------------
// Segment-Helfer (ai-stream-segments.js / agent-segments.js)
// ---------------------------------------------------------------------------

fn segment_type(segment: &Value) -> &str {
    segment.get("type").and_then(Value::as_str).unwrap_or("")
}

fn segment_tool_after(segment: &Value) -> bool {
    segment.get("toolAfter").and_then(Value::as_bool).unwrap_or(false)
}

/// Aktualisiert das letzte Thinking-Segment der aktuellen Runde (seit letztem Tool).
pub fn upsert_stream_thinking(segments: &mut Vec<Value>, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    for index in (0..segments.len()).rev() {
        let kind = segment_type(&segments[index]).to_string();
        if kind == "tool" {
            break;
        }
        if kind == "thinking" && !segment_tool_after(&segments[index]) {
            if let Some(object) = segments[index].as_object_mut() {
                object.insert("text".into(), json!(trimmed));
            }
            return;
        }
    }
    segments.push(json!({"type": "thinking", "text": trimmed}));
}

/// Aktualisiert das letzte Answer-Segment der aktuellen Runde (seit letztem Tool).
pub fn upsert_stream_answer(segments: &mut Vec<Value>, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    for index in (0..segments.len()).rev() {
        let kind = segment_type(&segments[index]).to_string();
        if kind == "tool" {
            break;
        }
        if kind == "answer" {
            if let Some(object) = segments[index].as_object_mut() {
                object.insert("text".into(), json!(trimmed));
            }
            return;
        }
    }
    segments.push(json!({"type": "answer", "text": trimmed}));
}

/// Entfernt das letzte Antwort-Segment der laufenden Runde (z. B. vor Tool-Ausführung).
pub fn clear_last_stream_answer(segments: &mut Vec<Value>) {
    for index in (0..segments.len()).rev() {
        let kind = segment_type(&segments[index]).to_string();
        if kind == "answer" {
            segments.remove(index);
            return;
        }
        if kind == "tool" {
            return;
        }
    }
}

/// Fasst aufeinanderfolgende Tool-Segmente zu einem Block zusammen und
/// normalisiert Segment-Listen für Anzeige und Persistenz.
pub fn consolidate_segments(segments: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut tool_batch: Vec<Value> = Vec::new();

    fn flush_tools(out: &mut Vec<Value>, tool_batch: &mut Vec<Value>) {
        if tool_batch.is_empty() {
            return;
        }
        out.push(json!({"type": "tool", "events": std::mem::take(tool_batch)}));
    }

    for segment in segments {
        let kind = segment_type(segment).to_string();
        if kind.is_empty() {
            continue;
        }
        if kind == "tool" {
            if let Some(event) = segment.get("event") {
                tool_batch.push(event.clone());
            } else if let Some(events) = segment.get("events").and_then(Value::as_array) {
                tool_batch.extend(events.iter().cloned());
            }
            continue;
        }
        flush_tools(&mut out, &mut tool_batch);
        if kind == "subagent" {
            out.push(segment.clone());
            continue;
        }
        let merged = if let Some(last) = out.last_mut() {
            let last_kind = segment_type(last).to_string();
            if kind == "thinking"
                && last_kind == "thinking"
                && !segment_tool_after(last)
                && !segment_tool_after(segment)
            {
                if let Some(object) = last.as_object_mut() {
                    object.insert("text".into(), segment.get("text").cloned().unwrap_or(json!("")));
                }
                true
            } else if kind == "answer" && last_kind == "answer" {
                if let Some(object) = last.as_object_mut() {
                    object.insert("text".into(), segment.get("text").cloned().unwrap_or(json!("")));
                }
                true
            } else {
                false
            }
        } else {
            false
        };
        if !merged {
            out.push(segment.clone());
        }
    }
    flush_tools(&mut out, &mut tool_batch);
    out
}

// ---------------------------------------------------------------------------
// Tool-Call-Extraktion aus Text (reduzierte v1-Fallbacks)
// ---------------------------------------------------------------------------

fn fix_backslashes(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' {
            let next = chars.get(i + 1).copied();
            let valid_escape = matches!(next, Some('"') | Some('\\') | Some('/') | Some('b') | Some('f') | Some('n') | Some('r') | Some('t') | Some('u'));
            if valid_escape {
                out.push('\\');
            } else {
                out.push_str("\\\\");
            }
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// Escaped innere, unescapete `"` innerhalb von JSON-Strings.
fn escape_inner_quotes(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    for (index, &c) in chars.iter().enumerate() {
        if !in_string {
            if c == '"' {
                in_string = true;
                escaped = false;
            }
            out.push(c);
            continue;
        }
        if escaped {
            out.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' {
            out.push(c);
            escaped = true;
            continue;
        }
        if c == '"' {
            let mut j = index + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            let next = chars.get(j).copied();
            if matches!(next, Some(':') | Some(',') | Some('}') | Some(']') | None) {
                in_string = false;
                out.push(c);
            } else {
                out.push_str("\\\"");
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Fehlertolerantes JSON-Parsing für als Text geschriebene Tool-Aufrufe.
pub fn lenient_json_parse(input: &str) -> Option<Value> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Some(value);
    }
    let bs_fixed = fix_backslashes(trimmed);
    if let Ok(value) = serde_json::from_str::<Value>(&bs_fixed) {
        return Some(value);
    }
    let quote_fixed = escape_inner_quotes(&bs_fixed);
    if quote_fixed == bs_fixed {
        return None;
    }
    serde_json::from_str::<Value>(&quote_fixed).ok()
}

/// Normalisiert ein geparstes JSON-Objekt zu einem Tool-Call im
/// OpenAI/Ollama-Schema.
fn normalize_tool_call(candidate: &Value, valid_names: &[String]) -> Option<Value> {
    let object = candidate.as_object()?;
    let (name, args): (String, Option<Value>) = if let Some(function) = object.get("function") {
        if let Some(function_object) = function.as_object() {
            (
                function_object
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                function_object.get("arguments").cloned(),
            )
        } else if let Some(function_name) = function.as_str() {
            (function_name.trim().to_string(), object.get("arguments").cloned())
        } else {
            (String::new(), None)
        }
    } else {
        let name = ["name", "function_name", "tool_name", "tool"]
            .iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str))
            .unwrap_or("")
            .trim()
            .to_string();
        let args = object
            .get("arguments")
            .or_else(|| object.get("parameters"))
            .or_else(|| object.get("params"))
            .cloned();
        (name, args)
    };
    if name.is_empty() || !valid_names.iter().any(|n| n == &name) {
        return None;
    }
    let args = match args {
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                json!({})
            } else {
                match lenient_json_parse(trimmed) {
                    Some(Value::Object(map)) => Value::Object(map),
                    _ => json!({}),
                }
            }
        }
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    Some(json!({"type": "function", "function": {"name": name, "arguments": args}}))
}

fn try_parse_tool_call(json_text: &str, valid_names: &[String]) -> Option<Vec<Value>> {
    let parsed = lenient_json_parse(json_text)?;
    if let Some(array) = parsed.as_array() {
        let calls: Vec<Value> = array
            .iter()
            .filter_map(|entry| normalize_tool_call(entry, valid_names))
            .collect();
        return if calls.is_empty() { None } else { Some(calls) };
    }
    normalize_tool_call(&parsed, valid_names).map(|call| vec![call])
}

pub fn contains_forged_tool_result(text: &str) -> bool {
    FORGED_RESULT_RE.is_match(text)
}

/// Ollama erwartet tool_calls[].function.arguments als Objekt.
pub fn normalize_tool_calls_for_ollama(tool_calls: &[Value]) -> Vec<Value> {
    tool_calls
        .iter()
        .filter_map(|call| {
            let function = call.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .or_else(|| call.get("name").and_then(Value::as_str))
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                return None;
            }
            let raw_args = function
                .and_then(|f| f.get("arguments"))
                .or_else(|| call.get("arguments"));
            let args = match raw_args {
                Some(Value::Object(map)) => Value::Object(map.clone()),
                Some(Value::String(s)) => match lenient_json_parse(s) {
                    Some(Value::Object(map)) => Value::Object(map),
                    _ => json!({}),
                },
                _ => json!({}),
            };
            let mut out = Map::new();
            out.insert(
                "type".into(),
                call.get("type").cloned().unwrap_or_else(|| json!("function")),
            );
            out.insert("function".into(), json!({"name": name, "arguments": args}));
            if let Some(id) = call.get("id") {
                out.insert("id".into(), id.clone());
            }
            Some(Value::Object(out))
        })
        .collect()
}

/// Extrahiert eingebettete Tool-Aufrufe aus dem Antworttext (Code-Fences und
/// rohe `{…}`-Objekte). Liefert (calls, bereinigter Text).
pub fn extract_tool_calls_from_text(text: &str, valid_names: &[String]) -> (Vec<Value>, String) {
    let source = strip_orphan_thinking_tags(text);
    let mut calls: Vec<Value> = Vec::new();
    let mut removals: Vec<(usize, usize)> = Vec::new();

    // 1) Eingezäunte Codeblöcke (```json … ``` oder ``` … ```)
    for captures in CODE_FENCE_RE.captures_iter(&source) {
        if !calls.is_empty() {
            break;
        }
        let Some(inner) = captures.get(1) else { continue };
        if let Some(parsed) = try_parse_tool_call(inner.as_str().trim(), valid_names)
            && let Some(whole) = captures.get(0)
        {
            calls.extend(parsed);
            removals.push((whole.start(), whole.end()));
        }
    }

    // 2) Rohe {...}-Objekte mit name/arguments (Klammer-Balancing)
    if calls.is_empty() {
        let bytes = source.as_bytes();
        let mut start = source.find('{');
        while let Some(i) = start {
            let mut depth = 0i32;
            let mut j = i;
            let mut in_string = false;
            let mut escaped = false;
            while j < bytes.len() {
                let c = bytes[j] as char;
                if in_string {
                    if escaped {
                        escaped = false;
                    } else if c == '\\' {
                        escaped = true;
                    } else if c == '"' {
                        in_string = false;
                    }
                    j += 1;
                    continue;
                }
                if c == '"' {
                    in_string = true;
                } else if c == '{' {
                    depth += 1;
                } else if c == '}' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            if j < bytes.len() {
                let slice = &source[i..=j];
                if let Some(parsed) = try_parse_tool_call(slice, valid_names) {
                    calls.extend(parsed);
                    removals.push((i, j + 1));
                    break; // ein Tool-Aufruf pro Rohtext-Scan reicht meist
                }
                start = source[i + 1..].find('{').map(|offset| i + 1 + offset);
            } else {
                break;
            }
        }
    }

    if calls.is_empty() && removals.is_empty() {
        return (Vec::new(), source);
    }

    removals.sort_by_key(|(start, _)| *start);
    let mut cleaned = String::new();
    let mut cursor = 0usize;
    for (start, end) in removals {
        if start > cursor {
            cleaned.push_str(&source[cursor..start]);
        }
        cursor = cursor.max(end);
    }
    if cursor < source.len() {
        cleaned.push_str(&source[cursor..]);
    }
    let cleaned = MULTI_NEWLINE_RE.replace_all(&cleaned, "\n\n").trim().to_string();
    (calls, cleaned)
}

pub struct ResolvedTools {
    pub tool_calls: Vec<Value>,
    pub display_content: String,
    pub thinking_text: String,
    pub spoofed_tool_result: bool,
}

/// Native tool_calls + Text-Fallback in einem Schritt (v1
/// `resolveToolCallsFromAssistantText`, reduziert).
pub fn resolve_tool_calls_from_assistant_text(
    native_tool_calls: &[Value],
    msg_content: &str,
    msg_thinking: &str,
    all_valid_names: &[String],
    allowed_names: &[String],
) -> ResolvedTools {
    let allowed: &[String] = if allowed_names.is_empty() {
        all_valid_names
    } else {
        allowed_names
    };
    let mut tool_calls = if native_tool_calls.is_empty() {
        Vec::new()
    } else {
        normalize_tool_calls_for_ollama(native_tool_calls)
    };

    let extract_from = [msg_thinking, msg_content]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<&str>>()
        .join("\n\n");
    let spoofed_tool_result = contains_forged_tool_result(&extract_from);

    let (mut thinking_text, mut display_content) = split_thinking_text(msg_content);
    if !msg_thinking.is_empty() {
        thinking_text = if thinking_text.is_empty() {
            msg_thinking.to_string()
        } else {
            format!("{msg_thinking}\n\n{thinking_text}")
        };
    }

    if tool_calls.is_empty() && !all_valid_names.is_empty() && !extract_from.trim().is_empty() {
        // Scan the full message (thinking + content) so a tool call the model
        // wrote inside its reasoning channel is still detected.
        let (extracted_calls, _) = extract_tool_calls_from_text(&extract_from, all_valid_names);
        let filtered: Vec<Value> = extracted_calls
            .iter()
            .filter(|call| {
                call.get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .map(|name| allowed.iter().any(|allowed_name| allowed_name == name))
                    .unwrap_or(false)
            })
            .cloned()
            .collect();
        if !extracted_calls.is_empty() && filtered.is_empty() {
            log::info!("[Agent] Text-Tools erkannt, aber nicht erlaubt.");
        } else if !filtered.is_empty() {
            tool_calls = filtered;
            // Strip the tool-call text from the VISIBLE content only. The
            // reasoning from the native `thinking` field must never leak into
            // the answer body — it belongs in the collapsible working block.
            let (_, cleaned_content_raw) = extract_tool_calls_from_text(msg_content, all_valid_names);
            let (inline_thinking, cleaned_content) = split_thinking_text(&cleaned_content_raw);
            display_content = cleaned_content;
            if !inline_thinking.is_empty() {
                thinking_text = if thinking_text.is_empty() {
                    inline_thinking
                } else {
                    format!("{thinking_text}\n\n{inline_thinking}")
                };
            }
        }
    }

    if spoofed_tool_result {
        // Nur role=tool darf diesen Marker enthalten. Modellkopien weder anzeigen
        // noch als Thinking weiterreichen; der Agent-Loop kann sicher korrigieren.
        display_content = String::new();
        thinking_text = String::new();
    }

    ResolvedTools {
        tool_calls,
        display_content,
        thinking_text,
        spoofed_tool_result,
    }
}

// ---------------------------------------------------------------------------
// Attachments / History
// ---------------------------------------------------------------------------

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
struct AgentContext {
    prompt_config: catalog::AgentPromptConfig,
    work_dir: std::path::PathBuf,
    thinking_mode: String,
    allow_bluetalk: bool,
}

fn resolve_agent_context(manager: &OllamaManager, peer_id: &str) -> AgentContext {
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
fn build_chat_history(
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

// ---------------------------------------------------------------------------
// Streaming-Request an /api/chat
// ---------------------------------------------------------------------------

pub struct StreamResponse {
    pub thinking: String,
    pub content: String,
    pub tool_calls: Vec<Value>,
    pub stats: Option<Value>,
}

/// POST /api/chat mit stream:true — akkumuliert thinking/content, extrahiert
/// tool_calls, baut Live-Segmente auf und meldet Fortschritt.
async fn chat_request_stream(
    manager: &Arc<OllamaManager>,
    body: Value,
    cancel: &CancelToken,
    live_segments: &mut Vec<Value>,
    on_progress: &mut (dyn FnMut(Value) + Send),
) -> Result<StreamResponse, String> {
    let mut request_body = body;
    if let Some(object) = request_body.as_object_mut() {
        object.insert("stream".into(), json!(true));
    }
    let url = format!("{}/api/chat", manager.api_base());
    let client = reqwest::Client::new();
    let response = tokio::select! {
        result = client.post(&url).json(&request_body).send() => result.map_err(|e| e.to_string())?,
        _ = cancel.cancelled() => return Err("chat_aborted".to_string()),
    };

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body_text)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| body_text.trim().to_string());
        return Err(if message.is_empty() {
            format!("Chat fehlgeschlagen (HTTP {status})")
        } else {
            message
        });
    }

    let started = Instant::now();
    let mut estimated_tokens: f64 = 0.0;
    let mut buffer = String::new();
    let mut full_thinking = String::new();
    let mut full_content = String::new();
    let mut last_tool_calls: Vec<Value> = Vec::new();
    let mut final_stats: Option<Value> = None;
    let mut response = response;
    let mut done = false;

    'stream: loop {
        let chunk = tokio::select! {
            chunk = response.chunk() => chunk.map_err(|e| e.to_string())?,
            _ = cancel.cancelled() => return Err("chat_aborted".to_string()),
        };
        let Some(chunk) = chunk else { break };
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(position) = buffer.find('\n') {
            let line = buffer[..position].trim().to_string();
            buffer.drain(..=position);
            if line.is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            if let Some(thinking) = parsed
                .get("message")
                .and_then(|m| m.get("thinking"))
                .and_then(Value::as_str)
                && !thinking.is_empty()
            {
                full_thinking.push_str(thinking);
                estimated_tokens += (thinking.chars().count() as f64 / 4.0).ceil().max(1.0);
            }
            if let Some(content) = parsed
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                && !content.is_empty()
            {
                full_content.push_str(content);
                estimated_tokens += (content.chars().count() as f64 / 4.0).ceil().max(1.0);
            }
            if let Some(tool_calls) = parsed
                .get("message")
                .and_then(|m| m.get("tool_calls"))
                .and_then(Value::as_array)
                && !tool_calls.is_empty()
            {
                last_tool_calls = tool_calls.clone();
            }

            let (split_thinking, split_content) = split_thinking_text(&full_content);
            if !full_thinking.trim().is_empty() {
                upsert_stream_thinking(live_segments, &full_thinking);
            }
            if !split_content.trim().is_empty() {
                upsert_stream_answer(live_segments, &split_content);
            }

            let elapsed_seconds = started.elapsed().as_secs_f64().max(0.001);
            let eval_count = parsed.get("eval_count").and_then(Value::as_f64);
            let eval_duration = parsed.get("eval_duration").and_then(Value::as_f64);
            let final_tps = match (eval_count, eval_duration) {
                (Some(count), Some(duration)) if duration > 0.0 => count / (duration / 1e9),
                _ => 0.0,
            };
            let gen_time_ms = match eval_duration {
                Some(duration) if duration > 0.0 => duration / 1e6,
                _ => elapsed_seconds * 1000.0,
            };
            let tps = if final_tps > 0.0 {
                final_tps
            } else {
                estimated_tokens / elapsed_seconds
            };
            let is_done = parsed.get("done").and_then(Value::as_bool).unwrap_or(false);
            if is_done {
                final_stats = Some(json!({"tps": tps, "genTimeMs": gen_time_ms}));
            }

            let combined_thinking = if split_thinking.is_empty() {
                full_thinking.clone()
            } else if full_thinking.is_empty() {
                split_thinking.clone()
            } else {
                format!("{full_thinking}\n\n{split_thinking}")
            };
            on_progress(json!({
                "thinking": combined_thinking,
                "content": if split_content.is_empty() { full_content.clone() } else { split_content },
                "segments": live_segments.clone(),
                "tps": tps,
                "genTimeMs": gen_time_ms,
                "done": is_done,
            }));

            if is_done {
                if let Some(tool_calls) = parsed
                    .get("message")
                    .and_then(|m| m.get("tool_calls"))
                    .and_then(Value::as_array)
                    && !tool_calls.is_empty()
                {
                    last_tool_calls = tool_calls.clone();
                }
                done = true;
                break 'stream;
            }
        }
    }

    if done {
        return Ok(StreamResponse {
            thinking: full_thinking,
            content: full_content,
            tool_calls: last_tool_calls,
            stats: final_stats,
        });
    }

    if !full_content.trim().is_empty() || !full_thinking.trim().is_empty() || !last_tool_calls.is_empty() {
        let elapsed_seconds = started.elapsed().as_secs_f64().max(0.001);
        return Ok(StreamResponse {
            thinking: full_thinking,
            content: full_content,
            tool_calls: last_tool_calls,
            stats: Some(final_stats.unwrap_or_else(|| {
                json!({
                    "tps": estimated_tokens / elapsed_seconds,
                    "genTimeMs": elapsed_seconds * 1000.0,
                })
            })),
        });
    }
    Err("Leere Ollama-Antwort.".to_string())
}

// ---------------------------------------------------------------------------
// Sub-Agent
// ---------------------------------------------------------------------------

struct SubagentOutcome {
    ok: bool,
    content: String,
    error: String,
    tool_events: Vec<Value>,
    segments: Vec<Value>,
}

/// Führt einen Sub-Agenten aus: eigener Ollama-Chat mit eigenen Tools,
/// eigenem Loop und eigenem System-Prompt (v1 `_runSubagent`, ohne
/// rekursives Spawnen).
async fn run_subagent(
    manager: &Arc<OllamaManager>,
    parent_ctx: &ToolCtx,
    task: &str,
    allowed_tools: &[String],
    cancel: &CancelToken,
) -> SubagentOutcome {
    let failure = |error: String| SubagentOutcome {
        ok: false,
        content: String::new(),
        error,
        tool_events: Vec::new(),
        segments: Vec::new(),
    };

    let state = manager.refresh_state().await;
    let model = catalog::resolve_active_model_name(&state.selected_model_tier, &state.selected_cloud_model_id);
    if model.is_empty() {
        return failure("subagent_model_missing".into());
    }
    if !manager.ensure_server_running().await {
        return failure("subagent_server_not_running".into());
    }

    let tier_id = if catalog::is_valid_model_tier(&parent_ctx.tier_id) {
        parent_ctx.tier_id.clone()
    } else {
        catalog::AI_CHAT_DEFAULT_TIER_ID.to_string()
    };
    let tool_defs: Vec<Value> = catalog::get_tools_for_tier(&tier_id)
        .into_iter()
        .filter(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(|name| allowed_tools.iter().any(|allowed| allowed == name))
                .unwrap_or(false)
        })
        .collect();
    let system_prompt = catalog::subagent_system_prompt(&tier_id, &parent_ctx.work_dir.to_string_lossy());
    let mut messages: Vec<Value> = vec![
        json!({"role": "system", "content": system_prompt}),
        json!({"role": "user", "content": task}),
    ];

    // Sub-Agent darf keine weiteren Sub-Agenten starten (Rekursionsschutz) und
    // hat keinen interaktiven ask_user-Dialog.
    let sub_ctx = ToolCtx {
        manager: manager.clone(),
        peer_id: parent_ctx.peer_id.clone(),
        request_id: parent_ctx.request_id.clone(),
        work_dir: parent_ctx.work_dir.clone(),
        allow_bluetalk: false,
        tier_id: tier_id.clone(),
        cancel: cancel.clone(),
        interactive_ask: false,
    };

    let mut sub_segments: Vec<Value> = Vec::new();
    let mut sub_tool_events: Vec<Value> = Vec::new();
    let mut last_content = String::new();

    for _round in 0..MAX_SUBAGENT_ROUNDS {
        let mut no_progress = |_update: Value| {};
        let response = match chat_request_stream(
            manager,
            json!({
                "model": model.clone(),
                "messages": messages.clone(),
                "tools": tool_defs.clone(),
                "think": false,
            }),
            cancel,
            &mut sub_segments,
            &mut no_progress,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => {
                return SubagentOutcome {
                    ok: false,
                    content: last_content,
                    error,
                    tool_events: sub_tool_events,
                    segments: sub_segments,
                };
            }
        };

        let content = response.content.trim().to_string();
        if !content.is_empty() {
            last_content = content.clone();
        }
        let tool_calls = normalize_tool_calls_for_ollama(&response.tool_calls);
        if tool_calls.is_empty() {
            return SubagentOutcome {
                ok: true,
                content,
                error: String::new(),
                tool_events: sub_tool_events,
                segments: sub_segments,
            };
        }

        messages.push(json!({
            "role": "assistant",
            "content": response.content,
            "tool_calls": tool_calls.clone(),
        }));

        for call in &tool_calls {
            let tool_name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tool_args = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = Box::pin(tools::execute_tool_call(&tool_name, &tool_args, &sub_ctx)).await;
            if tool_name != "run_command" {
                let event = json!({
                    "name": tool_name.clone(),
                    "arguments": tool_args.clone(),
                    "result": result.clone(),
                });
                sub_tool_events.push(event.clone());
                sub_segments.push(json!({"type": "tool", "event": event}));
                let len = sub_segments.len();
                if len >= 2
                    && segment_type(&sub_segments[len - 2]) == "thinking"
                    && let Some(object) = sub_segments[len - 2].as_object_mut()
                {
                    object.insert("toolAfter".into(), json!(true));
                }
            }
            messages.push(json!({
                "role": "tool",
                "name": tool_name.clone(),
                "content": tools::format_tool_result_message_content(&tool_name, &result),
            }));
        }
    }

    SubagentOutcome {
        ok: false,
        content: last_content,
        error: "subagent_loop_limit".into(),
        tool_events: sub_tool_events,
        segments: sub_segments,
    }
}

fn update_subagent_segment(segments: &mut [Value], id: &str, patch: &Value) {
    for segment in segments.iter_mut() {
        if segment_type(segment) == "subagent"
            && segment.get("id").and_then(Value::as_str) == Some(id)
            && let (Some(target), Some(source)) = (segment.as_object_mut(), patch.as_object())
        {
            for (key, value) in source {
                target.insert(key.clone(), value.clone());
            }
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Haupt-Chat mit Agent-Loop
// ---------------------------------------------------------------------------

/// Führt einen KI-Chat aus (v1 `OllamaManager#chat`). Gibt die
/// v1-kompatible Ergebnisform `{ok, message, state}` bzw. `{ok:false, error,
/// state}` zurück.
pub async fn chat(manager: Arc<OllamaManager>, payload: Value) -> Value {
    let peer_id = payload
        .get("peerId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let prompt = payload
        .get("prompt")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let request_id = payload
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let attachments: Vec<Value> = payload
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| !a.is_null())
        .collect();

    if prompt.is_empty() && attachments.is_empty() {
        return json!({"ok": false, "error": "empty_prompt"});
    }

    let state = manager.refresh_state().await;
    if !state.setup_complete {
        return json!({"ok": false, "error": "setup_incomplete", "state": manager.state_value()});
    }
    if !attachments.is_empty()
        && !catalog::model_supports_vision(&state.selected_model_tier, &state.selected_cloud_model_id)
    {
        return json!({"ok": false, "error": "vision_not_supported", "state": manager.state_value()});
    }
    let tier_id = state.selected_model_tier.clone();
    let model = catalog::resolve_active_model_name(&tier_id, &state.selected_cloud_model_id);
    if model.is_empty() {
        return json!({"ok": false, "error": "model_missing", "state": manager.state_value()});
    }
    if !manager.ensure_server_running().await {
        return json!({"ok": false, "error": "server_not_running", "state": manager.state_value()});
    }

    let cancel = manager.register_abort(&request_id);
    let result = run_agent_chat(
        &manager,
        &peer_id,
        &prompt,
        &request_id,
        &attachments,
        &tier_id,
        &state.selected_cloud_model_id,
        &model,
        &cancel,
    )
    .await;
    manager.remove_abort(&request_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_agent_chat(
    manager: &Arc<OllamaManager>,
    peer_id: &str,
    prompt: &str,
    request_id: &str,
    attachments: &[Value],
    tier_id: &str,
    selected_cloud_model_id: &str,
    model: &str,
    cancel: &CancelToken,
) -> Value {
    let agent_ctx = resolve_agent_context(manager, peer_id);
    let think_option = catalog::resolve_think_option(&agent_ctx.thinking_mode, model, tier_id);

    // Tool-Sätze: erlaubte Tools (BlueTalk ggf. gefiltert) + alle gültigen Namen.
    let all_tier_tools = catalog::get_tools_for_tier(tier_id);
    let tier_tools: Vec<Value> = all_tier_tools
        .iter()
        .filter(|t| {
            let name = t
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            !(catalog::is_bluetalk_agent_tool(name) && !agent_ctx.allow_bluetalk)
        })
        .cloned()
        .collect();
    let tier_tool_names: Vec<String> = tier_tools
        .iter()
        .filter_map(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();
    let all_tier_tool_names: Vec<String> = all_tier_tools
        .iter()
        .filter_map(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect();

    let tool_ctx = ToolCtx {
        manager: manager.clone(),
        peer_id: peer_id.to_string(),
        request_id: request_id.to_string(),
        work_dir: agent_ctx.work_dir.clone(),
        allow_bluetalk: agent_ctx.allow_bluetalk,
        tier_id: tier_id.to_string(),
        cancel: cancel.clone(),
        interactive_ask: true,
    };

    // Segmente in echter Reihenfolge: thinking -> tool -> thinking -> ... -> answer.
    let mut segments: Vec<Value> = Vec::new();
    let mut history = build_chat_history(manager, peer_id, tier_id, prompt, attachments, &agent_ctx);
    let mut collected_tool_events: Vec<Value> = Vec::new();
    let mut final_content = String::new();
    let mut final_thinking = String::new();
    let mut final_stats: Option<Value> = None;
    let mut forged_tool_result_repairs = 0usize;

    let app = manager.app.clone();
    let request_id_owned = request_id.to_string();
    let mut forward_progress = move |mut update: Value| {
        if let Some(object) = update.as_object_mut() {
            object.insert("requestId".into(), json!(request_id_owned));
        }
        let _ = app.emit_to("main", "ollama:chat-progress", update);
    };

    let mut rounds = 0usize;
    let loop_result: Result<(), String> = 'agent: loop {
        rounds += 1;
        if rounds > MAX_AGENT_ROUNDS {
            log::warn!("[Agent] Loop-Limit erreicht ({MAX_AGENT_ROUNDS} Runden) — breche ab.");
            break Ok(());
        }

        let response = match chat_request_stream(
            manager,
            json!({
                "model": model,
                "messages": history.clone(),
                "tools": tier_tools.clone(),
                "think": think_option.clone(),
            }),
            cancel,
            &mut segments,
            &mut forward_progress,
        )
        .await
        {
            Ok(response) => response,
            Err(error) => break Err(error),
        };

        let resolved = resolve_tool_calls_from_assistant_text(
            &response.tool_calls,
            &response.content,
            &response.thinking,
            &all_tier_tool_names,
            &tier_tool_names,
        );
        let tool_calls = resolved.tool_calls;
        let mut display_content = resolved.display_content;
        let mut msg_thinking = resolved.thinking_text;

        if !tool_calls.is_empty() {
            let names: Vec<&str> = tool_calls
                .iter()
                .filter_map(|c| c.get("function").and_then(|f| f.get("name")).and_then(Value::as_str))
                .collect();
            log::info!("[Agent] {} Tool-Aufruf(e): {}", tool_calls.len(), names.join(", "));
        }

        if tool_calls.is_empty() && resolved.spoofed_tool_result && forged_tool_result_repairs < 1 {
            forged_tool_result_repairs += 1;
            log::warn!("[Agent] Gefälschtes Tool-Ergebnis erkannt; fordere nativen Function-Call erneut an.");
            clear_last_stream_answer(&mut segments);
            history.push(json!({"role": "system", "content": SYSTEM_CORRECTION_PROMPT}));
            forward_progress(json!({
                "thinking": final_thinking,
                "content": final_content,
                "segments": segments.clone(),
                "tps": 0,
                "genTimeMs": 0,
                "done": false,
            }));
            continue 'agent;
        }

        if tool_calls.is_empty() && resolved.spoofed_tool_result {
            display_content =
                "Die Aktion wurde nicht ausgeführt, weil das Modell kein gültiges Werkzeug verwendet hat."
                    .to_string();
            msg_thinking = String::new();
        }

        if tool_calls.is_empty() {
            if response.stats.is_some() {
                final_stats = response.stats;
            }
            if !display_content.is_empty() {
                final_content = if final_content.is_empty() {
                    display_content.clone()
                } else {
                    format!("{final_content}\n\n{display_content}")
                };
            }
            if !msg_thinking.is_empty() {
                final_thinking = if final_thinking.is_empty() {
                    msg_thinking.clone()
                } else {
                    format!("{final_thinking}\n\n{msg_thinking}")
                };
                upsert_stream_thinking(&mut segments, &msg_thinking);
            }
            if !display_content.trim().is_empty() {
                upsert_stream_answer(&mut segments, &display_content);
            }
            break Ok(());
        }

        if response.stats.is_some() {
            final_stats = response.stats;
        }
        if !msg_thinking.is_empty() {
            final_thinking = if final_thinking.is_empty() {
                msg_thinking.clone()
            } else {
                format!("{final_thinking}\n\n{msg_thinking}")
            };
            upsert_stream_thinking(&mut segments, &msg_thinking);
        }
        clear_last_stream_answer(&mut segments);
        forward_progress(json!({
            "thinking": final_thinking,
            "content": final_content,
            "segments": segments.clone(),
            "tps": 0,
            "genTimeMs": 0,
            "done": false,
        }));

        // Assistant-Nachricht mit Tool-Aufrufen an History anhängen.
        // Arguments müssen Objekte sein — Ollama lehnt JSON-Strings ab.
        history.push(json!({
            "role": "assistant",
            "content": display_content,
            "tool_calls": normalize_tool_calls_for_ollama(&tool_calls),
        }));

        let mut pending_user_question = String::new();
        for call in &tool_calls {
            if cancel.is_cancelled() {
                break 'agent Err("chat_aborted".to_string());
            }
            let tool_name = call
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tool_args = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));

            if tool_name == "run_command" {
                let pending_event =
                    json!({"name": tool_name.clone(), "arguments": tool_args.clone(), "pending": true});
                segments.push(json!({"type": "tool", "event": pending_event.clone()}));
                forward_progress(json!({
                    "thinking": final_thinking,
                    "content": final_content,
                    "toolResults": [pending_event],
                    "segments": segments.clone(),
                    "tps": 0,
                    "genTimeMs": 0,
                    "done": false,
                }));
            }

            let tool_result = if tool_name == "spawn_subagent" {
                execute_spawn_subagent(
                    manager,
                    &tool_ctx,
                    &tool_args,
                    cancel,
                    &mut segments,
                    &mut forward_progress,
                    &final_thinking,
                    &final_content,
                )
                .await
            } else {
                tools::execute_tool_call(&tool_name, &tool_args, &tool_ctx).await
            };
            log::info!(
                "[Agent] Tool ausgefuehrt: {tool_name} -> ok={}",
                tool_result.get("ok").and_then(Value::as_bool).unwrap_or(true)
            );

            if tool_name == "run_command" {
                for index in (0..segments.len()).rev() {
                    let is_pending_run = segment_type(&segments[index]) == "tool"
                        && segments[index]
                            .get("event")
                            .map(|event| {
                                event.get("name").and_then(Value::as_str) == Some("run_command")
                                    && event.get("pending").and_then(Value::as_bool) == Some(true)
                            })
                            .unwrap_or(false);
                    if is_pending_run {
                        segments.remove(index);
                        break;
                    }
                }
            } else {
                let tool_event = json!({
                    "name": tool_name.clone(),
                    "arguments": tool_args.clone(),
                    "result": tool_result.clone(),
                });
                collected_tool_events.push(tool_event.clone());
                segments.push(json!({"type": "tool", "event": tool_event}));
                let len = segments.len();
                if len >= 2
                    && segment_type(&segments[len - 2]) == "thinking"
                    && let Some(object) = segments[len - 2].as_object_mut()
                {
                    object.insert("toolAfter".into(), json!(true));
                }
            }

            let tool_results = if tool_name == "run_command" {
                json!([])
            } else {
                json!([{
                    "name": tool_name.clone(),
                    "arguments": tool_args.clone(),
                    "result": tool_result.clone(),
                }])
            };
            forward_progress(json!({
                "thinking": final_thinking,
                "content": final_content,
                "toolResults": tool_results,
                "segments": segments.clone(),
                "tps": 0,
                "genTimeMs": 0,
                "done": false,
            }));

            history.push(json!({
                "role": "tool",
                "name": tool_name.clone(),
                "content": tools::format_tool_result_message_content(&tool_name, &tool_result),
            }));

            // ask_user: Agent-Loop anhalten und Frage als finale Antwort
            // ausgeben. Der Nutzer antwortet im nächsten Chat-Turn normal.
            if tool_result.get("pending_user").and_then(Value::as_bool) == Some(true)
                && let Some(question) = tool_result.get("question").and_then(Value::as_str)
                && !question.is_empty()
            {
                pending_user_question = question.to_string();
                break;
            }
        }
        if !pending_user_question.is_empty() {
            final_content = if final_content.is_empty() {
                format!("❓ {pending_user_question}")
            } else {
                format!("{final_content}\n\n❓ {pending_user_question}")
            };
            break Ok(());
        }
    };

    if let Err(error) = loop_result {
        return json!({"ok": false, "error": error, "state": manager.state_value()});
    }

    let (split_thinking, split_content) = split_thinking_text(&final_content);
    let content = if split_content.is_empty() {
        final_content.clone()
    } else {
        split_content
    };
    let thinking = [final_thinking.as_str(), split_thinking.as_str()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<&str>>()
        .join("\n\n")
        .trim()
        .to_string();

    // Kein harter Fehler, wenn zwar kein Text, aber Thinking- oder Tool-Segmente
    // vorhanden sind — kleine Modelle beenden den Loop oft ohne finale Antwort.
    let has_segments = segments
        .iter()
        .any(|s| matches!(segment_type(s), "thinking" | "tool" | "answer"));
    if content.trim().is_empty() && !has_segments {
        return json!({"ok": false, "error": "empty_response", "state": manager.state_value()});
    }

    let normalized_segments = consolidate_segments(&segments);

    let sender = if tier_id == "cloud" {
        catalog::get_cloud_model(catalog::resolve_cloud_model_id(selected_cloud_model_id))
            .map(|m| m.label.to_string())
            .unwrap_or_else(|| "Cloud".to_string())
    } else {
        catalog::get_model_tier(tier_id)
            .map(|t| t.label.to_string())
            .unwrap_or_else(|| "Ollama".to_string())
    };

    let mut message = Map::new();
    message.insert("kind".into(), json!("chat"));
    message.insert("content".into(), json!(content));
    if !thinking.is_empty() {
        message.insert("thinking".into(), json!(thinking));
    }
    if !collected_tool_events.is_empty() {
        message.insert("toolEvents".into(), json!(collected_tool_events));
    }
    if !normalized_segments.is_empty() {
        message.insert("segments".into(), json!(normalized_segments));
    }
    if let Some(stats) = final_stats {
        message.insert("stats".into(), stats);
    }
    message.insert("sender".into(), json!(sender));
    message.insert("model".into(), json!(model));

    json!({
        "ok": true,
        "message": Value::Object(message),
        "state": manager.state_value(),
    })
}

/// Behandelt spawn_subagent im Haupt-Loop: Segment anlegen, Sub-Agent laufen
/// lassen, Segment aktualisieren. Liefert das Tool-Ergebnis (v1-Form).
#[allow(clippy::too_many_arguments)]
async fn execute_spawn_subagent(
    manager: &Arc<OllamaManager>,
    tool_ctx: &ToolCtx,
    tool_args: &Value,
    cancel: &CancelToken,
    segments: &mut Vec<Value>,
    forward_progress: &mut (dyn FnMut(Value) + Send),
    final_thinking: &str,
    final_content: &str,
) -> Value {
    let task = tool_args
        .get("task")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if task.is_empty() {
        return json!({"ok": false, "error": "empty_task"});
    }
    let valid_names = catalog::agent_tool_names();
    let allowed_tools: Vec<String> = tool_args
        .get("tools")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .filter(|name| valid_names.iter().any(|valid| valid == name))
                .map(str::to_string)
                .collect::<Vec<String>>()
        })
        .filter(|list| !list.is_empty())
        .unwrap_or_else(|| {
            catalog::SUBAGENT_DEFAULT_TOOLS
                .iter()
                .map(|s| s.to_string())
                .collect()
        });

    let subagent_id = Uuid::new_v4().to_string();
    segments.push(json!({
        "type": "subagent",
        "id": subagent_id.clone(),
        "task": task.clone(),
        "tools": allowed_tools.clone(),
        "status": "running",
        "content": "",
        "thinking": "",
        "toolEvents": [],
        "segments": [],
    }));
    forward_progress(json!({
        "thinking": final_thinking,
        "content": final_content,
        "segments": segments.clone(),
        "tps": 0,
        "genTimeMs": 0,
        "done": false,
    }));

    let outcome = run_subagent(manager, tool_ctx, &task, &allowed_tools, cancel).await;

    let patch = if outcome.ok {
        json!({
            "status": "done",
            "content": outcome.content.clone(),
            "toolEvents": outcome.tool_events.clone(),
            "segments": outcome.segments.clone(),
        })
    } else {
        json!({
            "status": "error",
            "content": outcome.content.clone(),
            "error": outcome.error.clone(),
            "toolEvents": outcome.tool_events.clone(),
            "segments": outcome.segments.clone(),
        })
    };
    update_subagent_segment(segments, &subagent_id, &patch);
    forward_progress(json!({
        "thinking": final_thinking,
        "content": final_content,
        "segments": segments.clone(),
        "tps": 0,
        "genTimeMs": 0,
        "done": false,
    }));

    if outcome.ok {
        json!({"ok": true, "result": {"content": outcome.content}})
    } else {
        json!({"ok": false, "error": outcome.error})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_reasoning_stays_out_of_the_answer_body() {
        // gpt-oss / qwen3 deliver reasoning through the native `thinking` field
        // (no <think> tags). With tools available but none called this turn, the
        // reasoning must land in the working block, never in display_content.
        let tools = vec!["read_file".to_string(), "run_command".to_string()];
        let resolved = resolve_tool_calls_from_assistant_text(
            &[],
            "Hallo! Wie kann ich dir helfen?",
            "User says hi. No tool needed. Respond in German.",
            &tools,
            &tools,
        );
        assert!(resolved.tool_calls.is_empty());
        assert_eq!(resolved.display_content, "Hallo! Wie kann ich dir helfen?");
        assert_eq!(
            resolved.thinking_text,
            "User says hi. No tool needed. Respond in German."
        );
    }

    #[test]
    fn inline_think_tags_are_split_from_content() {
        let resolved = resolve_tool_calls_from_assistant_text(
            &[],
            "<think>weighing options</think>Die Antwort lautet 42.",
            "",
            &[],
            &[],
        );
        assert_eq!(resolved.display_content, "Die Antwort lautet 42.");
        assert_eq!(resolved.thinking_text, "weighing options");
    }
}
