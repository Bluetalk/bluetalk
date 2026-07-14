//! Datei-Tools: Lesen, Extrahieren, Schreiben, Editieren, Auflisten,
//! Suchen und Grep — jeweils mit Arbeitsverzeichnis-Sandbox.

use super::*;

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

pub(super) async fn tool_read_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    read_file_content(&target, &extraction_from_args(args, false)).await
}

pub(super) async fn tool_extract_file(args: &Value, ctx: &ToolCtx) -> Value {
    let target = resolve_path(&ctx.work_dir, &arg_str(args, "path"));
    if let Err(error) = assert_inside_work_dir(&ctx.work_dir, &target) {
        return error;
    }
    read_file_content(&target, &extraction_from_args(args, true)).await
}

pub(super) async fn tool_write_file(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_edit_file(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_list_files(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_search_files(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_grep_files(args: &Value, ctx: &ToolCtx) -> Value {
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

