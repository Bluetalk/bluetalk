//! Modell-Stufen (lokal/Cloud), deren Auflösung sowie Katalog-JSON.

use super::*;

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

