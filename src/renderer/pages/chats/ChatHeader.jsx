import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban,
  Bell,
  BellOff,
  CheckSquare,
  Copy,
  Eraser,
  Forward,
  Lock,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Trash2,
  Users,
} from 'lucide-react';
import { formatGamePresenceLabel } from '../../../shared/game-presence.js';
import {
  formatUserPresenceLabel,
  isPeerDoNotDisturb,
} from '../../../shared/user-presence.js';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import {
  CHAT_ICON_STROKE,
  PeerAvatar,
  isContextMenuFlyoutTarget,
} from './messageHelpers.jsx';
import {
  AiChatModelPicker,
  ContextMenuHoverSubmenu,
  NotificationMuteMenuItems,
} from './agentBlocks.jsx';

/**
 * Kopf des aktiven Chats: Peer-Info-Button, Gruppen-/KI-Aktionen inkl.
 * Modell-Picker sowie das Chat-Aktionen-Menü (Portal). Der Menü-Zustand
 * (offen/Position) lebt jetzt lokal in dieser Komponente; die Escape-/
 * Outside-Click-Handler sind mitgewandert.
 *
 * Props:
 * - selectedPeer, selectedContact, isAiChatSelected, isGroupSelected
 * - showGroupInfo/showPeerProfile: nur für aria-expanded
 * - ollamaState, aiChatPending, clearingContext, debugMode
 * - selection: { selectionMode, selectedCount, onForwardSelected,
 *   onDeleteSelected, onExitSelection, onStartSelection }
 * - actions: { onShowGroupInfo(), onShowPeerProfile(), onOpenNickname(),
 *   onTogglePinned(), onOpenDelete(peerId), onOpenClearContext(peerId),
 *   onCopyPeerId(peerId), applyNotificationMute(contactId, mode),
 *   resetE2eeSession, setContactBlocked, toast,
 *   onSelectTier, onSelectCloudModel, onOpenCloudSettings }
 */
