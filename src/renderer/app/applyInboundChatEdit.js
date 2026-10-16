import { startTransition } from 'react';
import { applyInboundMessageEdit } from '../../shared/chat-features.js';
import { findMessageForReaction } from './messageReactions';

function editorOwnsOriginal(existing, fromId, isGroup) {
  if (!existing || !fromId) return false;
  if (existing.from === 'self') return false;
  if (isGroup) return existing.senderPeerId === fromId || existing.from === fromId;
  return existing.from === fromId;
}

function patchChatMetaLastMessage(setChatMeta, chatId, messageId, patch) {
  if (!setChatMeta) return;
  setChatMeta((prev) => {
    const meta = prev[chatId];
    if (!meta?.lastMessage || meta.lastMessage.messageId !== messageId) return prev;
    return {
      ...prev,
      [chatId]: { ...meta, lastMessage: { ...meta.lastMessage, ...patch } },
    };
  });
}

/**
 * Wendet ein `message-edit` auf den lokalen Verlauf an (Disk + State).
 * Unbekannte/ungültige Edits werden verworfen — es wird nichts angehängt.
 */
export async function applyInboundChatEdit({
  chatId,
  fromId,
  payload,
  isGroup = false,
  messageCacheRef,
  applyMessagePatch,
  setChatMeta,
  setMessages,
}) {
  const validated = applyInboundMessageEdit(null, payload, { editorIsOriginalSender: true });
  if (!validated.ok) return false;
  const cached = messageCacheRef?.current?.[chatId] || [];
  let existing = cached.find((item) => item.messageId === validated.refMessageId) || null;
  if (!existing) {
    existing = await findMessageForReaction(messageCacheRef, chatId, validated.refMessageId);
  }
  if (!existing) return false;
  const applied = applyInboundMessageEdit(existing, payload, {
    editorIsOriginalSender: editorOwnsOriginal(existing, fromId, isGroup),
  });
  if (!applied.ok) return false;
  if (applied.skipped || !applied.patch) return true;

  await applyMessagePatch(chatId, applied.refMessageId, applied.patch);
  patchChatMetaLastMessage(setChatMeta, chatId, applied.refMessageId, applied.patch);
  if (setMessages) {
    startTransition(() => {
      setMessages((prev) => {
        const current = prev[chatId] || [];
        const idx = current.findIndex((item) => item.messageId === applied.refMessageId);
        if (idx < 0) return prev;
        const next = [...current];
        next[idx] = { ...next[idx], ...applied.patch };
        if (messageCacheRef) {
          messageCacheRef.current = { ...messageCacheRef.current, [chatId]: next };
        }
        return { ...prev, [chatId]: next };
      });
    });
  }
  return true;
}
