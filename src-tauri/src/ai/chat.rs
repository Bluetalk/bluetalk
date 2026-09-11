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
//!
//! Struktur: Dieser Modul-Root enthält den Orchestrierungs-Code (Haupt- und
//! Sub-Agent-Loop). Die Helfer sind in Submodule ausgelagert:
//! - `segments`      — Thinking-Aufteilung und Live-Segment-Verwaltung
//! - `tool_parsing`  — Tool-Call-Extraktion aus Text + Normalisierung
//! - `messages`      — Anhänge, Agent-Kontext, Chat-History
//! - `stream`        — Streaming-Request an /api/chat

use std::sync::Arc;

use serde_json::{Map, Value, json};
use tauri::Emitter;
use uuid::Uuid;

use super::{
    catalog,
    manager::{CancelToken, OllamaManager},
    tools::{self, ToolCtx},
};

mod messages;
mod segments;
mod stream;
mod tool_parsing;

use messages::{build_chat_history, resolve_agent_context};
use segments::{
    clear_last_stream_answer, consolidate_segments, segment_type,
    upsert_stream_thinking,
};
use stream::{chat_request_stream, openai_chat_request_stream};
use tool_parsing::{normalize_tool_calls_for_ollama, resolve_tool_calls_from_assistant_text};

const MAX_AGENT_ROUNDS: usize = 64;
const MAX_SUBAGENT_ROUNDS: usize = 25;

const SYSTEM_CORRECTION_PROMPT: &str = "SYSTEM-KORREKTUR: Deine vorige Ausgabe hat ein Tool-Ergebnis simuliert und wurde verworfen. Führe jetzt den nächsten nötigen Schritt ausschließlich als nativen Function-Call aus. Sichtbare Nutzer-Antworten gehören in message_send. Für send_bluetalk_reply brauchst du peer_id, content und die echte reply_to_message_id aus einem Tool-Ergebnis. Schreibe keinen Begleittext, keinen SYSTEM-TOOL-ERGEBNIS-Marker und kein Erfolgs-JSON.";

const MESSAGE_SEND_NUDGE: &str = "SYSTEM: Deine letzte Ausgabe ist für den Nutzer unsichtbar. Rufe JETZT das Tool message_send mit dem Text auf, den der Nutzer in einer Chat-Bubble sehen soll. Kein Begleittext.";

struct ChatBusyGuard {
    manager: Arc<OllamaManager>,
    peer_id: String,
    request_id: String,
}