export function ChatHeader({
  selectedPeer,
  selectedContact,
  isAiChatSelected,
  isGroupSelected,
  showGroupInfo,
  showPeerProfile,
  ollamaState,
  aiChatPending,
  clearingContext,
  debugMode,
  selection,
  actions,
}) {
  const [chatActionsMenuOpen, setChatActionsMenuOpen] = useState(false);
  const [chatMenuPosition, setChatMenuPosition] = useState({ top: 0, left: 0 });
  const chatActionsMenuBtnRef = useRef(null);
  const chatActionsMenuPanelRef = useRef(null);

  // Beim Chat-Wechsel Menü schließen (Teil des früheren Sammel-Reset-Effekts).
  useEffect(() => {
    setChatActionsMenuOpen(false);
  }, [selectedPeer?.id]);

  useLayoutEffect(() => {
    if (!chatActionsMenuOpen || !chatActionsMenuBtnRef.current) return;
    const r = chatActionsMenuBtnRef.current.getBoundingClientRect();
    const menuWidth = 288;
    const left = Math.min(Math.max(8, r.right - menuWidth), window.innerWidth - menuWidth - 8);
    setChatMenuPosition({ top: r.bottom + 6, left });
  }, [chatActionsMenuOpen]);

  useEffect(() => {
    if (!chatActionsMenuOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setChatActionsMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    let onDown = null;
    const id = window.setTimeout(() => {
      onDown = (e) => {
        const t = e.target;
        if (chatActionsMenuBtnRef.current?.contains(t)) return;
        if (chatActionsMenuPanelRef.current?.contains(t)) return;
        if (isContextMenuFlyoutTarget(t)) return;
        setChatActionsMenuOpen(false);
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [chatActionsMenuOpen]);

  const { selectionMode, selectedCount } = selection;

  return (
    <div
      className={`chat-header${selectedPeer.contact?.blocked ? ' chat-header--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' chat-header--blocked-by-peer' : ''}`}
    >
      <button
        type="button"
        className="chat-header-profile-btn"
        onClick={() => isGroupSelected ? actions.onShowGroupInfo() : actions.onShowPeerProfile()}
        aria-haspopup="dialog"
        aria-expanded={isGroupSelected ? showGroupInfo : showPeerProfile}
        title={isGroupSelected ? 'Gruppeninfo' : isAiChatSelected ? 'Profil bearbeiten' : 'Profil anzeigen'}
      >
        <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={40} />
        <div style={{ minWidth: 0 }}>
          <div className="font-medium truncate" style={{ fontSize: 14 }}>{selectedPeer.displayName}</div>
          <div className="text-sm text-muted chat-header-meta">
            <span>
              {isGroupSelected
                ? `${selectedPeer.activeMemberCount} Mitglieder · ${Math.max(0, selectedPeer.onlineMemberCount - 1)} online · E2EE`
                : isAiChatSelected
                ? 'Online'
                : selectedPeer.gamePresence
                  ? formatGamePresenceLabel(selectedPeer.gamePresence)
                  : !selectedPeer.offline && isPeerDoNotDisturb(selectedPeer.userPresence)
                    ? formatUserPresenceLabel(selectedPeer.userPresence)
                  : selectedPeer.contact?.blocked
                  ? 'Blockiert'
                  : selectedPeer.contact?.blockedByPeer
                    ? 'Du wurdest blockiert'
                    : selectedPeer.contact?.chatDeletedByPeer
                      ? 'Chat gelöscht'
                      : selectedPeer.offline
                        ? 'Offline'
                        : 'Online'}
              {!isAiChatSelected && !isGroupSelected && selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname
                ? ` · ${selectedPeer.baseName}`
                : ''}
              {!isAiChatSelected && isContactNotificationMuted(selectedContact)
                ? ' · Mitteilungen stumm'
                : ''}
            </span>
            {isAiChatSelected ? (
              selectedPeer.bio ? (
                <span className="chat-header-bio" title={selectedPeer.bio}>
                  {selectedPeer.bio}
                </span>
              ) : null
            ) : selectedPeer.bio ? (
              <span className="chat-header-bio" title={selectedPeer.bio}>
                {selectedPeer.bio}
              </span>
            ) : null}
          </div>
        </div>
      </button>
      {isGroupSelected && (
        <div className="chat-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            onClick={() => actions.onShowGroupInfo()}
            title="Gruppeninfo"
            aria-label="Gruppeninfo"
          >
            <Users size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
        </div>
      )}
      {!isAiChatSelected && !isGroupSelected && (
      <div className="chat-header-actions">
        {selectionMode ? (
          <div className="chat-selection-bar">
            <span className="chat-selection-count">
              {selectedCount === 0 ? 'Nachrichten auswählen' : `${selectedCount} ausgewählt`}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={selectedCount === 0}
              onClick={selection.onForwardSelected}
            >
              <Forward size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Weiterleiten
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={selectedCount === 0}
              onClick={() => void selection.onDeleteSelected()}
            >
              <Trash2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Löschen
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={selection.onExitSelection}
            >
              Aus
            </button>
          </div>
        ) : (
        <button
          type="button"
          className="btn btn-secondary btn-icon"
          ref={chatActionsMenuBtnRef}
          aria-label="Chat-Aktionen"
          aria-expanded={chatActionsMenuOpen}
          aria-haspopup="menu"
          title="Chat-Aktionen"
          onClick={() => setChatActionsMenuOpen((o) => !o)}
        >
          <MoreVertical size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        </button>
        )}
        {chatActionsMenuOpen && !selectionMode &&
          createPortal(
            <div
              ref={chatActionsMenuPanelRef}
              className="chat-list-context-menu chat-header-peer-menu animate-scale"
              role="menu"
              style={{
                position: 'fixed',
                top: chatMenuPosition.top,
                left: chatMenuPosition.left,
                zIndex: 1250,
                maxHeight: 'min(420px, calc(100vh - 24px))',
                overflowY: 'auto',
              }}
            >
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => {
                if (!selectedPeer) return;
                actions.resetE2eeSession(selectedPeer.id);
                actions.toast({
                  variant: 'success',
                  title: 'Verschlüsselung erneuert',
                  message: 'Die E2EE-Sitzung wird neu ausgehandelt.',
                });
                setChatActionsMenuOpen(false);
              }}
            >
              <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Verschlüsselung erneuern
            </button>
            {!selectedContact?.blocked ? (
              <>
                <ContextMenuHoverSubmenu
                  label="Mitteilungen"
                  icon={isContactNotificationMuted(selectedContact) ? BellOff : Bell}
                >
                  <NotificationMuteMenuItems
                    contact={selectedContact}
                    contactId={selectedPeer.id}
                    applyNotificationMute={actions.applyNotificationMute}
                    onDone={() => setChatActionsMenuOpen(false)}
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
                if (!selectedPeer) return;
                const next = !selectedPeer.contact?.blocked;
                actions.setContactBlocked(selectedPeer.id, next);
                actions.toast({
                  variant: 'success',
                  title: next ? 'Contact blocked' : 'Contact unblocked',
                  message: next
                    ? 'They no longer appear in your chat list and cannot message you.'
                    : 'You can chat with them again from New connections or by reconnecting.',
                });
                setChatActionsMenuOpen(false);
              }}
            >
              <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              {selectedPeer.contact?.blocked ? 'Entblocken' : 'Blockieren'}
            </button>
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => {
                actions.onOpenNickname();
                setChatActionsMenuOpen(false);
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
                setChatActionsMenuOpen(false);
              }}
            >
              {selectedPeer.pinned ? (
                <PinOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              ) : (
                <Pin size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              )}
              {selectedPeer.pinned ? 'Chat lösen' : 'Chat anheften'}
            </button>
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => {
                setChatActionsMenuOpen(false);
                selection.onStartSelection();
              }}
            >
              <CheckSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Auswahl
            </button>
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => {
                void actions.onCopyPeerId(selectedPeer.id);
                setChatActionsMenuOpen(false);
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
                actions.onOpenDelete(selectedPeer.id);
                setChatActionsMenuOpen(false);
              }}
            >
              <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Chat löschen…
            </button>
            </div>,
            document.body
          )}
      </div>
      )}
      {isAiChatSelected && (
        <div className="chat-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Profil bearbeiten"
            title="Profil bearbeiten"
            onClick={() => actions.onShowPeerProfile()}
          >
            <Pencil size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
          <AiChatModelPicker
            ollamaState={ollamaState}
            disabled={aiChatPending}
            debugMode={debugMode}
            onSelectTier={actions.onSelectTier}
            onSelectCloudModel={actions.onSelectCloudModel}
            onOpenCloudSettings={actions.onOpenCloudSettings}
          />
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="Verlauf leeren"
            title="Verlauf leeren"
            disabled={aiChatPending || clearingContext}
            onClick={() => actions.onOpenClearContext(selectedPeer.id)}
          >
            <Eraser size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-icon"
            aria-label="KI-Chat löschen"
            title="KI-Chat löschen"
            onClick={() => actions.onOpenDelete(selectedPeer.id)}
          >
            <Trash2 size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
