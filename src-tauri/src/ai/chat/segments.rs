//! Thinking-Text-Aufteilung und Segment-Helfer (Portierung von
//! `ai-stream-segments.js`/`agent-segments.js`). Baut die Live-Segmentliste
//! (thinking → tool → thinking → … → answer) auf und normalisiert sie für
//! Anzeige und Persistenz.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// Regexe (auch von `tool_parsing` genutzt)
// ---------------------------------------------------------------------------

#[allow(clippy::expect_used)]
pub(super) fn static_regex(pattern: &str) -> Regex {
    Regex::new(pattern).expect("statische Regex ist gültig")
}

static THINK_OPEN_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)<(?:redacted_thinking|think|redacted_reasoning)>"));
static THINK_CLOSE_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)</(?:redacted_thinking|think|redacted_reasoning)>"));
static THINK_TAG_RE: LazyLock<Regex> =
    LazyLock::new(|| static_regex(r"(?i)</?(?:redacted_thinking|think|redacted_reasoning)>"));
pub(super) static MULTI_NEWLINE_RE: LazyLock<Regex> = LazyLock::new(|| static_regex(r"\n{3,}"));

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

pub(super) fn segment_type(segment: &Value) -> &str {
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
