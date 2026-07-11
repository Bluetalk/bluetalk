// KI-Chat-Zweig von sendMessage(), 1:1 aus App.jsx ausgelagert.
// Wird von useMessaging aufgerufen; alle Abhängigkeiten kommen über `deps`.
import { startTransition } from 'react';
import { newChatMessageId } from './appHelpers';
import { normalizeAttachmentFileType } from '../utils/attachmentImage';
import { toolEventsFromSegments } from '../utils/agentSegments.js';

export function sendAiChatMessage(deps, peerId, payload) {
  const {
    displayName,
    activeAiChatRequestRef,
    setMessages,
    setChatMeta,
    applyMessagePatch,
    setAiChatPendingPeerId,
    setAiChatProgress,
  } = deps;

  const outgoing = typeof payload === 'string'
    ? { kind: 'chat', content: payload }
    : { ...payload };

  if (outgoing.kind !== 'chat' && outgoing.kind !== 'file') {
    return Promise.resolve(false);
  }

  const fileAttachment = outgoing.kind === 'file'
    ? {
        fileName: outgoing.fileName || outgoing.content,
        fileSize: outgoing.fileSize,
        fileType: outgoing.fileType,
        fileData: outgoing.fileData,
        localPreviewUrl: outgoing.localPreviewUrl,
      }
    : outgoing.fileAttachment;

  const text = outgoing.kind === 'chat' ? String(outgoing.content || '').trim() : '';
  const hasFile = Boolean(fileAttachment?.fileData);
  if (!text && !hasFile) {
    return Promise.resolve(false);
  }

  const normalizedFileAttachment = hasFile
    ? {
        ...fileAttachment,
        fileType: normalizeAttachmentFileType(
          fileAttachment.fileName,
          fileAttachment.fileType,
          fileAttachment.fileData
        ),
      }
    : null;

  const createdAt = Date.now();
  const messagesToPersist = [];

  if (hasFile) {
    // localPreviewUrl (blob:) bewusst nicht persistieren — nach einem
    // Neustart rendert das Bild aus fileData (wie im Direkt- und Gruppen-Pfad).
    messagesToPersist.push({
      kind: 'file',
      content: normalizedFileAttachment.fileName || 'Anhang',
      fileName: normalizedFileAttachment.fileName,
      fileSize: normalizedFileAttachment.fileSize,
      fileType: normalizedFileAttachment.fileType,
      fileData: normalizedFileAttachment.fileData,
      sender: displayName,
      messageId: newChatMessageId(),
      timestamp: createdAt,
      from: 'self',
      deliveryStatus: 'pending',
    });
  }

  let triggerMessageId = null;
  if (text) {
    triggerMessageId = newChatMessageId();
    const chatMsg = {
      kind: 'chat',
      content: text,
      sender: displayName,
      messageId: triggerMessageId,
      timestamp: createdAt + (hasFile ? 1 : 0),
      from: 'self',
      deliveryStatus: 'pending',
    };
    if (outgoing.replyTo) chatMsg.replyTo = outgoing.replyTo;
    messagesToPersist.push(chatMsg);
  } else if (hasFile) {
    triggerMessageId = messagesToPersist[0].messageId;
  }

  const prompt = text
    || `Analysiere die angehängte Datei „${normalizedFileAttachment?.fileName || 'Anhang'}".`;
  const attachments = hasFile ? [normalizedFileAttachment] : [];

  // Busy-Check VOR dem optimistischen UI-Update, sonst bleiben
  // Phantom-Nachrichten hängen, die nie persistiert werden.
  if (activeAiChatRequestRef.current) {
    return Promise.resolve({ ok: false, error: 'chat_busy' });
  }

  // Die Blob-Vorschau nur in der In-Memory-/UI-Kopie behalten.
  const messagesForUi = hasFile && normalizedFileAttachment.localPreviewUrl
    ? messagesToPersist.map((msg) => (msg.kind === 'file'
      ? { ...msg, localPreviewUrl: normalizedFileAttachment.localPreviewUrl }
      : msg))
    : messagesToPersist;

  startTransition(() => {
    setMessages((prev) => ({
      ...prev,
      [peerId]: [...(prev[peerId] || []), ...messagesForUi],
    }));
    setChatMeta((prev) => {
      const last = messagesForUi[messagesForUi.length - 1];
      return {
        ...prev,
        [peerId]: {
          count: (prev[peerId]?.count || 0) + messagesForUi.length,
          lastMessage: last,
        },
      };
    });
  });

  return (async () => {
    try {
      for (const msg of messagesToPersist) {
        const meta = await window.bluetalk.messages.append(peerId, msg);
        if (meta?.count) {
          setChatMeta((prev) => ({ ...prev, [peerId]: meta }));
        }
      }
      await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'delivered' });
      setMessages((prev) => {
        const list = prev[peerId] || [];
        return {
          ...prev,
          [peerId]: list.map((item) =>
            item?.messageId === triggerMessageId ? { ...item, deliveryStatus: 'delivered' } : item
          ),
        };
      });

      const requestId =
        typeof crypto?.randomUUID === 'function'
          ? crypto.randomUUID()
          : `ai-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      activeAiChatRequestRef.current = requestId;
      setAiChatPendingPeerId(peerId);
      setAiChatProgress({ peerId, requestId, thinking: '', content: '', toolEvents: [], tps: 0, genTimeMs: 0 });
      let result;
      let lastAiUpdate = { thinking: '', content: '', tps: 0, genTimeMs: 0, toolEvents: [], segments: [] };
      let progressRafId = null;
      const flushAiProgress = () => {
        progressRafId = null;
        setAiChatProgress({ peerId, requestId, ...lastAiUpdate });
      };
      const scheduleAiProgress = (update) => {
        const toolEvents = Array.isArray(update.segments)
          ? toolEventsFromSegments(update.segments)
          : (Array.isArray(update.toolResults) && update.toolResults?.length
            ? [...(lastAiUpdate.toolEvents || []), ...update.toolResults]
            : (lastAiUpdate.toolEvents || []));
        lastAiUpdate = {
          thinking: update.thinking || '',
          content: update.content || '',
          tps: typeof update.tps === 'number' ? update.tps : 0,
          genTimeMs: typeof update.genTimeMs === 'number' ? update.genTimeMs : 0,
          toolEvents,
          segments: Array.isArray(update.segments) ? update.segments : (lastAiUpdate.segments || []),
        };
        const hasRunningSubagent = Array.isArray(update.segments)
          && update.segments.some((s) => s.type === 'subagent' && s.status === 'running');
        const immediate = Boolean(update.done)
          || (Array.isArray(update.toolResults) && update.toolResults.length > 0)
          || hasRunningSubagent;
        if (immediate) {
          if (progressRafId != null) {
            cancelAnimationFrame(progressRafId);
            progressRafId = null;
          }
          flushAiProgress();
          return;
        }
        if (progressRafId == null) {
          progressRafId = requestAnimationFrame(flushAiProgress);
        }
      };
      try {
        result = await window.bluetalk.ollama.chat(
          { peerId, prompt, requestId, attachments },
          scheduleAiProgress
        );
      } finally {
        if (progressRafId != null) {
          cancelAnimationFrame(progressRafId);
          progressRafId = null;
        }
        if (activeAiChatRequestRef.current === requestId) {
          activeAiChatRequestRef.current = null;
        }
        setAiChatPendingPeerId((current) => (current === peerId ? null : current));
        setAiChatProgress((current) => (current?.requestId === requestId ? null : current));
      }
      if (result?.error === 'chat_aborted') {
        const thinking = String(lastAiUpdate.thinking || '').trim();
        const content = String(lastAiUpdate.content || '').trim();
        const assistantMessage = {
          kind: 'chat',
          content,
          thinking: thinking || undefined,
          toolEvents: lastAiUpdate.toolEvents?.length ? lastAiUpdate.toolEvents : undefined,
          segments: lastAiUpdate.segments?.length ? lastAiUpdate.segments : undefined,
          aiStats:
            lastAiUpdate.tps > 0 || lastAiUpdate.genTimeMs > 0
              ? { tps: lastAiUpdate.tps, genTimeMs: lastAiUpdate.genTimeMs }
              : undefined,
          aiStopped: true,
          sender: 'KI-Assistent',
          messageId: newChatMessageId(),
          timestamp: Date.now(),
          from: 'peer',
        };
        const replyMeta = await window.bluetalk.messages.append(peerId, assistantMessage);
        setMessages((prev) => ({
          ...prev,
          [peerId]: [...(prev[peerId] || []), assistantMessage],
        }));
        if (replyMeta?.count) {
          setChatMeta((prev) => ({ ...prev, [peerId]: replyMeta }));
        }
        return { ok: false, error: 'chat_aborted' };
      }
      // Akzeptiere Ergebnis, wenn entweder Text vorhanden ist ODER Segmente
      // (Thinking/Tools) — kleine Modelle beenden oft ohne finale Textantwort.
      const resultSegments = Array.isArray(result?.message?.segments) ? result.message.segments : null;
      const hasResultContent = Boolean(result?.ok)
        && (result?.message?.content?.trim() || (resultSegments && resultSegments.length));
      if (!hasResultContent) {
        await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'scheduled' });
        return { ok: false, error: result?.error || 'chat_failed' };
      }

      const assistantMessage = {
        kind: 'chat',
        content: result.message.content || '',
        thinking: result.message.thinking || undefined,
        toolEvents: result.message.toolEvents || undefined,
        segments: resultSegments || undefined,
        aiStats: result.message.stats || undefined,
        sender: result.message.sender || 'KI-Assistent',
        model: result.message.model || '',
        messageId: newChatMessageId(),
        timestamp: Date.now(),
        from: 'peer',
      };
      const replyMeta = await window.bluetalk.messages.append(peerId, assistantMessage);
      setMessages((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] || []), assistantMessage],
      }));
      if (replyMeta?.count) {
        setChatMeta((prev) => ({ ...prev, [peerId]: replyMeta }));
      }
      return { ok: true };
    } catch (error) {
      console.error('AI chat failed:', error);
      const message = error?.message || 'chat_failed';
      if (message !== 'chat_aborted') {
        await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'scheduled' });
      }
      return {
        ok: false,
        error: /No handler registered for 'ollama:chat'|ERR_HANDLER_NOT_REGISTERED/i.test(message)
          ? 'ollama_handler_missing'
          : message,
      };
    }
  })();
}
