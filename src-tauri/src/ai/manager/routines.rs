//! Bot-Routinen: Scheduler und manueller Lauf. Teil von `OllamaManager`.

use super::*;
use chrono::{Local, Timelike};

const ROUTINE_TICK_SECS: u64 = 20;

impl OllamaManager {
    pub async fn run_routine_scheduler_loop(manager: Arc<Self>) {
        let mut ticker = tokio::time::interval(Duration::from_secs(ROUTINE_TICK_SECS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            let due = manager.collect_due_routines();
            for (peer_id, routine_id) in due {
                let _ = manager.run_bot_routine(&peer_id, &routine_id).await;
            }
        }
    }

    fn collect_due_routines(&self) -> Vec<(String, String)> {
        let agents = self.kv_get("aiChat.agents", json!([]));
        let Some(list) = agents.as_array() else {
            return Vec::new();
        };
        let now = Local::now();
        let now_ms = now.timestamp_millis();
        let mut due = Vec::new();
        let mut armed: Vec<(String, String, i64)> = Vec::new();

        for agent in list {
            let Some(peer_id) = agent.get("id").and_then(Value::as_str) else {
                continue;
            };
            if !catalog::is_ai_chat_peer_id(peer_id) {
                continue;
            }
            let Some(routines) = agent.get("routines").and_then(Value::as_array) else {
                continue;
            };
            for routine in routines {
                if routine.get("enabled").and_then(Value::as_bool) == Some(false) {
                    continue;
                }
                let Some(routine_id) = routine.get("id").and_then(Value::as_str) else {
                    continue;
                };
                let prompt = routine
                    .get("prompt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                if prompt.is_empty() {
                    continue;
                }
                let trigger = routine
                    .get("triggerType")
                    .and_then(Value::as_str)
                    .unwrap_or("manual");
                let last_run_at = routine
                    .get("lastRunAt")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                match trigger {
                    "interval" => {
                        let minutes = routine
                            .get("intervalMinutes")
                            .and_then(Value::as_i64)
                            .unwrap_or(60)
                            .clamp(5, 24 * 60);
                        if last_run_at <= 0 {
                            armed.push((peer_id.to_string(), routine_id.to_string(), now_ms));
                            continue;
                        }
                        if now_ms - last_run_at >= minutes * 60_000 {
                            due.push((peer_id.to_string(), routine_id.to_string()));
                        }
                    }
                    "daily" => {
                        let hour = routine
                            .get("hour")
                            .and_then(Value::as_i64)
                            .unwrap_or(8)
                            .clamp(0, 23) as u32;
                        let minute = routine
                            .get("minute")
                            .and_then(Value::as_i64)
                            .unwrap_or(0)
                            .clamp(0, 59) as u32;
                        if last_run_at <= 0 {
                            if is_daily_routine_due(hour, minute, last_run_at, now) {
                                due.push((peer_id.to_string(), routine_id.to_string()));
                            }
                            continue;
                        }
                        if is_daily_routine_due(hour, minute, last_run_at, now) {
                            due.push((peer_id.to_string(), routine_id.to_string()));
                        }
                    }
                    _ => {}
                }
            }
        }

        for (peer_id, routine_id, at) in armed {
            self.mark_routine_run(&peer_id, &routine_id, at);
        }
        due
    }

    pub fn mark_routine_run(&self, peer_id: &str, routine_id: &str, at: i64) {
        let mut agents = self.kv_get("aiChat.agents", json!([]));
        let Some(list) = agents.as_array_mut() else {
            return;
        };
        let mut changed = false;
        for agent in list.iter_mut() {
            if agent.get("id").and_then(Value::as_str) != Some(peer_id) {
                continue;
            }
            let Some(routines) = agent.get_mut("routines").and_then(Value::as_array_mut) else {
                continue;
            };
            for routine in routines {
                if routine.get("id").and_then(Value::as_str) != Some(routine_id) {
                    continue;
                }
                if let Some(object) = routine.as_object_mut() {
                    object.insert("lastRunAt".into(), json!(at));
                    changed = true;
                }
            }
        }
        if changed {
            self.kv_set("aiChat.agents", agents);
        }
    }

    pub async fn run_bot_routine(self: &Arc<Self>, peer_id: &str, routine_id: &str) -> Value {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_bot_chat"});
        }
        let agent = match self.get_agent(peer_id) {
            Some(agent) => agent,
            None => return json!({"ok": false, "error": "bot_not_found"}),
        };
        let routine = agent
            .get("routines")
            .and_then(Value::as_array)
            .and_then(|list| {
                list.iter()
                    .find(|entry| entry.get("id").and_then(Value::as_str) == Some(routine_id))
                    .cloned()
            });
        let Some(routine) = routine else {
            return json!({"ok": false, "error": "routine_not_found"});
        };
        let name = routine
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Routine")
            .trim();
        let prompt = routine
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if prompt.is_empty() {
            return json!({"ok": false, "error": "empty_prompt"});
        }
        if self.is_chat_busy(peer_id) {
            return json!({"ok": false, "error": "chat_busy"});
        }

        let now_ms = chrono::Utc::now().timestamp_millis();
        self.mark_routine_run(peer_id, routine_id, now_ms);

        let request_id = Uuid::new_v4().to_string();
        let user_prompt = format!(
            "[Routine: {name}]\n{prompt}\n\nFühre diese Routine jetzt aus. Schreibe das Ergebnis mit message_send in diesen Chat."
        );
        crate::ai::chat::chat(
            Arc::clone(self),
            json!({
                "peerId": peer_id,
                "prompt": user_prompt,
                "requestId": request_id,
                "attachments": [],
            }),
        )
        .await
    }
}

fn is_daily_routine_due(
    hour: u32,
    minute: u32,
    last_run_at: i64,
    now: chrono::DateTime<Local>,
) -> bool {
    let now_minutes = now.hour() * 60 + now.minute();
    let scheduled_minutes = hour * 60 + minute;
    if now_minutes < scheduled_minutes {
        return false;
    }
    if last_run_at <= 0 {
        return true;
    }
    let Some(last) = chrono::DateTime::from_timestamp_millis(last_run_at) else {
        return true;
    };
    last.with_timezone(&Local).date_naive() != now.date_naive()
}
