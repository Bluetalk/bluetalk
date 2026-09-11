//! Modell-Stufen (lokal/Cloud), deren Auflösung sowie Katalog-JSON.

use super::*;
use serde_json::{Map, Value, json};

// ---------------------------------------------------------------------------
// Modell-Stufen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct ModelTier {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub model: &'static str,
    pub estimated_size_bytes: u64,
    pub local: bool,
    pub supports_vision: bool,
    pub requires_auth: bool,
    pub beta: bool,
    pub debug_only: bool,
}

/// Modell-Stufen in Anzeige-Reihenfolge (wie v1 `AI_MODEL_TIERS`).
pub const AI_MODEL_TIERS: &[ModelTier] = &[
    ModelTier {
        id: "fast",
        label: "Schnell",
        description: "Kurze Antworten, geringer Speicherbedarf",
        model: "qwen3:0.6b",
        estimated_size_bytes: 548_405_248,
        local: true,
        supports_vision: false,
        requires_auth: false,
        beta: false,
        debug_only: false,
    },
    ModelTier {
        id: "normal",
        label: "Normal",
        description: "Ausgewogen zwischen Qualität und Geschwindigkeit",
        model: "qwen3:1.7b",
        estimated_size_bytes: 1_503_238_554,
        local: true,
        supports_vision: false,
        requires_auth: false,
        beta: false,
        debug_only: false,
    },
    ModelTier {
        id: "normal+",
        label: "Normal+",
        description: "Mehr Qualität als Normal, moderater Speicherbedarf",
        model: "qwen3:4b",
        estimated_size_bytes: 2_684_354_560,
        local: true,
        supports_vision: false,
        requires_auth: false,
        beta: false,
        debug_only: false,
    },
    ModelTier {
        id: "ornith",
        label: "Ornith",
        description: "Agentisches Programmieren zwischen Normal+ und Smart",
        model: "ornith:9b",
        estimated_size_bytes: 6_012_954_214,
        local: true,
        supports_vision: false,
        requires_auth: false,
        beta: true,
        debug_only: true,
    },
    ModelTier {
        id: "smart",
        label: "Smart",
        description: "Beste lokale Qualität, mehr RAM nötig",
        model: "gemma4:latest",
        estimated_size_bytes: 10_307_921_510,
        local: true,
        supports_vision: true,
        requires_auth: false,
        beta: false,
        debug_only: false,
    },
    ModelTier {
        id: "cloud",
        label: "Cloud",
        description: "Große Modelle über Ollama Cloud (Anmeldung erforderlich)",
        model: "gpt-oss:120b-cloud",
        estimated_size_bytes: 0,
        local: false,
        supports_vision: false,
        requires_auth: true,
        beta: false,
        debug_only: false,
    },
];

pub fn tier_ids() -> Vec<&'static str> {
    AI_MODEL_TIERS.iter().map(|tier| tier.id).collect()
}

pub fn get_model_tier(tier_id: &str) -> Option<&'static ModelTier> {
    AI_MODEL_TIERS.iter().find(|tier| tier.id == tier_id)
}

pub fn is_valid_model_tier(tier_id: &str) -> bool {
    get_model_tier(tier_id).is_some()
}

// ---------------------------------------------------------------------------
// Cloud-Modelle
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub struct CloudModel {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub model: &'static str,
    pub supports_vision: bool,
}

/// Auswählbare Ollama-Cloud-Modelle (kein lokaler Download).
pub const AI_CLOUD_MODELS: &[CloudModel] = &[
    CloudModel {
        id: "gpt-oss-120b",
        label: "GPT-OSS 120B",
        description: "Höchste Qualität für komplexe Fragen",
        model: "gpt-oss:120b-cloud",
        supports_vision: false,
    },
    CloudModel {
        id: "gpt-oss-20b",
        label: "GPT-OSS 20B",
        description: "Schnellere Cloud-Antworten",
        model: "gpt-oss:20b-cloud",
        supports_vision: false,
    },
    CloudModel {
        id: "deepseek-v3.1",
        label: "DeepSeek V3.1",
        description: "Starkes Reasoning und Analyse",
        model: "deepseek-v3.1:671b-cloud",
        supports_vision: false,
    },
    CloudModel {
        id: "qwen3-coder",
        label: "Qwen3 Coder",
        description: "Für Code und Entwicklung",
        model: "qwen3-coder:480b-cloud",
        supports_vision: false,
    },
];

pub fn get_cloud_model(cloud_model_id: &str) -> Option<&'static CloudModel> {
    AI_CLOUD_MODELS.iter().find(|m| m.id == cloud_model_id)
}

pub fn is_valid_cloud_model(cloud_model_id: &str) -> bool {
    get_cloud_model(cloud_model_id).is_some()
}

pub fn default_cloud_model_id() -> &'static str {
    AI_CLOUD_DEFAULT_MODEL_ID
}

pub fn resolve_cloud_model_id(cloud_model_id: &str) -> &'static str {
    match get_cloud_model(cloud_model_id) {
        Some(model) => model.id,
        None => AI_CLOUD_DEFAULT_MODEL_ID,
    }
}

