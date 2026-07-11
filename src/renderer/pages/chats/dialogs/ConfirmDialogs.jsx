import React from 'react';
import { X } from 'lucide-react';
import groupChat from '../../../../shared/group-chat.js';
import { CHAT_ICON_STROKE } from '../messageHelpers.jsx';

const { isGroupChatId } = groupChat;

/**
 * Bestätigungsdialoge: KI-Verlauf leeren und Chat/Gruppe löschen.
 * JSX 1:1 aus Chats.jsx übernommen; Zustände (Ziel, busy) bleiben im Parent,
 * weil dort Effekte/abgeleitete Werte daran hängen.
 */

/**
 * Props: open, peer (peerPendingClear), busy (clearingContext),
 * onClose() — setzt show/target zurück, onConfirm()
 */
export function ClearContextConfirmDialog({ open, peer, busy, onClose, onConfirm }) {
  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 style={{ margin: 0 }}>Verlauf leeren?</h3>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => {
              if (busy) return;
              onClose();
            }}
            disabled={busy}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <p className="text-muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          Der gesamte Chatverlauf und der Agent-Kontext (inkl. Erinnerungen) von{' '}
          <strong>{peer.displayName}</strong> werden gelöscht. Der KI-Agent bleibt erhalten.
          Dies kann nicht rückgängig gemacht werden.
        </p>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void onConfirm()}
            disabled={busy}
          >
            {busy ? (
              <span className="spinner-label">
                <span className="spinner spinner--sm spinner--accent" />
                <span>Leere…</span>
              </span>
            ) : 'Verlauf leeren'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Props: open, peer (peerPendingDelete), targetPeerId (deleteTargetPeerId),
 * busy (deletingChat), onClose() — setzt show/target zurück, onConfirm()
 */
export function DeleteChatConfirmDialog({ open, peer, targetPeerId, busy, onClose, onConfirm }) {
  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onClick={() => {
        if (busy) return;
        onClose();
      }}
    >
      <div className="modal modal-danger animate-scale" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 style={{ margin: 0 }}>
            {isGroupChatId(targetPeerId) ? 'Gruppe löschen?' : 'Chat löschen?'}
          </h3>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => {
              if (busy) return;
              onClose();
            }}
            disabled={busy}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <p className="text-muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
          {isGroupChatId(targetPeerId) ? (
            <>
              {peer?.canSend
                ? <>Du verlässt <strong>{peer.displayName}</strong> und entfernst alle Nachrichten auf diesem Gerät. Das kann nicht rückgängig gemacht werden.</>
                : <>Die Gruppe <strong>{peer.displayName}</strong> und alle Nachrichten auf diesem Gerät werden entfernt. Das kann nicht rückgängig gemacht werden.</>}
            </>
          ) : (
            <>Der Chat mit <strong>{peer.displayName}</strong> und alle Nachrichten auf diesem Gerät werden entfernt. Das kann nicht rückgängig gemacht werden.</>
          )}
        </p>
        <div className="modal-actions">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (
              <span className="spinner-label">
                <span className="spinner spinner--sm spinner--accent" />
                <span>Wird gelöscht…</span>
              </span>
            ) : (isGroupChatId(targetPeerId) ? 'Gruppe löschen' : 'Chat löschen')}
          </button>
        </div>
      </div>
    </div>
  );
}
