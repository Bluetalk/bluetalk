//! Postfach-Warteschlange: Drain ohne Ack; In-Flight gegen Doppelzustellung.

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct MailItem {
    pub id: String,
    pub from: String,
    pub ts: i64,
    pub body: Value,
}

#[derive(Default)]
pub struct MailQueue {
    items: VecDeque<MailItem>,
    in_flight: HashMap<String, MailItem>,
}

impl MailQueue {
    pub fn push(&mut self, item: MailItem) {
        if self.in_flight.contains_key(&item.id) {
            return;
        }
        if self.items.iter().any(|existing| existing.id == item.id) {
            return;
        }
        self.items.push_back(item);
    }

    /// Liefert aus und merkt die IDs als unterwegs. Kein Relay-Ack.
    pub fn drain(&mut self) -> Vec<MailItem> {
        let drained: Vec<MailItem> = self.items.drain(..).collect();
        for item in &drained {
            self.in_flight.insert(item.id.clone(), item.clone());
        }
        drained
    }

    pub fn ack(&mut self, ids: &[String]) {
        for id in ids {
            self.items.retain(|item| item.id != *id);
            self.in_flight.remove(id);
        }
    }

    /// Neue Relay-Sitzung: Server stellt unbestätigte Mails erneut zu.
    pub fn clear_in_flight(&mut self) {
        self.in_flight.clear();
    }
}
