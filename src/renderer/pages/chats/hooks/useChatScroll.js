import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Scroll-Pinning der Nachrichtenliste: hält das Ende sichtbar, solange der
 * Nutzer nahe am unteren Rand ist. Die Refs werden per Props an MessageList
 * durchgereicht, damit die Effekte hier (auf Seiten-Ebene) exakt wie zuvor
 * laufen — auch wenn die Liste gerade nicht gemountet ist (No-op über null-Refs).
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatScroll({ selectedPeerId, newestTimestamp, aiChatProgress, typingActive = false }) {
  const endRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const keepChatPinnedRef = useRef(true);
  const lastNewestRef = useRef(0);
  const selectedPeerRef = useRef(selectedPeerId);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [unseenCount, setUnseenCount] = useState(0);

  if (selectedPeerRef.current !== selectedPeerId) {
    selectedPeerRef.current = selectedPeerId;
    lastNewestRef.current = newestTimestamp || 0;
  }

  useEffect(() => {
    keepChatPinnedRef.current = true;
    lastNewestRef.current = newestTimestamp || 0;
    setStuckToBottom(true);
    setUnseenCount(0);
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [selectedPeerId]);

  const updateChatPinnedState = useCallback(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < 96;
    keepChatPinnedRef.current = atBottom;
    setStuckToBottom(atBottom);
    if (atBottom) setUnseenCount(0);
  }, []);

  const jumpToLatest = useCallback(() => {
    keepChatPinnedRef.current = true;
    setStuckToBottom(true);
    setUnseenCount(0);
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useLayoutEffect(() => {
    const prevNewest = lastNewestRef.current;
    lastNewestRef.current = newestTimestamp || 0;
    if (!keepChatPinnedRef.current) {
      if (newestTimestamp && newestTimestamp > prevNewest) {
        setUnseenCount((count) => count + 1);
      }
      return;
    }
    endRef.current?.scrollIntoView({ behavior: aiChatProgress?.content ? 'auto' : 'smooth' });
  }, [
    newestTimestamp,
    selectedPeerId,
    typingActive,
    aiChatProgress?.segments?.length,
    aiChatProgress?.content ? Math.floor(String(aiChatProgress.content).length / 320) : 0,
  ]);

  return {
    chatMessagesRef,
    endRef,
    updateChatPinnedState,
    stuckToBottom,
    unseenCount,
    jumpToLatest,
  };
}