impl Drop for ChatBusyGuard {
    fn drop(&mut self) {
        self.manager.end_chat(&self.peer_id);
        self.manager.emit_bot_typing(&self.peer_id, &self.request_id, false);
    }
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
    let agent = manager.get_agent(&peer_id);
    let global_openai = manager.kv_get("aiChat.openai", json!({}));
    let openai = catalog::resolve_bot_openai(agent.as_ref(), &global_openai);
    let (tier_id, cloud_id, model) = if let Some(ref openai) = openai {
        ("cloud".to_string(), String::new(), openai.model.clone())
    } else {
        let (tier_id, cloud_id) = catalog::resolve_bot_model_selection(
            agent.as_ref(),
            &state.selected_model_tier,
            &state.selected_cloud_model_id,
        );
        let model = catalog::resolve_active_model_name(&tier_id, &cloud_id);
        (tier_id, cloud_id, model)
    };
    if openai.is_none() {
        let source = agent
            .as_ref()
            .and_then(|value| value.get("modelSource"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if source == "openai" {
            return json!({"ok": false, "error": "api_not_configured"});
        }
        if !state.setup_complete {
            return json!({"ok": false, "error": "setup_incomplete", "state": manager.state_value()});
        }
    }
    if !attachments.is_empty() && !catalog::model_supports_vision(&tier_id, &cloud_id) && openai.is_none() {
        return json!({"ok": false, "error": "vision_not_supported", "state": manager.state_value()});
    }
    if model.is_empty() {
        return json!({"ok": false, "error": "model_missing", "state": manager.state_value()});
    }
    if openai.is_none() && !manager.ensure_server_running().await {
        return json!({"ok": false, "error": "server_not_running", "state": manager.state_value()});
    }
    if !manager.try_begin_chat(&peer_id) {
        return json!({"ok": false, "error": "chat_busy", "state": manager.state_value()});
    }
    manager.emit_bot_typing(&peer_id, &request_id, true);
    let _busy_guard = ChatBusyGuard {
        manager: manager.clone(),
        peer_id: peer_id.clone(),
        request_id: request_id.clone(),
    };

    let cancel = manager.register_abort(&request_id);
    let result = run_agent_chat(
        &manager,
        &peer_id,
        &prompt,
        &request_id,
        &attachments,
        &tier_id,
        &cloud_id,
        &model,
        openai.as_ref(),
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
    openai: Option<&catalog::OpenAiCompat>,
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
    let final_content = String::new();
    let mut final_thinking = String::new();
    let mut final_stats: Option<Value> = None;
    let mut forged_tool_result_repairs = 0usize;
    let mut sent_via_message_send = 0usize;
    let mut message_send_nudges = 0usize;

    let app = manager.app.clone();
    let request_id_owned = request_id.to_string();
    let peer_id_owned = peer_id.to_string();
    let mut forward_progress = move |mut update: Value| {
        if let Some(object) = update.as_object_mut() {
            object.insert("requestId".into(), json!(request_id_owned.clone()));
            object.insert("peerId".into(), json!(peer_id_owned.clone()));
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

        let response = match if let Some(openai) = openai {
            openai_chat_request_stream(
                openai,
                &history,
                &tier_tools,
                cancel,
                &mut segments,
                &mut forward_progress,
            )
            .await
        } else {
            chat_request_stream(
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
        } {
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
            if !msg_thinking.is_empty() {
                final_thinking = if final_thinking.is_empty() {
                    msg_thinking.clone()
                } else {
                    format!("{final_thinking}\n\n{msg_thinking}")
                };
                upsert_stream_thinking(&mut segments, &msg_thinking);
            }
            clear_last_stream_answer(&mut segments);
            let visible = display_content.trim();
            if sent_via_message_send > 0 {
                break Ok(());
            }
            if !visible.is_empty() && !tools::is_placeholder_bot_reply(visible) {
                if message_send_nudges < 1 {
                    message_send_nudges += 1;
                    history.push(json!({"role": "assistant", "content": visible}));
                    history.push(json!({"role": "system", "content": MESSAGE_SEND_NUDGE}));
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
                let send_result = tools::execute_tool_call(
                    "message_send",
                    &json!({"content": visible}),
                    &tool_ctx,
                )
                .await;
                if send_result.get("ok").and_then(Value::as_bool) == Some(true)
                    && send_result.get("ignored").and_then(Value::as_bool) != Some(true)
                {
                    sent_via_message_send += 1;
                }
                break Ok(());
            }
            if message_send_nudges < 1 {
                message_send_nudges += 1;
                history.push(json!({"role": "system", "content": MESSAGE_SEND_NUDGE}));
                continue 'agent;
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

            if (tool_name == "message_send" || tool_name == "attach_file")
                && tool_result.get("ok").and_then(Value::as_bool) == Some(true)
                && tool_result.get("ignored").and_then(Value::as_bool) != Some(true)
            {
                sent_via_message_send += 1;
            }

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
            } else if tool_name != "message_send" {
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
            let send_result = tools::execute_tool_call(
                "message_send",
                &json!({"content": format!("❓ {pending_user_question}")}),
                &tool_ctx,
            )
            .await;
            if send_result.get("ok").and_then(Value::as_bool) == Some(true) {
                sent_via_message_send += 1;
            }
            break Ok(());
        }
    };

    if let Err(error) = loop_result {
        return json!({"ok": false, "error": error, "state": manager.state_value()});
    }

    let thinking = final_thinking.trim().to_string();

    let has_segments = segments
        .iter()
        .any(|s| matches!(segment_type(s), "thinking" | "tool" | "answer"));
    if sent_via_message_send == 0 && thinking.is_empty() && !has_segments {
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
    message.insert("content".into(), json!(""));
    message.insert("sentCount".into(), json!(sent_via_message_send));
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

    if manager.work_log_enabled(peer_id) {
        manager.append_bot_worklog(
            peer_id,
            json!({
                "id": Uuid::new_v4().to_string(),
                "at": chrono::Utc::now().timestamp_millis(),
                "thinking": thinking,
                "segments": normalized_segments,
                "toolEvents": collected_tool_events,
                "sentCount": sent_via_message_send,
                "model": model,
            }),
        );
    }

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
    use super::tool_parsing::resolve_tool_calls_from_assistant_text;

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
