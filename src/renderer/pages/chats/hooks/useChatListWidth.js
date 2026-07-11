import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_LIST_WIDTH_DEFAULT,
  CHAT_LIST_WIDTH_MIN,
  CHAT_LIST_WIDTH_MAX,
} from '../messageHelpers.jsx';

/**
 * Breite/Collapse der Chatliste inkl. Persistenz über updateSettings.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatListWidth(settings, updateSettings) {
  const chatListCollapsed = settings.uiCollapse?.chatList === true;
  const storedChatList = settings.uiResize?.chatList;
  const chatListCommitted =
    typeof storedChatList === 'number'
      ? Math.min(CHAT_LIST_WIDTH_MAX, Math.max(CHAT_LIST_WIDTH_MIN, storedChatList))
      : CHAT_LIST_WIDTH_DEFAULT;
  const [chatListPreview, setChatListPreview] = useState(null);
  const chatListDragRef = useRef(chatListCommitted);
  useEffect(() => {
    chatListDragRef.current = chatListCommitted;
  }, [chatListCommitted]);

  const chatListWidthPx = chatListPreview ?? chatListCommitted;

  const onChatListResizeBegin = useCallback(() => {
    chatListDragRef.current = chatListPreview ?? chatListCommitted;
  }, [chatListPreview, chatListCommitted]);

  const onChatListResizeDelta = useCallback((dx) => {
    chatListDragRef.current = Math.min(
      CHAT_LIST_WIDTH_MAX,
      Math.max(CHAT_LIST_WIDTH_MIN, chatListDragRef.current + dx)
    );
    setChatListPreview(chatListDragRef.current);
  }, []);

  const commitChatListWidth = useCallback(() => {
    const w = chatListDragRef.current;
    if (w !== chatListCommitted) {
      updateSettings({ uiResize: { chatList: w } });
    }
    setChatListPreview(null);
  }, [chatListCommitted, updateSettings]);

  const resetChatListWidth = useCallback(() => {
    setChatListPreview(null);
    updateSettings({ uiResize: { chatList: CHAT_LIST_WIDTH_DEFAULT } });
  }, [updateSettings]);

  const toggleChatListCollapse = useCallback(() => {
    updateSettings({ uiCollapse: { chatList: !chatListCollapsed } });
  }, [chatListCollapsed, updateSettings]);

  return {
    chatListCollapsed,
    chatListWidthPx,
    onChatListResizeBegin,
    onChatListResizeDelta,
    commitChatListWidth,
    resetChatListWidth,
    toggleChatListCollapse,
  };
}
