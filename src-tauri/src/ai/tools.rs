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

// ---------------------------------------------------------------------------
// Datei-Tools
// ---------------------------------------------------------------------------

struct Extraction {
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
    pattern: String,
}

fn extract_text_from_file(text: &str, extraction: &Extraction) -> Value {
    let lines: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let total_lines = lines.len();

    if !extraction.pattern.trim().is_empty() {
        let re = match regex::Regex::new(&extraction.pattern) {
            Ok(re) => re,
            Err(error) => return json!({"ok": false, "error": format!("invalid_regex: {error}")}),
        };
        let mut matched: Vec<(usize, &str)> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if re.is_match(line) {
                matched.push((index + 1, line));
            }
        }
        let limit = extraction
            .max_lines
            .map(|m| m.clamp(1, matched.len().max(1)))
            .unwrap_or(matched.len());
        let slice: Vec<(usize, &str)> = matched.into_iter().take(limit).collect();
        let line_range = if slice.is_empty() {
            Value::Null
        } else {
            json!({"start_line": slice[0].0, "end_line": slice[slice.len() - 1].0})
        };
        let content = slice.iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
        return json!({
            "ok": true,
            "content": content,
            "total_lines": total_lines,
            "matched_lines": slice.len(),
            "line_range": line_range,
        });
    }

    let start = extraction.start_line.unwrap_or(1).max(1);
    let mut end = extraction.end_line.map(|e| e.min(total_lines)).unwrap_or(total_lines);
    if end < start {
        end = start;
    }
    if let Some(max) = extraction.max_lines {
        end = end.min(start + max.max(1) - 1);
    }
    let from = (start - 1).min(total_lines);
    let to = end.min(total_lines);
    let slice = &lines[from..to];
    json!({
        "ok": true,
        "content": slice.join("\n"),
        "total_lines": total_lines,
        "line_range": {"start_line": start, "end_line": start + slice.len().saturating_sub(1)},
    })
}

async fn read_file_content(target: &Path, extraction: &Extraction) -> Value {
    let bytes = match tokio::fs::read(target).await {
        Ok(bytes) => bytes,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };
    let text = String::from_utf8_lossy(&bytes).to_string();
    let has_extraction = extraction.start_line.is_some()
        || extraction.end_line.is_some()
        || extraction.max_lines.is_some()
        || !extraction.pattern.trim().is_empty();
    if !has_extraction {
        return json!({
            "ok": true,
            "path": target.to_string_lossy(),
            "content": truncate_chars(&text, OUTPUT_TRUNCATE_CHARS),
            "bytes": bytes.len(),
        });
    }
    let extracted = extract_text_from_file(&text, extraction);
    if extracted.get("ok").and_then(Value::as_bool) != Some(true) {
        return extracted;
    }
    let mut result = Map::new();
    result.insert("ok".into(), json!(true));
    result.insert("path".into(), json!(target.to_string_lossy()));
    result.insert(
        "content".into(),
        json!(truncate_chars(
            extracted.get("content").and_then(Value::as_str).unwrap_or(""),
            OUTPUT_TRUNCATE_CHARS
        )),
    );
    result.insert("bytes".into(), json!(bytes.len()));
    result.insert(
        "total_lines".into(),
        extracted.get("total_lines").cloned().unwrap_or(Value::Null),
    );
    result.insert(
        "line_range".into(),
        extracted.get("line_range").cloned().unwrap_or(Value::Null),
    );
    if let Some(matched) = extracted.get("matched_lines") {
        result.insert("matched_lines".into(), matched.clone());
    }
    Value::Object(result)
}

fn extraction_from_args(args: &Value, with_pattern: bool) -> Extraction {
    Extraction {
        start_line: arg_opt_usize(args, "start_line"),
        end_line: arg_opt_usize(args, "end_line"),
        max_lines: arg_opt_usize(args, "max_lines"),
        pattern: if with_pattern { arg_str(args, "pattern") } else { String::new() },
    }
}

async fn tool_read_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    read_file_content(&target, &extraction_from_args(args, false)).await
}

async fn tool_extract_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    read_file_content(&target, &extraction_from_args(args, true)).await
}

