//! BlueTalk-Integration: Kontakte, Chats, Nachrichten lesen/senden,
//! Peer-Verbindung — inkl. Messaging-Berechtigungsprüfung.

use super::*;
use super::interaction::ask_user_permission;

pub(super) fn ensure_bluetalk_access(ctx: &ToolCtx) -> Result<(), Value> {
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

pub(super) async fn tool_list_bluetalk_contacts(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_list_bluetalk_chats(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_get_bluetalk_contact(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_get_bluetalk_self(ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_list_bluetalk_peers(ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_read_bluetalk_messages(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_send_bluetalk_message(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_send_bluetalk_reply(args: &Value, ctx: &ToolCtx) -> Value {
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

pub(super) async fn tool_connect_bluetalk_peer(args: &Value, ctx: &ToolCtx) -> Value {
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
