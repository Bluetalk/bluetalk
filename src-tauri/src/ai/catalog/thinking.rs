//! Thinking-Modi und Auflösung der `think`-Option je Modell/Stufe.

use super::*;

// ---------------------------------------------------------------------------
// Thinking-Modi
// ---------------------------------------------------------------------------

pub const AI_THINKING_DEFAULT_MODE_ID: &str = "auto";

pub fn is_valid_thinking_mode(mode: &str) -> bool {
    matches!(mode, "auto" | "on" | "off")
}

pub fn resolve_thinking_mode(raw: &str) -> &'static str {
    match raw.trim() {
        "on" => "on",
        "off" => "off",
        "auto" => "auto",
        _ => AI_THINKING_DEFAULT_MODE_ID,
    }
}

/// Liefert den think-Parameter für Ollama (true/false/"medium") abhängig vom
/// Thinking-Modus und der Modellstufe.
///   - off  -> false (nie thinking)
///   - on   -> true (immer thinking)
///   - auto -> true ab 'normal', false für 'fast'; gpt-oss -> "medium"
pub fn resolve_think_option(thinking_mode_id: &str, model: &str, tier_id: &str) -> Value {
    let mode = if is_valid_thinking_mode(thinking_mode_id) {
        thinking_mode_id
    } else {
        AI_THINKING_DEFAULT_MODE_ID
    };
    if mode == "off" {
        return json!(false);
    }
    let name = model.to_lowercase();
    if mode == "on" {
        if name.contains("gpt-oss") {
            return json!("medium");
        }
        return json!(true);
    }
    // auto
    if name.contains("gpt-oss") {
        return json!("medium");
    }
    if tier_id == "fast" {
        return json!(false);
    }
    json!(true)
}