/// Modell-Stufe und Cloud-ID eines Bots, mit Fallback auf den globalen State.
pub fn resolve_bot_model_selection(
    agent: Option<&Value>,
    fallback_tier: &str,
    fallback_cloud: &str,
) -> (String, String) {
    let agent_tier = agent
        .and_then(|entry| entry.get("modelTier"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let agent_cloud = agent
        .and_then(|entry| entry.get("cloudModelId"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let tier_id = if get_model_tier(agent_tier).is_some_and(|tier| !tier.local) {
        agent_tier.to_string()
    } else if get_model_tier(fallback_tier).is_some_and(|tier| !tier.local) {
        fallback_tier.to_string()
    } else {
        "cloud".to_string()
    };
    let cloud_id = if is_valid_cloud_model(agent_cloud) {
        agent_cloud.to_string()
    } else {
        resolve_cloud_model_id(fallback_cloud).to_string()
    };
    (tier_id, cloud_id)
}

#[derive(Debug, Clone)]
pub struct OpenAiCompat {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

pub fn normalize_openai_base_url(raw: &str) -> String {
    let mut url = raw.trim().trim_end_matches('/').to_string();
    if url.is_empty() {
        return String::new();
    }
    let lower = url.to_ascii_lowercase();
    if !lower.contains("/v1") {
        url.push_str("/v1");
    }
    url
}

fn openai_field<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    ""
}

fn openai_from_value(value: Option<&Value>) -> Option<OpenAiCompat> {
    let value = value?;
    let base_url = normalize_openai_base_url(openai_field(value, &["openaiBaseUrl", "baseUrl"]));
    let model = openai_field(value, &["openaiModel", "model"]).to_string();
    if base_url.is_empty() || model.is_empty() {
        return None;
    }
    Some(OpenAiCompat {
        api_key: openai_field(value, &["openaiApiKey", "apiKey"]).to_string(),
        base_url,
        model,
    })
}

/// Pro-Bot OpenAI-kompatible API, sonst die globale Vorgabe (`aiChat.openai`).
/// `modelSource: "cloud"` bleibt bei Ollama Cloud, auch wenn API-Felder gesetzt sind.
pub fn resolve_bot_openai(agent: Option<&Value>, global: &Value) -> Option<OpenAiCompat> {
    let source = agent
        .and_then(|value| value.get("modelSource"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if source == "cloud" {
        return None;
    }
    if let Some(own) = openai_from_value(agent) {
        return Some(own);
    }
    if source == "openai" {
        return openai_from_value(Some(global));
    }
    None
}

/// Effektiver Ollama-Modellname für Tier + Cloud-Auswahl.
pub fn resolve_active_model_name(selected_model_tier: &str, selected_cloud_model_id: &str) -> String {
    let Some(tier) = get_model_tier(selected_model_tier) else {
        return String::new();
    };
    if tier.id == "cloud" {
        let cloud_id = resolve_cloud_model_id(selected_cloud_model_id);
        if let Some(cloud) = get_cloud_model(cloud_id) {
            return cloud.model.to_string();
        }
        return tier.model.to_string();
    }
    tier.model.to_string()
}

pub fn model_supports_vision(selected_model_tier: &str, selected_cloud_model_id: &str) -> bool {
    let Some(tier) = get_model_tier(selected_model_tier) else {
        return false;
    };
    if tier.id == "cloud" {
        let cloud_id = resolve_cloud_model_id(selected_cloud_model_id);
        return get_cloud_model(cloud_id).map(|m| m.supports_vision).unwrap_or(false);
    }
    tier.supports_vision
}

/// Modell-Katalog als serde_json-Objekt (Map keyed by tier id — exakt die
/// Form, die v1 über `ollama:getModelCatalog` liefert).
pub fn model_catalog_json() -> Value {
    let mut map = Map::new();
    for tier in AI_MODEL_TIERS {
        let mut entry = Map::new();
        entry.insert("id".into(), json!(tier.id));
        entry.insert("label".into(), json!(tier.label));
        entry.insert("description".into(), json!(tier.description));
        entry.insert("model".into(), json!(tier.model));
        entry.insert("estimatedSizeBytes".into(), json!(tier.estimated_size_bytes));
        entry.insert("local".into(), json!(tier.local));
        entry.insert("supportsVision".into(), json!(tier.supports_vision));
        if tier.requires_auth {
            entry.insert("requiresAuth".into(), json!(true));
        }
        if tier.beta {
            entry.insert("beta".into(), json!(true));
        }
        if tier.debug_only {
            entry.insert("debugOnly".into(), json!(true));
        }
        map.insert(tier.id.to_string(), Value::Object(entry));
    }
    Value::Object(map)
}

/// Cloud-Modelle als serde_json-Objekt (Map keyed by id — wie v1
/// `AI_CLOUD_MODELS`). Aktuell nutzt die UI eine eigene Konstanten-Kopie;
/// die Funktion bleibt als API-Parität zu v1 erhalten.
#[allow(dead_code)]
pub fn cloud_models_json() -> Value {
    let mut map = Map::new();
    for model in AI_CLOUD_MODELS {
        map.insert(
            model.id.to_string(),
            json!({
                "id": model.id,
                "label": model.label,
                "description": model.description,
                "model": model.model,
                "supportsVision": model.supports_vision,
            }),
        );
    }
    Value::Object(map)
}

