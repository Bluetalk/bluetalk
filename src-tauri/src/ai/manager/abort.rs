//! Abbruch-Verwaltung für Chats und Downloads (register/remove/cancel).
//! Teil von `OllamaManager` (siehe `super`).

use super::*;

impl OllamaManager {
    // -- Abort-Verwaltung -------------------------------------------------------

    pub fn register_abort(&self, key: &str) -> CancelToken {
        let token = CancelToken::new();
        self.aborts.lock().insert(key.to_string(), token.clone());
        token
    }

    pub fn remove_abort(&self, key: &str) {
        self.aborts.lock().remove(key);
    }

    pub(super) fn cancel_abort(&self, key: &str) -> bool {
        if let Some(token) = self.aborts.lock().remove(key) {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub(super) fn cancel_all(&self) {
        let tokens: Vec<CancelToken> = self.aborts.lock().drain().map(|(_, token)| token).collect();
        for token in tokens {
            token.cancel();
        }
        self.ask_registry.lock().clear();
        self.agent_replies.lock().clear();
    }

    pub fn abort_chat(&self, request_id: &str) -> Value {
        if request_id.is_empty() {
            return json!({"ok": false, "error": "missing_request_id"});
        }
        let cancelled = self.cancel_abort(request_id);
        // Auch eine offene ask_user-Anfrage sofort abbrechen, damit der
        // Agent-Loop nicht an einem wartenden Dialog hängen bleibt.
        let ask = self.ask_registry.lock().remove(request_id).is_some();
        if !cancelled && !ask {
            return json!({"ok": false, "error": "not_found"});
        }
        json!({"ok": true})
    }
}
