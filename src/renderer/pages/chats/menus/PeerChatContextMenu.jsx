import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Bell,
  BellOff,
  CheckSquare,
  Copy,
  Lock,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { isContactNotificationMuted } from '../../../contactNotificationMute';
import {
  CHAT_ICON_STROKE,
  isContextMenuFlyoutTarget,
} from '../messageHelpers.jsx';
import {
  ContextMenuHoverSubmenu,
  NotificationMuteMenuItems,
} from '../agentBlocks.jsx';
import { useContextMenuPosition } from './useContextMenuPosition.js';

/**
 * Rechtsklick-Menü für die Profilkarte oben rechts (Peer-Chats).
 *
 * Props:
 * - menu: { x, y } | null
 * - peer, contact
 * - onClose()
 * - onStartSelection()
 * - actions: { resetE2eeSession, toast, applyNotificationMute,
 *   setContactBlocked, onOpenNickname, onTogglePinned, onCopyPeerId,
 *   onOpenDelete }
 */
export function PeerChatContextMenu({ menu, peer, contact, onClose, onStartSelection, actions }) {
  const { ref, style } = useContextMenuPosition(menu);

  useEffect(() => {
    if (!menu) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e) => {
      if (ref.current?.contains(e.target)) return;
      if (isContextMenuFlyoutTarget(e.target)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose, ref]);

  if (!menu || !peer) return null;

  return createPortal(
    <div
      ref={ref}
      className="chat-list-context-menu context-menu-pop"
      role="menu"
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <PeerChatActionItems
        peer={peer}
        contact={contact}
        onClose={onClose}
        onStartSelection={onStartSelection}
        actions={actions}
      />
    </div>,
    document.body
  );
}

export function PeerChatActionItems({ peer, contact, onClose, onStartSelection, actions }) {
  return (
    <>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          actions.resetE2eeSession(peer.id);
          actions.toast({
            variant: 'success',
            title: 'Verschlüsselung erneuert',
            message: 'Die E2EE-Sitzung wird neu ausgehandelt.',
          });
          onClose();
        }}
      >
        <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Verschlüsselung erneuern
      </button>
      {!contact?.blocked ? (
        <>
          <ContextMenuHoverSubmenu
            label="Mitteilungen"
            icon={isContactNotificationMuted(contact) ? BellOff : Bell}
          >
            <NotificationMuteMenuItems
              contact={contact}
              contactId={peer.id}
              applyNotificationMute={actions.applyNotificationMute}
              onDone={onClose}
            />
          </ContextMenuHoverSubmenu>
          <div className="chat-list-context-menu-sep" role="separator" />
        </>
      ) : null}
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          const next = !peer.contact?.blocked;
          actions.setContactBlocked(peer.id, next);
          actions.toast({
            variant: 'success',
            title: next ? 'Kontakt blockiert' : 'Kontakt entblockt',
            message: next
              ? 'Der Kontakt erscheint nicht mehr in der Liste und kann dir nicht schreiben.'
              : 'Du kannst wieder chatten — über Neu oder durch erneutes Verbinden.',
          });
          onClose();
        }}
      >
        <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        {peer.contact?.blocked ? 'Entblocken' : 'Blockieren'}
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          actions.onOpenNickname();
          onClose();
        }}
      >
        <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Spitzname…
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          actions.onTogglePinned();
          onClose();
        }}
      >
        {peer.pinned ? (
          <PinOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        ) : (
          <Pin size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        )}
        {peer.pinned ? 'Chat lösen' : 'Chat anheften'}
      </button>
      {onStartSelection ? (
        <button
          type="button"
          className="chat-list-context-menu-item"
          role="menuitem"
          onClick={() => {
            onClose();
            onStartSelection();
          }}
        >
          <CheckSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          Nachrichten auswählen
        </button>
      ) : null}
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          void actions.onCopyPeerId(peer.id);
          onClose();
        }}
      >
        <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Peer-ID kopieren
      </button>
      <div className="chat-list-context-menu-sep" role="separator" />
      <button
        type="button"
        className="chat-list-context-menu-item chat-list-context-menu-item--danger"
        role="menuitem"
        onClick={() => {
          actions.onOpenDelete(peer.id);
          onClose();
        }}
      >
        <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Chat löschen…
      </button>
    </>
  );
}