async fn tool_write_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    let content = arg_str(args, "content");
    if let Some(parent) = target.parent()
        && let Err(error) = tokio::fs::create_dir_all(parent).await
    {
        return json!({"ok": false, "error": error.to_string()});
    }
    match tokio::fs::write(&target, content.as_bytes()).await {
        Ok(()) => json!({"ok": true, "path": target.to_string_lossy(), "bytes": content.len()}),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

async fn tool_edit_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    let old_string = arg_str(args, "old_string");
    let new_string = arg_str(args, "new_string");
    let replace_all = arg_bool(args, "replace_all");
    if old_string.is_empty() {
        return json!({
            "ok": false,
            "error": "empty_old_string",
            "hint": "old_string darf nicht leer sein. Lies die Datei zuerst mit read_file, kopiere den exakten Textausschnitt (inkl. Einrückung), den du ersetzen willst, und übergebe ihn als old_string.",
        });
    }
    let original = match tokio::fs::read(&target).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).to_string(),
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };
    if !original.contains(&old_string) {
        return json!({
            "ok": false,
            "error": "old_string_not_found",
            "path": target.to_string_lossy(),
            "hint": "Der übergebene old_string stimmt nicht exakt mit dem Dateiinhalt überein (Einrückung, Zeilenumbrüche, Tippfehler?). Lies die Datei mit read_file neu und kopiere den exakten Ausschnitt.",
        });
    }
    let occurrences = original.matches(&old_string).count();
    if !replace_all && occurrences > 1 {
        return json!({
            "ok": false,
            "error": "old_string_not_unique",
            "path": target.to_string_lossy(),
            "hint": "old_string kommt mehrfach vor. Erweitere old_string um mehr Kontext (z. B. die umgebenden Zeilen), damit es eindeutig wird, oder setze replace_all=true.",
        });
    }
    let updated = if replace_all {
        original.replace(&old_string, &new_string)
    } else {
        original.replacen(&old_string, &new_string, 1)
    };
    match tokio::fs::write(&target, updated.as_bytes()).await {
        Ok(()) => json!({
            "ok": true,
            "path": target.to_string_lossy(),
            "replacements": if replace_all { occurrences } else { 1 },
        }),
        Err(error) => json!({"ok": false, "error": error.to_string()}),
    }
}

async fn tool_list_files(args: &Value, ctx: &ToolCtx) -> Value {
    let raw = arg_str(args, "path");
    let target = if raw.trim().is_empty() {
        ctx.work_dir.clone()
    } else {
        resolve_path(&ctx.work_dir, &raw)
    };
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    let mut read_dir = match tokio::fs::read_dir(&target).await {
        Ok(read_dir) => read_dir,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };
    let mut items: Vec<(String, bool)> = Vec::new();
    while let Ok(Some(entry)) = read_dir.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        items.push((name, is_dir));
    }
    items.sort_by(|a, b| match (a.1, b.1) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.0.to_lowercase().cmp(&b.0.to_lowercase()),
    });
    let entries: Vec<Value> = items
        .into_iter()
        .map(|(name, is_dir)| json!({"name": name, "type": if is_dir { "dir" } else { "file" }}))
        .collect();
    json!({"ok": true, "path": target.to_string_lossy(), "entries": entries})
}

async fn tool_search_files(args: &Value, ctx: &ToolCtx) -> Value {
    let raw = arg_str(args, "path");
    let root = if raw.trim().is_empty() {
        ctx.work_dir.clone()
    } else {
        resolve_path(&ctx.work_dir, &raw)
    };
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &root) {
        return error;
    }
    let pattern = {
        let p = arg_str(args, "pattern");
        if p.trim().is_empty() { "*".to_string() } else { p }
    };
    let work_dir = ctx.work_dir.clone();
    let root_clone = root.clone();
    let pattern_clone = pattern.clone();

    let matches = tokio::task::spawn_blocking(move || {
        let mut matches: Vec<String> = Vec::new();
        let mut visited: usize = 0;
        const MAX_FILES: usize = 2000;
        let walker = walkdir::WalkDir::new(&root_clone)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_dir() {
                    let name = entry.file_name().to_string_lossy();
                    return !name.starts_with('.') && name != "node_modules";
                }
                true
            });
        for entry in walker {
            if visited > MAX_FILES || matches.len() >= 500 {
                break;
            }
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            visited += 1;
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&root_clone)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| entry.path().to_string_lossy().to_string());
            if matches_glob(&rel, &pattern_clone) {
                matches.push(rel_of_work_dir(&work_dir, entry.path()));
            }
        }
        matches.sort();
        matches
    })
    .await
    .unwrap_or_default();

    json!({
        "ok": true,
        "root": root.to_string_lossy(),
        "pattern": pattern,
        "matches": matches,
    })
}

