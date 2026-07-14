//! Zusammenbau des finalen System-Prompts (Chat/Agent/Sub-Agent) aus
//! Basis, Stufen-Abschnitt, Persönlichkeit und Tool-Beschreibungen.

use super::*;

// ---------------------------------------------------------------------------
// System-Prompt-Aufbau
// ---------------------------------------------------------------------------

/// Baut den System-Prompt für eine Modell-Stufe. Im Agent-Modus wird
/// die Agent-Basis verwendet statt der Chat-Basis.
pub fn get_system_prompt_for_tier(tier_id: &str, agent_mode: bool, append_ornith_strict_rules: bool) -> String {
    let id = if is_valid_model_tier(tier_id) {
        tier_id
    } else {
        AI_CHAT_DEFAULT_TIER_ID
    };
    let section = chat_tier_prompt_section(id);
    if agent_mode {
        let agent_section = agent_tier_prompt_section(id);
        let tools_section = build_agent_tools_prompt_section(id);
        let mut prompt = format!(
            "{AI_AGENT_SYSTEM_PROMPT_BASE}\n\n{agent_section}\n\n{tools_section}\n\n{section}"
        );
        if id == "ornith" && append_ornith_strict_rules {
            prompt.push_str("\n\n");
            prompt.push_str(AI_ORNITH_STRICT_TOOL_PROMPT);
        }
        return prompt;
    }
    format!("{AI_CHAT_SYSTEM_PROMPT_BASE}\n\n{section}")
}

/// Konfiguration für den Agent-System-Prompt (Persönlichkeit + Arbeitsverzeichnis).
#[derive(Debug, Clone, Default)]
pub struct AgentPromptConfig {
    pub personality_id: String,
    pub personality_custom: String,
    pub agent_mode: bool,
    pub agent_work_dir: String,
}

/// Baut den System-Prompt inkl. Agent-Persönlichkeit (wie v1
/// `getSystemPromptForAgent`).
pub fn get_system_prompt_for_agent(tier_id: &str, config: &AgentPromptConfig) -> String {
    let personality_id = if is_valid_personality_id(&config.personality_id) {
        config.personality_id.as_str()
    } else {
        AI_PERSONALITY_DEFAULT_ID
    };
    let personality_custom: String = config
        .personality_custom
        .trim()
        .chars()
        .take(AI_PERSONALITY_CUSTOM_MAX_CHARS)
        .collect();

    let id = if is_valid_model_tier(tier_id) {
        tier_id
    } else {
        AI_CHAT_DEFAULT_TIER_ID
    };
    let mut prompt = get_system_prompt_for_tier(id, config.agent_mode, false);
    if config.agent_mode {
        let work_dir_text = if config.agent_work_dir.trim().is_empty() {
            "Standard-Arbeitsverzeichnis (wird vom System gesetzt)"
        } else {
            config.agent_work_dir.trim()
        };
        prompt.push_str("\n\n## Arbeitsverzeichnis\n");
        prompt.push_str(work_dir_text);
    }
    let preset = personality_prompt(personality_id);
    if !preset.is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(preset);
    }
    if !personality_custom.is_empty() {
        prompt.push_str("\n\n## Zusätzliche Persönlichkeits-Anweisungen\n");
        prompt.push_str(&personality_custom);
    }
    if config.agent_mode && id == "ornith" {
        // Sicherheits- und Toolregeln absichtlich ganz zuletzt platzieren, damit
        // weder Arbeitsverzeichnis noch Persönlichkeit sie abschwächen können.
        prompt.push_str("\n\n");
        prompt.push_str(AI_ORNITH_STRICT_TOOL_PROMPT);
    }
    prompt
}

/// System-Prompt für Sub-Agenten (wie v1 `spawn_subagent`).
pub fn subagent_system_prompt(tier_id: &str, work_dir: &str) -> String {
    let mut prompt = get_system_prompt_for_tier(tier_id, true, true);
    prompt.push_str("\n\n## Sub-Agenten-Auftrag\nDu wurdest als Sub-Agent gestartet. Du hast keinen Zugriff auf den Haupt-Chatverlauf. Löse NUR die folgende Aufgabe und gib ein klares Ergebnis zurück. Halte dich knapp.\n\n**Wichtig:** Du hast aktive Tools — rufe sie per Function Calling auf, simuliere keine Dateiinhalte oder Befehlsausgaben. Tool-Ergebnisse (role „tool\", mit [SYSTEM-TOOL-ERGEBNIS …]) kommen vom System — nicht vom Nutzer.\n\nArbeitsverzeichnis: ");
    prompt.push_str(work_dir);
    prompt
}

/// Standard-Tool-Satz für Sub-Agenten (sichere Read-/Schreib-Tools).
pub const SUBAGENT_DEFAULT_TOOLS: &[&str] = &[
    "list_files",
    "search_files",
    "read_file",
    "extract_file",
    "grep_files",
    "write_file",
    "edit_file",
    "run_command",
    "web_fetch",
    "memory",
];
