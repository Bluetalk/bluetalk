// KI-Chat-Steuerung (Abbrechen, Kontext löschen, Pending-Status) und
// Agent-IPC-Bridges (agent:send-message / agent:connect-peer),
// 1:1 aus App.jsx ausgelagert.
import { useEffect, useCallback } from 'react';
import { isAiChatPeerId } from '../../aiChatConstants';

export function useAiChat({
  aiChatProgress,
  aiChatPendingPeerId,
  setAiChatProgress,
  setAiChatPendingPeerId,
  setMessages,
  setChatMeta,
  setLoadedChats,
  messageCacheRef,
  activeAiChatRequestRef,
  sendMessageRef,
  connectToAddress,
}) {
  const cancelAiChat = useCallback(async () => {
    const requestId = activeAiChatRequestRef.current || aiChatProgress?.requestId;
    if (!requestId || !window.bluetalk?.ollama?.abortChat) return false;
    try {
      const result = await window.bluetalk.ollama.abortChat(requestId);
      return result?.ok === true;
    } catch {
      return false;
    }
  }, [aiChatProgress?.requestId]);

  const clearAiChatContext = useCallback(async (peerId) => {
    if (!window.bluetalk || !peerId || !isAiChatPeerId(peerId)) return false;

    if (aiChatPendingPeerId === peerId) {
      await cancelAiChat();
    }

    await window.bluetalk.messages.deleteChat(peerId);
    if (window.bluetalk.ollama?.clearAgentContext) {
      await window.bluetalk.ollama.clearAgentContext(peerId);
    }

    setMessages((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      messageCacheRef.current = updated;
      return updated;
    });
    setChatMeta((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setLoadedChats((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setAiChatProgress((current) => (current?.peerId === peerId ? null : current));
    setAiChatPendingPeerId((current) => (current === peerId ? null : current));

    return true;
  }, [aiChatPendingPeerId, cancelAiChat]);

  const isAiChatPending = useCallback(
    (peerId) => Boolean(peerId && aiChatPendingPeerId === peerId),
    [aiChatPendingPeerId]
  );

  useEffect(() => {
    if (!window.bluetalk?.on || !window.bluetalk?.agent?.sendMessageReply) return undefined;
    const unsubSend = window.bluetalk.on('agent:send-message', async (payload) => {
      const { requestId, peerId, content, replyTo } = payload || {};
      let result = { ok: false, error: 'invalid_request' };
      try {
        const outgoing = { kind: 'chat', content: String(content || '') };
        if (replyTo && typeof replyTo === 'object') {
          outgoing.replyTo = replyTo;
        }
        const sent = await sendMessageRef.current?.(peerId, outgoing);
        if (sent && typeof sent === 'object') {
          result = sent.ok === false ? sent : { ok: true, ...sent };
        } else {
          result = { ok: sent === true };
        }
      } catch (e) {
        result = { ok: false, error: e?.message || 'send_failed' };
      }
      window.bluetalk.agent.sendMessageReply({ requestId, result });
    });
    const unsubConnect = window.bluetalk?.agent?.connectPeerReply
      ? window.bluetalk.on('agent:connect-peer', async (payload) => {
        const { requestId, address } = payload || {};
        let result = { ok: false, error: 'invalid_request' };
        try {
          const peerInfo = await connectToAddress(address);
          result = {
            ok: true,
            peer: {
              id: peerInfo?.id,
              name: peerInfo?.name || peerInfo?.id,
              address: String(address || '').trim(),
            },
          };
        } catch (e) {
          result = { ok: false, error: e?.message || 'connect_failed' };
        }
        window.bluetalk.agent.connectPeerReply({ requestId, result });
      })
      : () => {};
    return () => {
      unsubSend?.();
      unsubConnect?.();
    };
  }, [connectToAddress]);

  return { cancelAiChat, clearAiChatContext, isAiChatPending };
}
