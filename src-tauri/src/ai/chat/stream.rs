//! Streaming-Request an `/api/chat` (v1 `_chatRequestStream`): akkumuliert
//! thinking/content, extrahiert tool_calls, baut Live-Segmente auf und meldet
//! Fortschritt.

use std::{sync::Arc, time::Instant};

use serde_json::{Value, json};

use crate::ai::manager::{CancelToken, OllamaManager};

use super::segments::{split_thinking_text, upsert_stream_answer, upsert_stream_thinking};

pub struct StreamResponse {
    pub thinking: String,
    pub content: String,
    pub tool_calls: Vec<Value>,
    pub stats: Option<Value>,
}

/// POST /api/chat mit stream:true — akkumuliert thinking/content, extrahiert
/// tool_calls, baut Live-Segmente auf und meldet Fortschritt.
pub(super) async fn chat_request_stream(
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

fn openai_string(value: Option<&Value>, keys: &[&str]) -> String {
    let Some(value) = value else {
        return String::new();
    };
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn to_openai_messages(history: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut pending_ids: Vec<String> = Vec::new();
    let mut next_id = 0usize;
    for message in history {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "tool" {
            let id = if pending_ids.is_empty() {
                next_id += 1;
                format!("call_{next_id}")
            } else {
                pending_ids.remove(0)
            };
            out.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": message.get("content").cloned().unwrap_or_else(|| json!("")),
            }));
            continue;
        }
        if role == "assistant" {
            pending_ids.clear();
            let mut converted = json!({
                "role": "assistant",
                "content": message.get("content").cloned().unwrap_or_else(|| json!("")),
            });
            if let Some(calls) = message.get("tool_calls").and_then(Value::as_array) {
                let mut openai_calls = Vec::new();
                for call in calls {
                    next_id += 1;
                    let id = openai_string(Some(call), &["id"]);
                    let id = if id.is_empty() {
                        format!("call_{next_id}")
                    } else {
                        id
                    };
                    pending_ids.push(id.clone());
                    let name = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let args = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    let args_text = match args {
                        Value::String(text) => text,
                        other => serde_json::to_string(&other).unwrap_or_else(|_| "{}".to_string()),
                    };
                    openai_calls.push(json!({
                        "id": id,
                        "type": "function",
                        "function": { "name": name, "arguments": args_text }
                    }));
                }
                if let Some(object) = converted.as_object_mut() {
                    object.insert("tool_calls".into(), json!(openai_calls));
                }
            }
            out.push(converted);
            continue;
        }
        let mut converted = json!({
            "role": if role.is_empty() { "user" } else { role },
            "content": message.get("content").cloned().unwrap_or_else(|| json!("")),
        });
        if let Some(images) = message.get("images").and_then(Value::as_array) {
            let mut parts = vec![json!({
                "type": "text",
                "text": message.get("content").and_then(Value::as_str).unwrap_or(""),
            })];
            for image in images {
                if let Some(data) = image.as_str() {
                    let url = if data.starts_with("data:") {
                        data.to_string()
                    } else {
                        format!("data:image/jpeg;base64,{data}")
                    };
                    parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": url }
                    }));
                }
            }
            if let Some(object) = converted.as_object_mut() {
                object.insert("content".into(), json!(parts));
            }
        }
        out.push(converted);
    }
    out
}

fn merge_openai_tool_delta(acc: &mut std::collections::BTreeMap<u64, Value>, delta: &Value) {
    let index = delta.get("index").and_then(Value::as_u64).unwrap_or(0);
    let entry = acc.entry(index).or_insert_with(|| json!({
        "id": "",
        "type": "function",
        "function": { "name": "", "arguments": "" }
    }));
    if let Some(id) = delta.get("id").and_then(Value::as_str)
        && !id.is_empty()
        && let Some(object) = entry.as_object_mut()
    {
        object.insert("id".into(), json!(id));
    }
    let Some(function) = delta.get("function") else {
        return;
    };
    let Some(entry_fn) = entry.get_mut("function").and_then(Value::as_object_mut) else {
        return;
    };
    if let Some(name) = function.get("name").and_then(Value::as_str)
        && !name.is_empty()
    {
        entry_fn.insert("name".into(), json!(name));
    }
    if let Some(args) = function.get("arguments").and_then(Value::as_str) {
        let current = entry_fn
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        entry_fn.insert("arguments".into(), json!(format!("{current}{args}")));
    }
}

