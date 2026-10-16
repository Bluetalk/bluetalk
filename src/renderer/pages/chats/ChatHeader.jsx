import React, { useEffect, useState } from 'react';
import {
  Cloud,
  Forward,
  Phone,
  Search,
  Trash2,
  Video,
} from 'lucide-react';
import { AI_CHAT_DISCONTINUED } from '../../aiChatConstants';
import { useCall } from '../../calls/CallProvider.jsx';
import { PeerChatContextMenu } from './menus/PeerChatContextMenu.jsx';
import { peerPresenceKind, peerPresenceLabel } from './peerPresence.js';
import {
  CHAT_ICON_STROKE,
  PeerAvatar,
} from './messageHelpers.jsx';
import { ChatBackButton } from './ChatBackButton.jsx';

/**
 * Kopf des aktiven Chats: Profil oben rechts in der Chat-Ansicht, plus Auswahl-Leiste.
 * Peer-Aktionen liegen im Rechtsklick auf die Karte und im Profil-Panel.
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
 * - onBack(): Zurück zur Liste im Ein-Spalten-Layout
 */
export function ChatHeader({
  selectedPeer,
  selectedContact,
  isAiChatSelected,
  isGroupSelected,
  showGroupInfo,
  showPeerProfile,
  ollamaState,
  selectedBot = null,
  aiChatPending,
  clearingContext,
  debugMode,
  selection,
  actions,
  onBack,
  onOpenSearch,
}) {
  const [peerMenu, setPeerMenu] = useState(null);
  const { selectionMode, selectedCount } = selection;
  const callApi = useCall();
  const showPeerActions = !isAiChatSelected && !isGroupSelected;
  const callDisabledReason = !showPeerActions
    ? (isGroupSelected ? 'Anrufe nur in 1:1-Chats' : 'Keine Anrufe mit Bots')
    : selectedPeer?.offline
      ? 'Kontakt ist offline'
      : (selectedPeer?.contact?.blocked || selectedPeer?.contact?.blockedByPeer || selectedPeer?.contact?.chatDeletedByPeer)
        ? 'Anruf nicht möglich'
        : '';
  const showCallButton = showPeerActions && !selectionMode;

  useEffect(() => {
    setPeerMenu(null);
  }, [selectedPeer?.id]);

  const presenceKind = peerPresenceKind(selectedPeer, isAiChatSelected, isGroupSelected);
  const presenceLabel = peerPresenceLabel(selectedPeer, isAiChatSelected, isGroupSelected);
  const profileActionLabel = isGroupSelected ? 'Gruppeninfo' : isAiChatSelected ? 'Profil bearbeiten' : 'Profil anzeigen';

  return (
    <div
      className={`chat-header chat-header--has-profile${selectedPeer.contact?.blocked ? ' chat-header--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' chat-header--blocked-by-peer' : ''}`}
    >
      <ChatBackButton onBack={onBack} />
      {showPeerActions && selectionMode ? (
        <div className="chat-header-actions">
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
              Fertig
            </button>
          </div>
        </div>
      ) : null}
      {!selectionMode && onOpenSearch ? (
        <button
          type="button"
          className="chat-header-call-btn"
          title="Im Chat suchen (Strg+F)"
          aria-label="Im Chat suchen"
          onClick={onOpenSearch}
        >
          <Search size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        </button>
      ) : null}
      {showCallButton ? (
        <div className="chat-header-call-group">
          <button
            type="button"
            className="chat-header-call-btn"
            disabled={Boolean(callDisabledReason) || !callApi?.startCall}
            title={callDisabledReason || 'Sprachanruf'}
            aria-label={callDisabledReason || 'Sprachanruf starten'}
            onClick={() => {
              if (callDisabledReason || !selectedPeer?.id) return;
              void callApi?.startCall?.(selectedPeer.id);
            }}
          >
            <Phone size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
          <button
            type="button"
            className="chat-header-call-btn"
            disabled={Boolean(callDisabledReason) || !callApi?.startCall || callApi?.call?.videoCapable === false}
            title={
              callDisabledReason
                || (callApi?.call?.videoCapable === false ? 'Video auf diesem Gerät nicht verfügbar' : 'Videoanruf')
            }
            aria-label={callDisabledReason || 'Videoanruf starten'}
            onClick={() => {
              if (callDisabledReason || !selectedPeer?.id) return;
              void callApi?.startCall?.(selectedPeer.id, { video: true });
            }}
          >
            <Video size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className={`chat-header-profile-btn${selectedPeer.contact?.blocked ? ' chat-header-profile-btn--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' chat-header-profile-btn--blocked-by-peer' : ''}`}
        onClick={() => isGroupSelected ? actions.onShowGroupInfo() : actions.onShowPeerProfile()}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!showPeerActions) return;
          setPeerMenu({ x: e.clientX, y: e.clientY });
        }}
        aria-haspopup="dialog"
        aria-expanded={isGroupSelected ? showGroupInfo : showPeerProfile}
        aria-label={`${selectedPeer.displayName}, ${presenceLabel}. ${profileActionLabel}`}
        title={showPeerActions
          ? `${selectedPeer.displayName} · ${presenceLabel} · Rechtsklick für Optionen`
          : `${selectedPeer.displayName} · ${presenceLabel}`}
      >
        <span className="chat-header-avatar-wrap">
          <PeerAvatar
            pictureUrl={selectedPeer.profilePicture}
            name={selectedPeer.displayName}
            size={40}
            className={isAiChatSelected ? 'peer-avatar-img--bot' : ''}
            botStatus={isAiChatSelected ? (aiChatPending ? 'thinking' : selectedPeer.botReady ? 'idle' : 'setup') : 'idle'}
          />
          <span className={`chat-header-presence-dot is-${presenceKind}`} aria-hidden />
        </span>
        <span className="chat-header-name-row">
          <span className="chat-header-name">{selectedPeer.displayName}</span>
          {isAiChatSelected && AI_CHAT_DISCONTINUED ? (
            <span className="chat-retired-badge" title="Bots wurden eingestellt">Eingestellt</span>
          ) : null}
          {selectedPeer.peer?.transport === 'relay' ? (
            <span className="chat-cloud-badge" title="Über Cloud verbunden">
              <Cloud size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </span>
          ) : null}
        </span>
      </button>
      <PeerChatContextMenu
        menu={peerMenu}
        peer={selectedPeer}
        contact={selectedContact}
        onClose={() => setPeerMenu(null)}
        onStartSelection={selection.onStartSelection}
        actions={actions}
      />
    </div>
  );
}
