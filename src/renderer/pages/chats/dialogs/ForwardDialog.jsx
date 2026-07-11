import React from 'react';
import { X } from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar, getLastPreview } from '../messageHelpers.jsx';

/**
 * Weiterleiten-Dialog: Zielauswahl aus den erlaubten Chats.
 * JSX 1:1 aus Chats.jsx übernommen; der Dialog-Zustand kommt aus useForwarding.
 *
 * Props: forwardDialog ({ messages, sourcePeerId } | null),
 * forwardableChats, busy (forwardingMessages), debugMode,
 * onClose(), onForward(targetPeerId)
 */
export function ForwardDialog({ forwardDialog, forwardableChats, busy, debugMode, onClose, onForward }) {
  if (!forwardDialog) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="modal animate-scale forward-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 style={{ margin: 0 }}>
            {forwardDialog.messages.length === 1 ? 'Nachricht weiterleiten' : `${forwardDialog.messages.length} Nachrichten weiterleiten`}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => {
              if (busy) return;
              onClose();
            }}
            aria-label="Schließen"
            disabled={busy}
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <p className="text-muted" style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
          Wähle einen Chat als Ziel.
        </p>
        <div className="forward-dialog-list">
          {forwardableChats.length === 0 ? (
            <div className="empty-state" style={{ padding: '12px 0' }}>
              <p>Keine weiteren Chats verfügbar.</p>
            </div>
          ) : (
            forwardableChats.map((chat) => (
              <button
                key={chat.id}
                type="button"
                className="forward-dialog-item"
                disabled={busy}
                onClick={() => void onForward(chat.id)}
              >
                <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={32} />
                <div className="forward-dialog-item-info">
                  <div className="forward-dialog-item-name">{chat.displayName}</div>
                  <div className="forward-dialog-item-sub">{getLastPreview(chat.lastMessage, debugMode)}</div>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
        </div>
      </div>
    </div>
  );
}
