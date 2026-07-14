//! Portierung von BlueTalk v1 `agent-tools.js`: Agent-Werkzeuge mit
//! Arbeitsverzeichnis-Sandbox, Shell-Ausführung, Web-Fetch (SSRF-geschützt),
//! Memory und BlueTalk-Integration.
//!
//! Abweichungen zu v1 (siehe Bericht):
//! - `bluetalk_command` / `list_bluetalk_plugins`: in v2 existiert keine
//!   Plugin-Main-Runtime → strukturiertes `{ok:false, error:'not_supported_in_v2'}`.
//! - `list_bluetalk_peers`: kein Live-Peer-Server im Rust-Backend → leere Liste
//!   mit Hinweis; `online` in Kontakt-Zusammenfassungen ist immer `false`.
//! - `spawn_subagent` wird im Agent-Loop (chat.rs) behandelt; hier liefert es
//!   `subagent_unavailable` (greift nur in Sub-Agenten — Rekursionsschutz).

use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use serde_json::{Map, Value, json};

use super::{
    catalog,
    manager::{CancelToken, OllamaManager},
    paths,
};

const OUTPUT_TRUNCATE_CHARS: usize = 20_000;
const RUN_COMMAND_OUTPUT_CAP: usize = 2 * 1024 * 1024;
const WEB_FETCH_MAX_BYTES: usize = 200 * 1024;

/// Kontext für die Tool-Ausführung (entspricht v1 `toolCtx`).
#[derive(Clone)]
pub struct ToolCtx {
    pub manager: Arc<OllamaManager>,
    pub peer_id: String,
    pub request_id: String,
    pub work_dir: PathBuf,
    pub allow_bluetalk: bool,
    pub tier_id: String,
    pub cancel: CancelToken,
    /// false in Sub-Agenten: ask_user liefert dann eine pending_user-Notiz.
    pub interactive_ask: bool,
}

// ---------------------------------------------------------------------------
// Pfad-Helfer / Sandbox
// ---------------------------------------------------------------------------

/// Standard-Arbeitsverzeichnis: Desktop des Nutzers, sonst Home.
pub fn default_work_dir() -> PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    let home = if home.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(home)
    };
    let desktop = home.join("Desktop");
    if desktop.is_dir() { desktop } else { home }
}

/// Löst einen (relativen) Pfad gegen das Arbeitsverzeichnis auf.
pub fn resolve_path(work_dir: &Path, raw: &str) -> PathBuf {
    let root = paths::absolute_lexical(work_dir);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return root;
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return paths::absolute_lexical(candidate);
    }
    paths::absolute_lexical(&root.join(candidate))
}

/// Sandbox-Prüfung: Ziel muss innerhalb des Arbeitsverzeichnisses liegen.
fn assert_inside_work_dir(work_dir: &Path, target: &Path) -> Result<(), Value> {
    if paths::is_same_or_inside_path(target, work_dir) {
        Ok(())
    } else {
        Err(json!({
            "ok": false,
            "error": format!("Pfad liegt außerhalb des Arbeitsverzeichnisses: {}", target.display()),
            "code": "outside_workdir",
        }))
    }
}

pub fn truncate_chars(value: &str, max: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max {
        return value.to_string();
    }
    let kept: String = value.chars().take(max).collect();
    format!("{kept}\n…[gekürzt, {} Zeichen entfernt]", char_count - max)
}

fn rel_of_work_dir(work_dir: &Path, absolute: &Path) -> String {
    let root = paths::absolute_lexical(work_dir);
    let abs = paths::absolute_lexical(absolute);
    match abs.strip_prefix(&root) {
        Ok(rel) if !rel.as_os_str().is_empty() => rel.to_string_lossy().to_string(),
        _ => abs.to_string_lossy().to_string(),
    }
}

// ---------------------------------------------------------------------------
// Glob-Matching (minimale Implementierung — *, ** und ?)
// ---------------------------------------------------------------------------

pub fn glob_to_regex(pattern: &str) -> Option<regex::Regex> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    let mut regex_str = String::new();
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1) == Some(&'*') {
                regex_str.push_str(".*");
                i += 2;
                if matches!(chars.get(i), Some('/') | Some('\\')) {
                    i += 1;
                }
                continue;
            }
            regex_str.push_str("[^/\\\\]*");
            i += 1;
            continue;
        }
        if c == '?' {
            regex_str.push_str("[^/\\\\]");
            i += 1;
            continue;
        }
        if ".+^$(){}|[]\\".contains(c) {
            regex_str.push('\\');
            regex_str.push(c);
        } else {
            regex_str.push(c);
        }
        i += 1;
    }
    regex::Regex::new(&format!("(?i)^{regex_str}$")).ok()
}