async fn tool_grep_files(args: &Value, ctx: &ToolCtx) -> Value {
    let raw = arg_str(args, "path");
    let root = if raw.trim().is_empty() {
        ctx.work_dir.clone()
    } else {
        resolve_path(&ctx.work_dir, &raw)
    };
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &root) {
        return error;
    }
    let pattern = arg_str(args, "pattern");
    let re = match regex::Regex::new(&pattern) {
        Ok(re) => re,
        Err(error) => return json!({"ok": false, "error": format!("invalid_regex: {error}")}),
    };
    let glob = arg_str(args, "glob");
    let glob_re = if glob.trim().is_empty() {
        None
    } else {
        glob_to_regex(&glob)
    };
    let work_dir = ctx.work_dir.clone();
    let root_clone = root.clone();

    let (results, truncated) = tokio::task::spawn_blocking(move || {
        let mut results: Vec<Value> = Vec::new();
        let mut truncated = false;
        let mut visited: usize = 0;
        const MAX_FILES: usize = 500;
        const MAX_MATCHES: usize = 100;
        let walker = walkdir::WalkDir::new(&root_clone)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                if entry.file_type().is_dir() {
                    let name = entry.file_name().to_string_lossy();
                    return !name.starts_with('.') && name != "node_modules";
                }
                true
            });
        'outer: for entry in walker {
            if visited > MAX_FILES {
                break;
            }
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 && entry.file_type().is_dir() {
                continue;
            }
            visited += 1;
            if !entry.file_type().is_file() {
                continue;
            }
            if let Some(glob_re) = &glob_re {
                let name = entry.file_name().to_string_lossy();
                if !glob_re.is_match(&name.replace('\\', "/")) {
                    continue;
                }
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let content = String::from_utf8_lossy(&bytes);
            for (index, line) in content.split('\n').enumerate() {
                let line = line.strip_suffix('\r').unwrap_or(line);
                if re.is_match(line) {
                    results.push(json!({
                        "path": rel_of_work_dir(&work_dir, entry.path()),
                        "line": index + 1,
                        "text": truncate_chars(line, 240),
                    }));
                    if results.len() >= MAX_MATCHES {
                        truncated = true;
                        break 'outer;
                    }
                    break; // nur erster Treffer pro Datei, um Ergebnis kompakt zu halten
                }
            }
        }
        (results, truncated)
    })
    .await
    .unwrap_or((Vec::new(), false));

    let mut out = Map::new();
    out.insert("ok".into(), json!(true));
    out.insert("root".into(), json!(root.to_string_lossy()));
    out.insert("pattern".into(), json!(pattern));
    out.insert("matches".into(), Value::Array(results));
    if truncated {
        out.insert("truncated".into(), json!(true));
    }
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

async fn tool_run_command(args: &Value, ctx: &ToolCtx) -> Value {
    let command_text = {
        let primary = arg_str(args, "command");
        if primary.trim().is_empty() {
            arg_str(args, "cmd")
        } else {
            primary
        }
    };
    if command_text.trim().is_empty() {
        return json!({"ok": false, "error": "empty_command", "exitCode": -1});
    }

    let mut work_dir = ctx.work_dir.clone();
    let cwd = arg_str(args, "cwd");
    if !cwd.trim().is_empty() {
        let resolved = resolve_path(&ctx.work_dir, &cwd);
        if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &resolved) {
            let message = error
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("invalid_cwd")
                .to_string();
            return json!({"ok": false, "error": message, "exitCode": -1, "code": "outside_workdir"});
        }
        work_dir = resolved;
    }

    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(60_000)
        .clamp(1000, 120_000);

    let mut command = if cfg!(windows) {
        let mut std_command = std::process::Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std_command.raw_arg("/C");
            std_command.raw_arg(&command_text);
            std_command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        #[cfg(not(windows))]
        {
            std_command.arg("/C").arg(&command_text);
        }
        tokio::process::Command::from(std_command)
    } else {
        let mut std_command = std::process::Command::new("sh");
        std_command.arg("-c").arg(&command_text);
        tokio::process::Command::from(std_command)
    };
    command.current_dir(&work_dir);
    command.stdin(std::process::Stdio::null());
    command.kill_on_drop(true);

    let output = tokio::select! {
        result = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output()) => result,
        _ = ctx.cancel.cancelled() => {
            return json!({"ok": false, "error": "chat_aborted", "exitCode": -1});
        }
    };

    match output {
        Ok(Ok(output)) => {
            let exit_code = output.status.code().unwrap_or(-1);
            let stdout_raw = String::from_utf8_lossy(&output.stdout);
            let stderr_raw = String::from_utf8_lossy(&output.stderr);
            let stdout = truncate_chars(
                &stdout_raw.chars().take(RUN_COMMAND_OUTPUT_CAP).collect::<String>(),
                OUTPUT_TRUNCATE_CHARS,
            );
            let stderr = truncate_chars(
                &stderr_raw.chars().take(RUN_COMMAND_OUTPUT_CAP).collect::<String>(),
                OUTPUT_TRUNCATE_CHARS,
            );
            let mut result = Map::new();
            result.insert("ok".into(), json!(output.status.success()));
            result.insert("exitCode".into(), json!(exit_code));
            result.insert("stdout".into(), json!(stdout));
            result.insert("stderr".into(), json!(stderr));
            if !output.status.success() {
                result.insert("error".into(), json!(format!("Befehl beendet mit Exit-Code {exit_code}")));
            }
            Value::Object(result)
        }
        Ok(Err(error)) => json!({"ok": false, "error": error.to_string(), "exitCode": -1}),
        Err(_) => json!({"ok": false, "error": "timeout", "exitCode": -1}),
    }
}