/// POST {base}/chat/completions im OpenAI-SSE-Format.
pub(super) async fn openai_chat_request_stream(
    openai: &crate::ai::catalog::OpenAiCompat,
    history: &[Value],
    tools: &[Value],
    cancel: &CancelToken,
    live_segments: &mut Vec<Value>,
    on_progress: &mut (dyn FnMut(Value) + Send),
) -> Result<StreamResponse, String> {
    let url = format!("{}/chat/completions", openai.base_url.trim_end_matches('/'));
    let mut body = json!({
        "model": openai.model,
        "messages": to_openai_messages(history),
        "stream": true,
    });
    if !tools.is_empty() {
        if let Some(object) = body.as_object_mut() {
            object.insert("tools".into(), json!(tools));
            object.insert("tool_choice".into(), json!("auto"));
        }
    }
    let client = reqwest::Client::new();
    let mut request = client.post(&url).json(&body);
    let key = openai.api_key.trim();
    if !key.is_empty() {
        request = request.bearer_auth(key);
    }
    let response = tokio::select! {
        result = request.send() => result.map_err(|e| e.to_string())?,
        _ = cancel.cancelled() => return Err("chat_aborted".to_string()),
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body_text = response.text().await.unwrap_or_default();
        let message = serde_json::from_str::<Value>(&body_text)
            .ok()
            .and_then(|v| {
                v.get("error").and_then(|err| {
                    err.get("message")
                        .and_then(Value::as_str)
                        .or_else(|| err.as_str())
                        .map(str::to_string)
                })
            })
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
    let mut tool_acc: std::collections::BTreeMap<u64, Value> = std::collections::BTreeMap::new();
    let mut response = response;

    loop {
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
            let payload = line.strip_prefix("data:").map(str::trim).unwrap_or(line.as_str());
            if payload.is_empty() {
                continue;
            }
            if payload == "[DONE]" {
                buffer.clear();
                break;
            }
            let Ok(parsed) = serde_json::from_str::<Value>(payload) else {
                continue;
            };
            let delta = parsed
                .pointer("/choices/0/delta")
                .cloned()
                .or_else(|| parsed.pointer("/choices/0/message").cloned())
                .unwrap_or(Value::Null);
            if let Some(thinking) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
                && !thinking.is_empty()
            {
                full_thinking.push_str(thinking);
                estimated_tokens += (thinking.chars().count() as f64 / 4.0).ceil().max(1.0);
            }
            if let Some(content) = delta.get("content").and_then(Value::as_str)
                && !content.is_empty()
            {
                full_content.push_str(content);
                estimated_tokens += (content.chars().count() as f64 / 4.0).ceil().max(1.0);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    merge_openai_tool_delta(&mut tool_acc, call);
                }
            }
            let (split_thinking, split_content) = split_thinking_text(&full_content);
            if !full_thinking.trim().is_empty() {
                upsert_stream_thinking(live_segments, &full_thinking);
            }
            if !split_content.trim().is_empty() {
                upsert_stream_answer(live_segments, &split_content);
            }
            let elapsed_seconds = started.elapsed().as_secs_f64().max(0.001);
            on_progress(json!({
                "thinking": if split_thinking.is_empty() { full_thinking.clone() } else { split_thinking },
                "content": if split_content.is_empty() { full_content.clone() } else { split_content },
                "segments": live_segments.clone(),
                "tps": estimated_tokens / elapsed_seconds,
                "genTimeMs": elapsed_seconds * 1000.0,
                "done": false,
            }));
        }
    }

    let last_tool_calls: Vec<Value> = tool_acc.into_values().collect();
    if full_content.trim().is_empty() && full_thinking.trim().is_empty() && last_tool_calls.is_empty() {
        return Err("Leere API-Antwort.".to_string());
    }
    let elapsed_seconds = started.elapsed().as_secs_f64().max(0.001);
    Ok(StreamResponse {
        thinking: full_thinking,
        content: full_content,
        tool_calls: last_tool_calls,
        stats: Some(json!({
            "tps": estimated_tokens / elapsed_seconds,
            "genTimeMs": elapsed_seconds * 1000.0,
        })),
    })
}
