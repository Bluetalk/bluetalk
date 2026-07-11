import React, { useEffect, useRef } from 'react';
import { Copy, Forward, Reply, Trash2, X } from 'lucide-react';
import { CHAT_ICON_STROKE, getMessageCopyText } from '../messageHelpers.jsx';

/**
 * Kontextmenü einer Nachricht (Antworten/Kopieren/Weiterleiten/Löschen).
 * Escape-/Outside-Click-Handling ist aus Chats.jsx mitgewandert.
 *
 * Props:
 * - menu: { message, x, y } | null
 * - onClose()
 * - selectedPeer, debugMode
 * - onReply(message): setzt Reply-Ziel (schließt das Menü selbst)
 * - copyToClipboard(text, successTitle)
 * - onForward(messages[]): öffnet den Weiterleiten-Dialog (schließt selbst)
 * - onDeleteMessage(peerId, messageId)
 */
export function MessageContextMenu({
  menu,
  onClose,
  selectedPeer,
  debugMode,
  onReply,
  copyToClipboard,
  onForward,
  onDeleteMessage,
}) {
  const messageContextMenuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    let onDown = null;
    const id = window.setTimeout(() => {
      onDown = (e) => {
        if (messageContextMenuRef.current?.contains(e.target)) return;
        onClose();
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={messageContextMenuRef}
      className="chat-list-context-menu msg-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => onReply(menu.message)}
      >
        <Reply size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Antworten
      </button>
      {getMessageCopyText(menu.message, debugMode) ? (
        <button
          type="button"
          className="chat-list-context-menu-item"
          role="menuitem"
          onClick={() => {
            void copyToClipboard(
              getMessageCopyText(menu.message, debugMode),
              'Nachricht kopiert'
            );
            onClose();
          }}
        >
          <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          Kopieren
        </button>
      ) : null}
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => onForward([menu.message])}
      >
        <Forward size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Weiterleiten
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item chat-list-context-menu-item--danger"
        role="menuitem"
        onClick={() => {
          if (!selectedPeer) return;
          void onDeleteMessage(selectedPeer.id, menu.message.messageId);
          onClose();
        }}
      >
        <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Löschen
      </button>
      <div className="chat-list-context-menu-sep" role="separator" />
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={onClose}
      >
        <X size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Aus
      </button>
    </div>
  );
}