// ---------------------------------------------------------------------------
// web_fetch (SSRF-Blockliste wie v1)
// ---------------------------------------------------------------------------

fn is_blocked_fetch_hostname(hostname: &str) -> bool {
    let raw = hostname
        .trim()
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_string();
    if raw.is_empty() {
        return true;
    }
    if raw == "localhost" || raw.ends_with(".localhost") {
        return true;
    }

    if let Ok(ip) = raw.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                let octets = v4.octets();
                let (a, b) = (octets[0], octets[1]);
                return a == 0
                    || a == 10
                    || a == 127
                    || (a == 169 && b == 254)
                    || (a == 172 && (16..=31).contains(&b))
                    || (a == 192 && b == 168)
                    || (a == 100 && (64..=127).contains(&b))
                    || a >= 224;
            }
            IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return true;
                }
                let segments = v6.segments();
                // Link-local fe80::/10, ULA fc00::/7
                if (segments[0] & 0xffc0) == 0xfe80 || (segments[0] & 0xfe00) == 0xfc00 {
                    return true;
                }
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return is_blocked_fetch_hostname(&mapped.to_string());
                }
                return false;
            }
        }
    }

    false
}

async fn tool_web_fetch(args: &Value) -> Value {
    let mut target = arg_str(args, "url").trim().to_string();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };

    for _redirect in 0..=5 {
        let parsed = match url::Url::parse(&target) {
            Ok(parsed) => parsed,
            Err(_) => return json!({"ok": false, "error": "invalid_url"}),
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return json!({"ok": false, "error": "invalid_url"});
        }
        let host = parsed.host_str().unwrap_or("");
        if is_blocked_fetch_hostname(host) {
            return json!({"ok": false, "error": "blocked_private_url"});
        }

        let response = match client.get(parsed.as_str()).send().await {
            Ok(response) => response,
            Err(error) => {
                let message = if error.is_timeout() {
                    "timeout".to_string()
                } else {
                    error.to_string()
                };
                return json!({"ok": false, "error": message});
            }
        };
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if location.is_empty() {
                return json!({"ok": false, "error": format!("http_{}", status.as_u16())});
            }
            target = match url::Url::parse(&target).ok().and_then(|base| base.join(location).ok()) {
                Some(next) => next.to_string(),
                None => return json!({"ok": false, "error": "invalid_url"}),
            };
            continue;
        }
        if !status.is_success() {
            return json!({"ok": false, "error": format!("http_{}", status.as_u16())});
        }

        let mut response = response;
        let mut body: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > WEB_FETCH_MAX_BYTES {
                        let remaining = WEB_FETCH_MAX_BYTES.saturating_sub(body.len());
                        body.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
                        break;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => return json!({"ok": false, "error": error.to_string()}),
            }
        }
        let text = String::from_utf8_lossy(&body).to_string();
        return json!({
            "ok": true,
            "url": target,
            "statusCode": status.as_u16(),
            "content": truncate_chars(&text, 200_000),
        });
    }
    json!({"ok": false, "error": "too_many_redirects"})
}

// ---------------------------------------------------------------------------
// ask_user / Bestätigungs-Gate
// ---------------------------------------------------------------------------

pub fn is_affirmative_answer(text: &str) -> bool {
    let answer = text.trim().to_lowercase();
    if answer.is_empty() {
        return false;
    }
    ["ja", "yes", "y", "ok", "j", "klar", "gerne"]
        .iter()
        .any(|word| answer == *word || answer.starts_with(&format!("{word} ")))
}

