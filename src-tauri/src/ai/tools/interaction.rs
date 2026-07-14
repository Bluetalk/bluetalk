//! Interaktive Rückfrage an den Nutzer (`ask_user`) und die
//! Berechtigungs-Abfrage.

use super::*;

pub fn is_affirmative_answer(text: &str) -> bool {
    let answer = text.trim().to_lowercase();
    if answer.is_empty() {
        return false;
    }
    ["ja", "yes", "y", "ok", "j", "klar", "gerne"]
        .iter()
        .any(|word| answer == *word || answer.starts_with(&format!("{word} ")))
}

pub(super) async fn tool_ask_user(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn ask_user_permission(ctx: &ToolCtx, question: &str) -> Value {
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

