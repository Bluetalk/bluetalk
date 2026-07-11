import React, { useEffect, useRef } from 'react';
import {
  Ban,
  Bell,
  BellOff,
  Copy,
  Eraser,
  Lock,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Unlock,
  Users,
} from 'lucide-react';
import { isContactNotificationMuted } from '../../../contactNotificationMute';
import {
  CHAT_ICON_STROKE,
  contactE2eePreferenceOn,
  isContextMenuFlyoutTarget,
} from '../messageHelpers.jsx';
import {
  ContextMenuHoverSubmenu,
  NotificationMuteMenuItems,
} from '../agentBlocks.jsx';

/**
 * Kontextmenü einer Chatlisten-Zeile (KI-, Gruppen- und Peer-Variante).
 * Escape-/Outside-Click-/Blur-Handling ist aus Chats.jsx mitgewandert.
 *
 * Props:
 * - menu: { chat, x, y } | null
 * - onClose(): schließt das Menü
 * - resolveContact(peerId), applyNotificationMute(contactId, mode)
 * - actions: { onOpenChat(id), onOpenAiProfile(chat), onOpenClearContext(id),
 *   onOpenDelete(id), onOpenGroupInfo(id), setChatPinned(id, pinned),
 *   setContactE2eeEnabled(id, on), setContactBlocked(id, blocked),
 *   onOpenNickname(chat), onCopyPeerId(id), toast }
 */
export function ChatListContextMenu({ menu, onClose, resolveContact, applyNotificationMute, actions }) {
  const listContextMenuRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e) => {
      if (listContextMenuRef.current?.contains(e.target)) return;
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
  }, [menu, onClose]);

  if (!menu) return null;

  return (
    <div
      ref={listContextMenuRef}
      className="chat-list-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          actions.onOpenChat(menu.chat.id);
          onClose();
        }}
      >
        <MessageSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Chat öffnen
      </button>
      {menu.chat.isAiChat ? (
        <>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => actions.onOpenAiProfile(menu.chat)}
          >
            <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Profil bearbeiten…
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => actions.onOpenClearContext(menu.chat.id)}
          >
            <Eraser size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Verlauf leeren…
          </button>
          <div className="chat-list-context-menu-sep" role="separator" />
          <button
            type="button"
            className="chat-list-context-menu-item chat-list-context-menu-item--danger"
            role="menuitem"
            onClick={() => actions.onOpenDelete(menu.chat.id)}
          >
            <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Chat löschen…
          </button>
        </>
      ) : menu.chat.isGroup ? (
        <>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => {
              actions.onOpenGroupInfo(menu.chat.id);
              onClose();
            }}
          >
            <Users size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Gruppeninfo
          </button>
          <div className="chat-list-context-menu-sep" role="separator" />
          <button
            type="button"
            className="chat-list-context-menu-item chat-list-context-menu-item--danger"
            role="menuitem"
            onClick={() => actions.onOpenDelete(menu.chat.id)}
          >
            <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Gruppe löschen…
          </button>
        </>
      ) : (
        <>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          actions.setChatPinned(menu.chat.id, !menu.chat.pinned);
          onClose();
        }}
      >
        {menu.chat.pinned ? (
          <PinOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        ) : (
          <Pin size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        )}
        {menu.chat.pinned ? 'Chat lösen' : 'Chat anheften'}
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          const id = menu.chat.id;
          const on = contactE2eePreferenceOn(menu.chat.contact);
          actions.setContactE2eeEnabled(id, !on);
          actions.toast({
            variant: 'success',
            title: !on ? 'E2EE aktiv' : 'E2EE aus',
          });
          onClose();
        }}
      >
        {contactE2eePreferenceOn(menu.chat.contact) ? (
          <Unlock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        ) : (
          <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        )}
        {contactE2eePreferenceOn(menu.chat.contact)
          ? 'E2EE deaktivieren (Klartext)'
          : 'E2EE aktivieren'}
      </button>
      {!resolveContact(menu.chat.id)?.blocked ? (
        <>
          <ContextMenuHoverSubmenu
            label="Mitteilungen"
            icon={isContactNotificationMuted(resolveContact(menu.chat.id)) ? BellOff : Bell}
          >
            <NotificationMuteMenuItems
              contact={resolveContact(menu.chat.id)}
              contactId={menu.chat.id}
              applyNotificationMute={applyNotificationMute}
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
        onClick={() => actions.onOpenNickname(menu.chat)}
      >
        <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Spitzname…
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => actions.onCopyPeerId(menu.chat.id)}
      >
        <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Peer-ID kopieren
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          const id = menu.chat.id;
          const blocked = !menu.chat.contact?.blocked;
          actions.setContactBlocked(id, blocked);
          actions.toast({
            variant: 'success',
            title: blocked ? 'Contact blocked' : 'Contact unblocked',
          });
          onClose();
        }}
      >
        <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        {menu.chat.contact?.blocked ? 'Unblock' : 'Block'}
      </button>
      <div className="chat-list-context-menu-sep" role="separator" />
      <button
        type="button"
        className="chat-list-context-menu-item chat-list-context-menu-item--danger"
        role="menuitem"
        onClick={() => actions.onOpenDelete(menu.chat.id)}
      >
        <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Chat löschen…
      </button>
        </>
      )}
    </div>
  );
}