async fn tool_ask_user(args: &Value, ctx: &ToolCtx) -> Value {
    let question = arg_str(args, "question").trim().to_string();
    if question.is_empty() {
        return json!({"ok": false, "error": "empty_question"});
    }
    if !ctx.interactive_ask {
        return json!({
            "ok": true,
            "pending_user": true,
            "answered": false,
            "question": question,
            "note": "Kein interaktiver Dialog verfügbar. Stelle die Frage im Text.",
        });
    }
    let result = ctx
        .manager
        .run_ask_user(&ctx.peer_id, &ctx.request_id, &question)
        .await;
    // v1-Zusatz: unbeantwortete Fragen mit Hinweis versehen.
    if result.get("answered").and_then(Value::as_bool) == Some(false)
        && result.get("note").is_none()
    {
        let mut object = result.as_object().cloned().unwrap_or_default();
        object.insert(
            "note".into(),
            json!("Der Nutzer hat die Frage übersprungen. Fahre ohne Antwort fort."),
        );
        return Value::Object(object);
    }
    result
}

async fn ask_user_permission(ctx: &ToolCtx, question: &str) -> Value {
    if !ctx.interactive_ask {
        return json!({"ok": false, "error": "permission_unavailable"});
    }
    let reply = ctx
        .manager
        .run_ask_user(&ctx.peer_id, &ctx.request_id, question)
        .await;
    let answer = reply.get("answer").and_then(Value::as_str).unwrap_or("");
    if !is_affirmative_answer(answer) {
        return json!({"ok": false, "error": "permission_denied", "answered": !answer.trim().is_empty()});
    }
    json!({"ok": true})
}

// ---------------------------------------------------------------------------
// BlueTalk-Tools
// ---------------------------------------------------------------------------

fn ensure_bluetalk_access(ctx: &ToolCtx) -> Result<(), Value> {
    if ctx.allow_bluetalk {
        Ok(())
    } else {
        Err(json!({
            "ok": false,
            "error": "messaging_not_enabled",
            "hint": "BlueTalk-Nutzung ist für diesen Agenten deaktiviert. Aktiviere die Option beim Erstellen des Agenten.",
        }))
    }
}

fn validate_messaging_peer_id(peer_id: &str) -> Result<String, Value> {
    let id = peer_id.trim().to_string();
    if id.is_empty() {
        return Err(json!({"ok": false, "error": "missing_peer_id"}));
    }
    if catalog::is_ai_chat_peer_id(&id) {
        return Err(json!({
            "ok": false,
            "error": "invalid_peer_id",
            "hint": "Nur echte BlueTalk-Kontakte — keine KI-Chat-Peer-IDs.",
        }));
    }
    Ok(id)
}