pub fn matches_glob(file_path: &str, pattern: &str) -> bool {
    match glob_to_regex(pattern) {
        Some(re) => re.is_match(&file_path.replace('\\', "/")),
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Argument-Helfer
// ---------------------------------------------------------------------------

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn arg_opt_usize(args: &Value, key: &str) -> Option<usize> {
    args.get(key).and_then(|v| {
        v.as_u64()
            .map(|n| n as usize)
            .or_else(|| v.as_f64().map(|f| f.max(0.0) as usize))
            .or_else(|| v.as_str().and_then(|s| s.trim().parse::<usize>().ok()))
    })
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

mod bluetalk;
mod fs;
mod interaction;
mod shell;
mod web;

use bluetalk::{
    ensure_bluetalk_access, tool_connect_bluetalk_peer, tool_get_bluetalk_contact,
    tool_get_bluetalk_self, tool_list_bluetalk_chats, tool_list_bluetalk_contacts,
    tool_list_bluetalk_peers, tool_read_bluetalk_messages, tool_send_bluetalk_message,
    tool_send_bluetalk_reply,
};
use fs::{
    tool_edit_file, tool_extract_file, tool_grep_files, tool_list_files, tool_read_file,
    tool_search_files, tool_write_file,
};
use interaction::tool_ask_user;
use shell::tool_run_command;
use web::tool_web_fetch;

// ---------------------------------------------------------------------------
// Tool-Ergebnis-Formatierung (für role:"tool"-Nachrichten)
// ---------------------------------------------------------------------------

/// Formatiert Tool-Ergebnisse eindeutig als System-Output — nicht als
/// Nutzer-Nachricht (v1 `formatToolResultMessageContent`).
pub fn format_tool_result_message_content(tool_name: &str, tool_result: &Value) -> String {
    let name = {
        let trimmed = tool_name.trim();
        if trimmed.is_empty() { "unknown" } else { trimmed }
    };

    if name == "ask_user"
        && let Some(object) = tool_result.as_object()
    {
        let mut lines = vec![
            "[SYSTEM-TOOL-ERGEBNIS — automatisch von BlueTalk ausgeführt, nicht vom Nutzer geschrieben]".to_string(),
            "Tool: ask_user".to_string(),
        ];
        if let Some(question) = object.get("question").and_then(Value::as_str) {
            lines.push(format!("Gestellte Frage: {question}"));
        }
        let answered = object.get("answered").and_then(Value::as_bool).unwrap_or(false);
        let answer = object.get("answer").and_then(Value::as_str).unwrap_or("");
        if answered && !answer.is_empty() {
            lines.push(format!("Nutzer-Antwort (via Rückfrage-Dialog): {answer}"));
        } else if let Some(note) = object.get("note").and_then(Value::as_str) {
            lines.push(format!("Status: {note}"));
        } else {
            lines.push("Nutzer hat nicht geantwortet oder die Frage wurde übersprungen.".to_string());
        }
        if let Some(error) = object.get("error").and_then(Value::as_str) {
            lines.push(format!("Fehler: {error}"));
        }
        return lines.join("\n");
    }

    let payload = match tool_result {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
    };
    let body: String = payload.chars().take(OUTPUT_TRUNCATE_CHARS).collect();
    format!(
        "[SYSTEM-TOOL-ERGEBNIS — automatisch von BlueTalk ausgeführt, nicht vom Nutzer geschrieben]\nTool: {name}\nErgebnis (JSON):\n{body}"
    )
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/// Führt einen einzelnen Tool-Aufruf aus (v1 `executeToolCall`).
///
/// `spawn_subagent` wird hier bewusst NICHT ausgeführt — der Haupt-Agent-Loop
/// (chat.rs) behandelt es; in Sub-Agenten greift so der Rekursionsschutz.
pub async fn execute_tool_call(name: &str, args: &Value, ctx: &ToolCtx) -> Value {
    let known: Vec<String> = catalog::agent_tool_names();
    if !known.iter().any(|n| n == name) {
        return json!({"ok": false, "error": format!("unknown_tool: {name}")});
    }
    match name {
        "list_files" => tool_list_files(args, ctx).await,
        "search_files" => tool_search_files(args, ctx).await,
        "read_file" => tool_read_file(args, ctx).await,
        "extract_file" => tool_extract_file(args, ctx).await,
        "grep_files" => tool_grep_files(args, ctx).await,
        "write_file" => tool_write_file(args, ctx).await,
        "edit_file" => tool_edit_file(args, ctx).await,
        "run_command" => tool_run_command(args, ctx).await,
        "web_fetch" => tool_web_fetch(args).await,
        "memory" => {
            let action = arg_str(args, "action");
            let key = arg_str(args, "key");
            let value = arg_str(args, "value");
            ctx.manager.memory_op(&ctx.peer_id, &action, &key, &value)
        }
        "ask_user" => tool_ask_user(args, ctx).await,
        "spawn_subagent" => json!({"ok": false, "error": "subagent_unavailable"}),
        "bluetalk_command" | "list_bluetalk_plugins" => {
            if let Err(error) = ensure_bluetalk_access(ctx) {
                return error;
            }
            json!({
                "ok": false,
                "error": "not_supported_in_v2",
                "hint": "Plugin-Befehle stehen in BlueTalk v2 noch nicht zur Verfügung.",
            })
        }
        "read_bluetalk_messages" => tool_read_bluetalk_messages(args, ctx).await,
        "send_bluetalk_message" => tool_send_bluetalk_message(args, ctx).await,
        "send_bluetalk_reply" => tool_send_bluetalk_reply(args, ctx).await,
        "list_bluetalk_contacts" => tool_list_bluetalk_contacts(args, ctx).await,
        "list_bluetalk_peers" => tool_list_bluetalk_peers(ctx).await,
        "list_bluetalk_chats" => tool_list_bluetalk_chats(args, ctx).await,
        "get_bluetalk_contact" => tool_get_bluetalk_contact(args, ctx).await,
        "get_bluetalk_self" => tool_get_bluetalk_self(ctx).await,
        "connect_bluetalk_peer" => tool_connect_bluetalk_peer(args, ctx).await,
        other => json!({"ok": false, "error": format!("unknown_tool: {other}")}),
    }
}
