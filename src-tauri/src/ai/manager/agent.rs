//! Cloud-Anmeldung, ask_user-Flow, Agent-Renderer-Brücke, Agent-Memory,
//! Kontakt-Labels und Reset. Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    // -- Cloud ---------------------------------------------------------------------

    pub async fn start_cloud_sign_in(&self) -> Value {
        let bin = self.runtime_binary_path().await;
        if bin.is_empty() {
            return json!({"ok": false, "error": "runtime_not_ready", "state": self.state()});
        }
        self.ensure_server_running().await;

        let mut command = tokio::process::Command::new(&bin);
        command.arg("signin");
        for (key, value) in self.runtime_env() {
            command.env(key, value);
        }
        command.stdin(std::process::Stdio::null());
        command.stdout(std::process::Stdio::null());
        command.stderr(std::process::Stdio::null());
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);

        match command.spawn() {
            Ok(_child) => json!({"ok": true, "state": self.state()}),
            Err(error) => json!({"ok": false, "error": error.to_string(), "state": self.state()}),
        }
    }

    pub async fn confirm_cloud_auth(&self) -> Value {
        self.kv_set("aiChat.cloudAuth", json!(true));
        self.broadcast(|s| {
            s.cloud_auth = true;
            s.model_status.insert("cloud".into(), "ready".into());
        });
        let state = self.refresh_state().await;
        json!({"ok": true, "state": state})
    }

    // -- ask_user-Flow ----------------------------------------------------------------

    /// Führt eine ask_user-Anfrage aus: Event an das Main-Fenster, Antwort via
    /// `ollama_reply_ask_user`, Timeout 3 Minuten, abbruchbar über abort_chat.
    pub async fn run_ask_user(
        &self,
        peer_id: &str,
        request_id: &str,
        question: &str,
        options: &[String],
    ) -> Value {
        let (tx, rx) = oneshot::channel::<String>();
        self.ask_registry
            .lock()
            .insert(request_id.to_string(), (peer_id.to_string(), tx));

        let emitted = self
            .app
            .emit_to(
                "main",
                "ollama:ask-user",
                json!({
                    "peerId": peer_id,
                    "requestId": request_id,
                    "question": question,
                    "options": options,
                }),
            )
            .is_ok();
        if !emitted {
            self.ask_registry.lock().remove(request_id);
            return json!({
                "ok": true,
                "pending_user": true,
                "answered": false,
                "question": question,
                "note": "Kein interaktiver Dialog verfügbar.",
            });
        }
        let _ = self.append_bot_chat_message(peer_id, question);

        let outcome = tokio::time::timeout(Duration::from_secs(180), rx).await;
        self.ask_registry.lock().remove(request_id);
        let _ = self.app.emit_to(
            "main",
            "ollama:ask-user-done",
            json!({ "requestId": request_id, "peerId": peer_id }),
        );

        match outcome {
            Ok(Ok(answer)) => {
                let text: String = answer.trim().chars().take(8000).collect();
                json!({
                    "ok": true,
                    "answered": !text.is_empty(),
                    "question": question,
                    "answer": text,
                })
            }
            Ok(Err(_)) => json!({
                "ok": true,
                "answered": false,
                "question": question,
                "answer": "",
                "note": "Abgebrochen.",
            }),
            Err(_) => json!({
                "ok": true,
                "answered": false,
                "question": question,
                "answer": "",
                "note": "Zeitüberschreitung.",
            }),
        }
    }

    pub fn reply_ask_user(&self, request_id: &str, answer: String) -> Value {
        let pending = self.ask_registry.lock().remove(request_id);
        match pending {
            Some((peer_id, sender)) => {
                let text: String = answer.trim().chars().take(8000).collect();
                if !text.is_empty() {
                    let _ = self.append_user_chat_message(&peer_id, &text);
                }
                let _ = sender.send(text);
                json!({"ok": true})
            }
            None => json!({"ok": false, "error": "not_found"}),
        }
    }

    // -- Agent-Renderer-Brücke (send message / connect peer) -----------------------------

    async fn request_agent_reply(&self, event: &str, mut payload: Map<String, Value>, timeout: Duration) -> Value {
        let request_id = Uuid::new_v4().to_string();
        payload.insert("requestId".into(), json!(request_id));
        let (tx, rx) = oneshot::channel::<Value>();
        self.agent_replies.lock().insert(request_id.clone(), tx);

        if self
            .app
            .emit_to("main", event, Value::Object(payload))
            .is_err()
        {
            self.agent_replies.lock().remove(&request_id);
            return json!({"ok": false, "error": "renderer_unavailable"});
        }

        let outcome = tokio::time::timeout(timeout, rx).await;
        self.agent_replies.lock().remove(&request_id);
        match outcome {
            Ok(Ok(result)) => {
                if result.is_object() {
                    result
                } else {
                    json!({"ok": false, "error": "invalid_reply"})
                }
            }
            Ok(Err(_)) => json!({"ok": false, "error": "reply_channel_closed"}),
            Err(_) => {
                if event == "agent:connect-peer" {
                    json!({"ok": false, "error": "connect_timeout"})
                } else {
                    json!({"ok": false, "error": "send_timeout"})
                }
            }
        }
    }

    pub async fn request_agent_send_message(
        &self,
        peer_id: &str,
        content: &str,
        reply_to: Option<Value>,
    ) -> Value {
        let mut payload = Map::new();
        payload.insert("peerId".into(), json!(peer_id));
        payload.insert("content".into(), json!(content));
        payload.insert("replyTo".into(), reply_to.unwrap_or(Value::Null));
        self.request_agent_reply("agent:send-message", payload, Duration::from_secs(30))
            .await
    }

    pub async fn request_agent_connect_peer(&self, address: &str) -> Value {
        let mut payload = Map::new();
        payload.insert("address".into(), json!(address));
        self.request_agent_reply("agent:connect-peer", payload, Duration::from_secs(45))
            .await
    }

    pub fn agent_reply(&self, request_id: &str, result: Value) -> Value {
        let sender = self.agent_replies.lock().remove(request_id);
        match sender {
            Some(sender) => {
                let _ = sender.send(result);
                json!({"ok": true})
            }
            None => json!({"ok": false, "error": "not_found"}),
        }
    }

    // -- Agent-Memory -----------------------------------------------------------------

    fn load_agent_memory(&self, peer_id: &str) -> Map<String, Value> {
        {
            let cache = self.memory_cache.lock();
            if let Some(bag) = cache.get(peer_id) {
                return bag.clone();
            }
        }
        let stored = self.kv_get(&format!("aiChat.memory.{peer_id}"), json!({}));
        let bag = stored.as_object().cloned().unwrap_or_default();
        self.memory_cache.lock().insert(peer_id.to_string(), bag.clone());
        bag
    }

    fn store_agent_memory(&self, peer_id: &str, bag: Map<String, Value>) {
        self.memory_cache.lock().insert(peer_id.to_string(), bag.clone());
        self.kv_set(&format!("aiChat.memory.{peer_id}"), Value::Object(bag));
    }

    /// Führt eine memory-Tool-Aktion aus (get/set/delete/list) und persistiert.
    pub fn memory_op(&self, peer_id: &str, action: &str, key: &str, value: &str) -> Value {
        let mut bag = self.load_agent_memory(peer_id);
        let action = action.to_lowercase();
        let key = key.trim();
        match action.as_str() {
            "list" => {
                let keys: Vec<String> = bag.keys().cloned().collect();
                json!({"ok": true, "keys": keys})
            }
            "get" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                json!({"ok": true, "key": key, "value": bag.get(key).cloned().unwrap_or(Value::Null)})
            }
            "set" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                let capped: String = value.chars().take(20000).collect();
                bag.insert(key.to_string(), json!(capped));
                self.store_agent_memory(peer_id, bag);
                json!({"ok": true, "key": key})
            }
            "delete" => {
                if key.is_empty() {
                    return json!({"ok": false, "error": "missing_key"});
                }
                bag.remove(key);
                self.store_agent_memory(peer_id, bag);
                json!({"ok": true, "key": key})
            }
            other => json!({"ok": false, "error": format!("unknown_action: {other}")}),
        }
    }

    /// Löscht den persistenten Agent-Kontext (memory-Tool) für einen KI-Chat.
    pub fn clear_agent_context(&self, peer_id: &str) -> Value {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_ai_chat"});
        }
        self.memory_cache.lock().remove(peer_id);
        self.kv_delete(&format!("aiChat.memory.{peer_id}"));
        json!({"ok": true})
    }

    // -- Agent-Konfiguration -------------------------------------------------------------

    /// Sucht den Agent-Eintrag (aiChat.agents) für eine Peer-ID.
    pub fn get_agent(&self, peer_id: &str) -> Option<Value> {
        let agents = self.kv_get("aiChat.agents", json!([]));
        agents.as_array().and_then(|list| {
            list.iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(peer_id))
                .cloned()
        })
    }

    pub fn bot_display_name(&self, peer_id: &str) -> String {
        self.get_agent(peer_id)
            .and_then(|agent| {
                agent
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|name| name.trim().to_string())
            })
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| catalog::BOT_DEFAULT_NAME.to_string())
    }

    /// Schreibt eine sichtbare Bot-Bubble in den eigenen KI-Chat.
    pub fn append_bot_chat_message(&self, peer_id: &str, content: &str) -> Value {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return json!({"ok": false, "error": "empty_content"});
        }
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_bot_chat"});
        }
        let message_id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = json!({
            "kind": "chat",
            "content": trimmed,
            "from": "peer",
            "sender": self.bot_display_name(peer_id),
            "messageId": message_id,
            "timestamp": timestamp,
            "via": "message_send",
        });
        self.emit_bot_appended(peer_id, message, message_id, timestamp)
    }

    pub fn append_user_chat_message(&self, peer_id: &str, content: &str) -> Value {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return json!({"ok": false, "error": "empty_content"});
        }
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_bot_chat"});
        }
        let message_id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let message = json!({
            "kind": "chat",
            "content": trimmed,
            "from": "self",
            "sender": "Du",
            "messageId": message_id,
            "timestamp": timestamp,
            "via": "ask_user",
        });
        self.emit_bot_appended(peer_id, message, message_id, timestamp)
    }

    pub fn append_bot_chat_file(
        &self,
        peer_id: &str,
        file_name: &str,
        file_size: u64,
        file_type: &str,
        file_data: &str,
        caption: &str,
    ) -> Value {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_bot_chat"});
        }
        let message_id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let content = if caption.is_empty() { file_name } else { caption };
        let message = json!({
            "kind": "file",
            "content": content,
            "fileName": file_name,
            "fileSize": file_size,
            "fileType": file_type,
            "fileData": file_data,
            "from": "peer",
            "sender": self.bot_display_name(peer_id),
            "messageId": message_id,
            "timestamp": timestamp,
            "via": "attach_file",
        });
        self.emit_bot_appended(peer_id, message, message_id, timestamp)
    }

    pub fn append_bot_chat_file_link(
        &self,
        peer_id: &str,
        file_name: &str,
        file_size: u64,
        file_path: &str,
        caption: &str,
    ) -> Value {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return json!({"ok": false, "error": "not_bot_chat"});
        }
        let message_id = Uuid::new_v4().to_string();
        let timestamp = chrono::Utc::now().timestamp_millis();
        let content = if caption.is_empty() { file_name } else { caption };
        let message = json!({
            "kind": "file-link",
            "content": content,
            "fileName": file_name,
            "fileSize": file_size,
            "filePath": file_path,
            "from": "peer",
            "sender": self.bot_display_name(peer_id),
            "messageId": message_id,
            "timestamp": timestamp,
            "via": "attach_file",
        });
        self.emit_bot_appended(peer_id, message, message_id, timestamp)
    }

    fn emit_bot_appended(&self, peer_id: &str, message: Value, message_id: String, timestamp: i64) -> Value {
        match self.database.append_message(peer_id, message.clone()) {
            Ok(meta) => {
                let payload = json!({
                    "peerId": peer_id,
                    "message": message,
                    "meta": meta,
                });
                let _ = self.app.emit_to("main", "bot:message", payload);
                json!({"ok": true, "messageId": message_id, "timestamp": timestamp})
            }
            Err(error) => json!({"ok": false, "error": error.to_string()}),
        }
    }

    pub fn work_log_enabled(&self, peer_id: &str) -> bool {
        self.get_agent(peer_id)
            .and_then(|agent| agent.get("workLogEnabled").and_then(Value::as_bool))
            .unwrap_or(false)
    }

    pub fn append_bot_worklog(&self, peer_id: &str, entry: Value) {
        if !catalog::is_ai_chat_peer_id(peer_id) {
            return;
        }
        let mut store = self.kv_get("aiChat.worklogs", json!({}));
        let list = store
            .as_object_mut()
            .and_then(|object| {
                let slot = object.entry(peer_id.to_string()).or_insert_with(|| json!([]));
                slot.as_array_mut()
            });
        let Some(list) = list else {
            return;
        };
        list.push(entry.clone());
        const MAX_LOGS: usize = 40;
        if list.len() > MAX_LOGS {
            let extra = list.len() - MAX_LOGS;
            list.drain(0..extra);
        }
        self.kv_set("aiChat.worklogs", store);
        let _ = self.app.emit_to(
            "main",
            "bot:worklog",
            json!({ "peerId": peer_id, "entry": entry }),
        );
    }

    pub fn try_begin_chat(&self, peer_id: &str) -> bool {
        let mut busy = self.busy_peers.lock();
        if busy.contains(peer_id) {
            return false;
        }
        busy.insert(peer_id.to_string());
        true
    }

    pub fn end_chat(&self, peer_id: &str) {
        self.busy_peers.lock().remove(peer_id);
    }

    pub fn is_chat_busy(&self, peer_id: &str) -> bool {
        self.busy_peers.lock().contains(peer_id)
    }

    pub fn emit_bot_typing(&self, peer_id: &str, request_id: &str, active: bool) {
        let _ = self.app.emit_to(
            "main",
            "bot:typing",
            json!({
                "peerId": peer_id,
                "requestId": request_id,
                "active": active,
            }),
        );
    }

    /// Anzeige-Label eines Kontakts (nickname > name > peerId).
    pub fn contact_label(&self, peer_id: &str) -> String {
        let contacts = self.kv_get("contacts", json!([]));
        if let Some(list) = contacts.as_array() {
            for contact in list {
                if contact.get("id").and_then(Value::as_str) == Some(peer_id) {
                    if let Some(nickname) = contact.get("nickname").and_then(Value::as_str)
                        && !nickname.is_empty()
                    {
                        return nickname.to_string();
                    }
                    if let Some(name) = contact.get("name").and_then(Value::as_str)
                        && !name.is_empty()
                    {
                        return name.to_string();
                    }
                }
            }
        }
        peer_id.to_string()
    }

    // -- Reset ---------------------------------------------------------------------------

    pub async fn reset_and_delete(&self) -> Value {
        self.cancel_abort(RUNTIME_DOWNLOAD_ABORT_KEY);
        self.cancel_abort(MODEL_PULL_ABORT_KEY);
        self.cancel_all();
        self.stop_server().await;

        // KI-Chat-Nachrichten löschen (alle Peers mit __ai_chat__-Prefix).
        if let Ok(meta) = self.database.get_message_meta() {
            for peer_id in meta.keys() {
                if catalog::is_ai_chat_peer_id(peer_id) {
                    let _ = self.database.delete_chat(peer_id);
                }
            }
        }

        self.kv_delete("aiChat.agents");
        self.kv_delete("aiChat.selectedModelTier");
        self.kv_delete("aiChat.setupComplete");
        self.kv_delete("aiChat.cloudAuth");
        self.kv_delete("aiChat.selectedCloudModelId");
        self.kv_delete("aiChat.memory");
        self.memory_cache.lock().clear();

        let _ = tokio::fs::remove_dir_all(&self.base_dir).await;
        let (models_dir, models_dir_source) = {
            let inner = self.inner.lock();
            (inner.models_dir.clone(), inner.models_dir_source.clone())
        };
        let can_delete_external = models_dir_source != paths::BLUETALK_OLLAMA_MODELS_ENV
            && paths::is_bluetalk_managed_models_dir(&models_dir);
        if !paths::is_same_or_inside_path(&models_dir, &self.base_dir) && can_delete_external {
            let _ = tokio::fs::remove_dir_all(&models_dir).await;
        }
        if !self.is_system_runtime() {
            let _ = self.prepare_models_dir().await;
        }
        let _ = tokio::fs::create_dir_all(&self.runtime_dir).await;

        let runtime_mode = self.runtime_mode();
        let empty = OllamaState::empty(&runtime_mode);
        {
            let mut inner = self.inner.lock();
            inner.state = empty;
        }
        let state = self.state();
        let _ = self.app.emit_to("main", "ollama:state", state.clone());
        json!({"ok": true, "state": state})
    }

    // -- Nachrichten-Zugriff für Chat-History / Tools --------------------------------------

    pub fn message_batch(&self, peer_id: &str, skip: usize, limit: usize) -> (Vec<Value>, usize, bool, usize) {
        match self.database.get_message_batch(
            peer_id,
            BatchOptions {
                skip,
                limit: Some(limit),
            },
        ) {
            Ok(batch) => (batch.messages, batch.total, batch.has_more, batch.remaining),
            Err(_) => (Vec::new(), 0, false, 0),
        }
    }
}
