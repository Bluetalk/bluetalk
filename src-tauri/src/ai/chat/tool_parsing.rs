//! Tool-Call-Extraktion aus Text (reduzierte v1-Fallbacks aus `agent-tools.js`)
//! sowie die Zusammenführung von nativen tool_calls mit dem Text-Fallback
//! (`resolveToolCallsFromAssistantText`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use super::segments::{
    MULTI_NEWLINE_RE, split_thinking_text, static_regex, strip_orphan_thinking_tags,
};

static FORGED_RESULT_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)\[SYSTEM-TOOL-ERGEBNIS\b[^\]]*\]"));
static CODE_FENCE_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?is)```(?:json|tool_call|tool)?\s*(.*?)```"));

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
