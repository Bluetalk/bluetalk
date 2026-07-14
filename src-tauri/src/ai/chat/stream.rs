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
