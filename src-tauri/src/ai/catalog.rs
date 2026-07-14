//! Portierung der relevanten Teile von BlueTalk v1
//! `src/shared/ai-chat-constants.js`: Modell-Stufen, Cloud-Modelle,
//! System-Prompts, Tool-Schemas und Auflösungs-Helfer.

use serde_json::{Map, Value, json};

/// Virtuelle Peer-ID für den lokalen KI-Chat (kein P2P-Kontakt).
pub const AI_CHAT_PEER_ID: &str = "__ai_chat__";
pub const AI_CHAT_PEER_PREFIX: &str = "__ai_chat__:";

/// Angezeigter Download-Hinweis für die Ollama-Laufzeit (~1,5 GB).
pub const OLLAMA_RUNTIME_DISCLAIMER_BYTES: u64 = 1_610_612_736;

pub const OLLAMA_DEFAULT_PORT: u16 = 32114;
pub const OLLAMA_SYSTEM_PORT: u16 = 11434;
pub const OLLAMA_RUNTIME_MODE_BLUETALK: &str = "bluetalk";
pub const OLLAMA_RUNTIME_MODE_SYSTEM: &str = "system";
pub const OLLAMA_DEFAULT_RUNTIME_MODE: &str = OLLAMA_RUNTIME_MODE_BLUETALK;

/// Fallback-Stufe für unbekannte Tier-IDs.
pub const AI_CHAT_DEFAULT_TIER_ID: &str = "normal";
pub const AI_CLOUD_DEFAULT_MODEL_ID: &str = "gpt-oss-120b";

pub fn is_ai_chat_peer_id(peer_id: &str) -> bool {
    peer_id == AI_CHAT_PEER_ID || peer_id.starts_with(AI_CHAT_PEER_PREFIX)
}

/// API-Parität zu v1 `isValidOllamaRuntimeMode` (aktuell ohne Aufrufer).
#[allow(dead_code)]
pub fn is_valid_runtime_mode(mode: &str) -> bool {
    mode == OLLAMA_RUNTIME_MODE_BLUETALK || mode == OLLAMA_RUNTIME_MODE_SYSTEM
}

pub fn resolve_runtime_mode(mode: &str) -> &'static str {
    if mode == OLLAMA_RUNTIME_MODE_SYSTEM {
        OLLAMA_RUNTIME_MODE_SYSTEM
    } else {
        OLLAMA_RUNTIME_MODE_BLUETALK
    }
}

mod models;
mod prompts;
mod system_prompt;
mod thinking;
mod tool_defs;

pub use models::*;
pub use prompts::*;
pub use system_prompt::*;
pub use thinking::*;
pub use tool_defs::*;