enum MessagingAction<'a> {
    Send { preview: &'a str },
    Reply { preview: &'a str },
    Read { limit: usize },
    Connect { address: &'a str },
}

async fn ensure_messaging_permission(ctx: &ToolCtx, peer_id: &str, action: MessagingAction<'_>) -> Value {
    if !ctx.allow_bluetalk {
        return json!({
            "ok": false,
            "error": "messaging_not_enabled",
            "hint": "BlueTalk-Nutzung ist für diesen Agenten deaktiviert. Aktiviere die Option beim Erstellen des Agenten.",
        });
    }
    let label = ctx.manager.contact_label(peer_id);
    let question = match action {
        MessagingAction::Send { preview } => {
            let preview: String = preview.chars().take(800).collect();
            format!("Der Agent möchte an „{label}“ folgende Nachricht senden:\n\n{preview}\n\nErlauben? (Antworte mit ja oder nein)")
        }
        MessagingAction::Reply { preview } => {
            let preview: String = preview.chars().take(800).collect();
            format!("Der Agent möchte an „{label}“ folgende Antwort senden (als Zitat-Antwort):\n\n{preview}\n\nErlauben? (Antworte mit ja oder nein)")
        }
        MessagingAction::Connect { address } => {
            let address: String = address.chars().take(240).collect();
            format!("Der Agent möchte eine Verbindung zu folgender Adresse aufbauen:\n\n{address}\n\nErlauben? (Antworte mit ja oder nein)")
        }
        MessagingAction::Read { limit } => {
            format!("Der Agent möchte bis zu {} Nachrichten von „{label}“ lesen.\n\nErlauben? (Antworte mit ja oder nein)", limit.max(1))
        }
    };
    ask_user_permission(ctx, &question).await
}

fn summarize_message_for_agent(message: &Value) -> Option<Value> {
    let object = message.as_object()?;
    Some(json!({
        "messageId": object.get("messageId").cloned().unwrap_or(Value::Null),
        "from": object.get("from").cloned().unwrap_or(Value::Null),
        "kind": object.get("kind").cloned().unwrap_or(Value::Null),
        "content": object.get("content").cloned().unwrap_or(Value::Null),
        "sender": object.get("sender").cloned().unwrap_or(Value::Null),
        "timestamp": object.get("timestamp").cloned().unwrap_or(Value::Null),
        "fileName": object.get("fileName").cloned().unwrap_or(Value::Null),
        "fileSize": object.get("fileSize").cloned().unwrap_or(Value::Null),
    }))
}

fn summarize_contact_for_agent(contact: &Value, chat_meta: &Value) -> Option<Value> {
    let id = contact.get("id").and_then(Value::as_str)?;
    if id.is_empty() || id == "self" {
        return None;
    }
    let name = contact.get("name").and_then(Value::as_str).unwrap_or("");
    let nickname = contact.get("nickname").and_then(Value::as_str).unwrap_or("");
    let display_name = if !nickname.is_empty() {
        nickname
    } else if !name.is_empty() {
        name
    } else {
        id
    };
    let meta = chat_meta.get(id);
    let last_message = meta
        .and_then(|m| m.get("lastMessage"))
        .filter(|m| !m.is_null())
        .and_then(summarize_message_for_agent)
        .unwrap_or(Value::Null);
    let message_count = meta
        .and_then(|m| m.get("count"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    Some(json!({
        "id": id,
        "name": if name.is_empty() { id } else { name },
        "nickname": nickname,
        "displayName": display_name,
        "address": contact.get("address").and_then(Value::as_str).unwrap_or(""),
        "pinned": contact.get("pinned").and_then(Value::as_bool).unwrap_or(false),
        "blocked": contact.get("blocked").and_then(Value::as_bool).unwrap_or(false),
        "blockedByPeer": contact.get("blockedByPeer").and_then(Value::as_bool).unwrap_or(false),
        "e2eeEnabled": contact.get("e2eeEnabled").and_then(Value::as_bool).unwrap_or(true),
        "online": false,
        "hasOutgoing": contact.get("hasOutgoing").and_then(Value::as_bool).unwrap_or(false),
        "pendingMessageRequest": contact.get("pendingMessageRequest").and_then(Value::as_bool).unwrap_or(false),
        "bio": contact.get("bio").and_then(Value::as_str).unwrap_or(""),
        "profilePicture": contact.get("profilePicture").map(|v| match v {
            Value::String(s) => !s.is_empty(),
            Value::Bool(b) => *b,
            Value::Null => false,
            _ => true,
        }).unwrap_or(false),
        "lastMessage": last_message,
        "messageCount": message_count,
    }))
}

fn chat_meta_json(manager: &OllamaManager) -> Value {
    match manager.database.get_message_meta() {
        Ok(meta) => serde_json::to_value(meta).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn last_message_timestamp(summary: &Value) -> i64 {
    summary
        .get("lastMessage")
        .and_then(|m| m.get("timestamp"))
        .and_then(Value::as_i64)
        .unwrap_or(0)
}

async fn tool_list_bluetalk_contacts(args: &Value, ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    let include_blocked = arg_bool(args, "include_blocked");
    let query = arg_str(args, "query").trim().to_lowercase();
    let contacts = ctx.manager.kv_get("contacts", json!([]));
    let chat_meta = chat_meta_json(&ctx.manager);

    let mut list: Vec<Value> = contacts
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .filter_map(|contact| summarize_contact_for_agent(contact, &chat_meta))
                .collect()
        })
        .unwrap_or_default();

    if !include_blocked {
        list.retain(|c| {
            c.get("blocked").and_then(Value::as_bool) != Some(true)
                && c.get("blockedByPeer").and_then(Value::as_bool) != Some(true)
        });
    }
    if !query.is_empty() {
        list.retain(|c| {
            let haystack = format!(
                "{} {} {} {} {}",
                c.get("displayName").and_then(Value::as_str).unwrap_or(""),
                c.get("name").and_then(Value::as_str).unwrap_or(""),
                c.get("nickname").and_then(Value::as_str).unwrap_or(""),
                c.get("id").and_then(Value::as_str).unwrap_or(""),
                c.get("address").and_then(Value::as_str).unwrap_or(""),
            )
            .to_lowercase();
            haystack.contains(&query)
        });
    }
    list.sort_by_key(|c| -last_message_timestamp(c));
    let total = list.len();
    json!({"ok": true, "contacts": list, "total": total})
}

async fn tool_list_bluetalk_chats(args: &Value, ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    let query = arg_str(args, "query").trim().to_lowercase();
    let limit = arg_opt_usize(args, "limit").unwrap_or(20).clamp(1, 50);
    let contacts = ctx.manager.kv_get("contacts", json!([]));
    let chat_meta = chat_meta_json(&ctx.manager);
    let empty = Vec::new();
    let contact_list = contacts.as_array().unwrap_or(&empty);

    let mut peer_ids: Vec<String> = Vec::new();
    for contact in contact_list {
        if let Some(id) = contact.get("id").and_then(Value::as_str)
            && !id.is_empty()
            && !peer_ids.iter().any(|existing| existing == id)
        {
            peer_ids.push(id.to_string());
        }
    }
    if let Some(meta_map) = chat_meta.as_object() {
        for key in meta_map.keys() {
            if !peer_ids.iter().any(|existing| existing == key) {
                peer_ids.push(key.clone());
            }
        }
    }
    peer_ids.retain(|id| id != "self" && !catalog::is_ai_chat_peer_id(id));

    let mut chats: Vec<Value> = Vec::new();
    for peer_id in peer_ids {
        let contact = contact_list
            .iter()
            .find(|c| c.get("id").and_then(Value::as_str) == Some(peer_id.as_str()))
            .cloned()
            .unwrap_or_else(|| json!({"id": peer_id.clone(), "name": peer_id.clone()}));
        let Some(summary) = summarize_contact_for_agent(&contact, &chat_meta) else {
            continue;
        };
        let message_count = summary.get("messageCount").and_then(Value::as_u64).unwrap_or(0);
        let has_outgoing = summary.get("hasOutgoing").and_then(Value::as_bool).unwrap_or(false);
        let blocked = summary.get("blocked").and_then(Value::as_bool).unwrap_or(false);
        if message_count == 0 && !has_outgoing && !blocked {
            continue;
        }
        chats.push(json!({
            "peerId": peer_id,
            "displayName": summary.get("displayName").cloned().unwrap_or(Value::Null),
            "online": false,
            "messageCount": message_count,
            "lastMessage": summary.get("lastMessage").cloned().unwrap_or(Value::Null),
            "pinned": summary.get("pinned").cloned().unwrap_or(json!(false)),
            "blocked": blocked,
        }));
    }
    if !query.is_empty() {
        chats.retain(|c| {
            let haystack = format!(
                "{} {}",
                c.get("displayName").and_then(Value::as_str).unwrap_or(""),
                c.get("peerId").and_then(Value::as_str).unwrap_or(""),
            )
            .to_lowercase();
            haystack.contains(&query)
        });
    }
    chats.sort_by_key(|c| -last_message_timestamp(c));
    let total = chats.len();
    chats.truncate(limit);
    json!({"ok": true, "chats": chats, "total": total})
}

async fn tool_get_bluetalk_contact(args: &Value, ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    let peer_id = match validate_messaging_peer_id(&arg_str(args, "peer_id")) {
        Ok(id) => id,
        Err(error) => return error,
    };
    let contacts = ctx.manager.kv_get("contacts", json!([]));
    let chat_meta = chat_meta_json(&ctx.manager);
    let contact = contacts
        .as_array()
        .and_then(|list| {
            list.iter()
                .find(|c| c.get("id").and_then(Value::as_str) == Some(peer_id.as_str()))
                .cloned()
        })
        .unwrap_or_else(|| json!({"id": peer_id.clone(), "name": peer_id.clone()}));
    match summarize_contact_for_agent(&contact, &chat_meta) {
        Some(summary) => json!({"ok": true, "contact": summary}),
        None => json!({"ok": false, "error": "not_found"}),
    }
}

async fn tool_get_bluetalk_self(ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    let settings = ctx.manager.kv_get("settings", json!({}));
    let peer_id = ctx.manager.kv_get_string("peerId", "");
    let display_name = settings
        .get("displayName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    json!({
        "ok": true,
        "peerId": peer_id,
        "displayName": display_name,
        "name": "",
        "port": 0,
        "ports": [],
        "endpoints": [],
        "addresses": [],
        "connectedPeerCount": 0,
        "note": "Live-Verbindungsdaten sind im v2-Backend nicht verfügbar.",
    })
}

async fn tool_list_bluetalk_peers(ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    json!({
        "ok": true,
        "peers": [],
        "total": 0,
        "note": "Live-Peer-Status ist im v2-Backend nicht verfügbar. Nutze list_bluetalk_contacts.",
    })
}

async fn tool_read_bluetalk_messages(args: &Value, ctx: &ToolCtx) -> Value {
    let peer_id = match validate_messaging_peer_id(&arg_str(args, "peer_id")) {
        Ok(id) => id,
        Err(error) => return error,
    };
    let limit = arg_opt_usize(args, "limit").unwrap_or(20).clamp(1, 100);
    let skip = arg_opt_usize(args, "skip").unwrap_or(0);
    let permission = ensure_messaging_permission(ctx, &peer_id, MessagingAction::Read { limit }).await;
    if permission.get("ok").and_then(Value::as_bool) != Some(true) {
        return permission;
    }
    let (messages, total, has_more, remaining) = ctx.manager.message_batch(&peer_id, skip, limit);
    let summaries: Vec<Value> = messages
        .iter()
        .filter_map(summarize_message_for_agent)
        .collect();
    json!({
        "ok": true,
        "peerId": peer_id,
        "messages": summaries,
        "total": total,
        "hasMore": has_more,
        "remaining": remaining,
    })
}

/// Baut das replyTo-Objekt aus einer gespeicherten Nachricht (v1
/// `buildReplyToFromStore`).
fn build_reply_to(ctx: &ToolCtx, peer_id: &str, message_id: &str) -> Option<Value> {
    let (messages, _, _, _) = ctx.manager.message_batch(peer_id, 0, 100);
    let message = messages
        .iter()
        .find(|m| m.get("messageId").and_then(Value::as_str) == Some(message_id))?;
    let settings = ctx.manager.kv_get("settings", json!({}));
    let kind = message.get("kind").and_then(Value::as_str).unwrap_or("");
    let preview = if kind == "file" {
        format!(
            "Datei: {}",
            message.get("fileName").and_then(Value::as_str).unwrap_or("Anhang")
        )
    } else if kind == "sticker" {
        "Sticker".to_string()
    } else {
        message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(240)
            .collect()
    };
    let sender = if message.get("from").and_then(Value::as_str) == Some("self") {
        settings
            .get("displayName")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Du")
            .to_string()
    } else {
        message
            .get("sender")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("Kontakt")
            .to_string()
    };
    Some(json!({
        "messageId": message_id,
        "sender": sender,
        "preview": preview,
        "timestamp": message.get("timestamp").cloned().unwrap_or(Value::Null),
    }))
}

async fn tool_send_bluetalk_message(args: &Value, ctx: &ToolCtx) -> Value {
    let peer_id = match validate_messaging_peer_id(&arg_str(args, "peer_id")) {
        Ok(id) => id,
        Err(error) => return error,
    };
    let content = arg_str(args, "content").trim().to_string();
    if content.is_empty() {
        return json!({"ok": false, "error": "empty_content"});
    }
    let permission =
        ensure_messaging_permission(ctx, &peer_id, MessagingAction::Send { preview: &content }).await;
    if permission.get("ok").and_then(Value::as_bool) != Some(true) {
        return permission;
    }
    ctx.manager
        .request_agent_send_message(&peer_id, &content, None)
        .await
}

async fn tool_send_bluetalk_reply(args: &Value, ctx: &ToolCtx) -> Value {
    let peer_id = match validate_messaging_peer_id(&arg_str(args, "peer_id")) {
        Ok(id) => id,
        Err(error) => return error,
    };
    let content = arg_str(args, "content").trim().to_string();
    if content.is_empty() {
        return json!({"ok": false, "error": "empty_content"});
    }
    let reply_id = arg_str(args, "reply_to_message_id").trim().to_string();
    if reply_id.is_empty() {
        return json!({"ok": false, "error": "missing_reply_to_message_id"});
    }
    let Some(reply_to) = build_reply_to(ctx, &peer_id, &reply_id) else {
        return json!({"ok": false, "error": "reply_message_not_found"});
    };
    let permission =
        ensure_messaging_permission(ctx, &peer_id, MessagingAction::Reply { preview: &content }).await;
    if permission.get("ok").and_then(Value::as_bool) != Some(true) {
        return permission;
    }
    ctx.manager
        .request_agent_send_message(&peer_id, &content, Some(reply_to))
        .await
}

async fn tool_connect_bluetalk_peer(args: &Value, ctx: &ToolCtx) -> Value {
    if let Err(error) = ensure_bluetalk_access(ctx) {
        return error;
    }
    let address = arg_str(args, "address").trim().to_string();
    if address.is_empty() {
        return json!({"ok": false, "error": "missing_address"});
    }
    let permission =
        ensure_messaging_permission(ctx, &address, MessagingAction::Connect { address: &address }).await;
    if permission.get("ok").and_then(Value::as_bool) != Some(true) {
        return permission;
    }
    ctx.manager.request_agent_connect_peer(&address).await
}

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
