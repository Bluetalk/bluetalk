import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * Scroll-Pinning der Nachrichtenliste: hält das Ende sichtbar, solange der
 * Nutzer nahe am unteren Rand ist. Die Refs werden per Props an MessageList
 * durchgereicht, damit die Effekte hier (auf Seiten-Ebene) exakt wie zuvor
 * laufen — auch wenn die Liste gerade nicht gemountet ist (No-op über null-Refs).
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatScroll({ selectedPeerId, newestTimestamp, aiChatProgress }) {
  const endRef = useRef(null);
  const chatMessagesRef = useRef(null);
  const keepChatPinnedRef = useRef(true);

  useEffect(() => {
    keepChatPinnedRef.current = true;
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [selectedPeerId]);

  const updateChatPinnedState = useCallback(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    keepChatPinnedRef.current = distanceFromBottom < 96;
  }, []);

  useLayoutEffect(() => {
    if (!keepChatPinnedRef.current) return;
    endRef.current?.scrollIntoView({ behavior: aiChatProgress?.content ? 'auto' : 'smooth' });
  }, [
    newestTimestamp,
    selectedPeerId,
    aiChatProgress?.segments?.length,
    aiChatProgress?.content ? Math.floor(String(aiChatProgress.content).length / 320) : 0,
  ]);

  return { chatMessagesRef, endRef, updateChatPinnedState };
}
