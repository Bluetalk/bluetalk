import { useEffect, useRef, useState } from 'react';
import { CHAT_BATCH_SIZE } from '../messageHelpers.jsx';
import { isAiChatPeerId } from '../../../aiChatConstants';

/**
 * Nachrichten-Lebenszyklus des aktiven Chats: initiales Laden, Nachladen
 * älterer Nachrichten, "gesehen"-Markierung und Lesebestätigungen.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatMessagesLoader({
  selectedPeerId,
  selectedPeer,
  msgs,
  messages,
  chatMeta,
  loadedChats,
  loadChatMessages,
  markPeerChatViewed,
  sendReadReceipt,
  sendReadReceiptsEnabled,
  toast,
}) {
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const lastReadSentRef = useRef({});

  useEffect(() => {
    let cancelled = false;

    async function ensureMessages() {
      if (!selectedPeerId) return;
      if (loadedChats[selectedPeerId]) return;
      if (!(chatMeta[selectedPeerId]?.count > 0)) return;

      setLoadingMessages(true);
      try {
        await loadChatMessages(selectedPeerId, { reset: true, limit: CHAT_BATCH_SIZE });
      } catch (e) {
        if (!cancelled) {
          toast({
            variant: 'error',
            title: 'Could not load messages',
            message: e?.message || 'Check storage permissions or try again.',
          });
        }
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    }

    ensureMessages();
    return () => {
      cancelled = true;
    };
  }, [chatMeta, loadChatMessages, loadedChats, selectedPeerId, toast]);

  useEffect(() => {
    if (!selectedPeerId || isAiChatPeerId(selectedPeerId)) return;
    const peerMsgs = messages[selectedPeerId] || [];
    const upTo = peerMsgs.reduce((acc, m) => {
      if (m.from !== 'self' && typeof m.timestamp === 'number') return Math.max(acc, m.timestamp);
      return acc;
    }, 0);
    if (upTo > 0) markPeerChatViewed(selectedPeerId, upTo);
  }, [selectedPeerId, messages, markPeerChatViewed]);

  useEffect(() => {
    if (!selectedPeerId || isAiChatPeerId(selectedPeerId) || !sendReadReceiptsEnabled) return;
    const peerMsgs = msgs.filter((m) => m.from !== 'self');
    const last = peerMsgs[peerMsgs.length - 1];
    if (!last?.messageId) return;
    if (lastReadSentRef.current[selectedPeerId] === last.messageId) return;
    lastReadSentRef.current[selectedPeerId] = last.messageId;
    void sendReadReceipt(selectedPeerId, last.messageId);
  }, [selectedPeerId, msgs, sendReadReceiptsEnabled, sendReadReceipt]);

  const loadOlderMessages = async () => {
    if (!selectedPeer) return;
    setLoadingMore(true);
    try {
      await loadChatMessages(selectedPeer.id, { limit: CHAT_BATCH_SIZE });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Could not load older messages',
        message: e?.message || 'Try again in a moment.',
      });
    } finally {
      setLoadingMore(false);
    }
  };

  return { loadingMessages, loadingMore, loadOlderMessages };
}
