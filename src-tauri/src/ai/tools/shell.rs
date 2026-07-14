//! Shell-Tool `run_command` (v1 `agent-tools.js`).

use super::*;

pub(super) async fn tool_run_command(args: &Value, ctx: &ToolCtx) -> Value {
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

