import React, { useEffect } from 'react';
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
  X,
} from 'lucide-react';
import { isContactNotificationMuted } from '../../../contactNotificationMute';
import {
  CHAT_ICON_STROKE,
  MUTE_1H_MS,
  MUTE_8H_MS,
  PeerAvatar,
  formatMuteExpiry,
  notificationMuteSelectValue,
  peerProfileAddress,
} from '../messageHelpers.jsx';
import { peerPresenceKind, peerPresenceLabel } from '../peerPresence.js';

const MUTE_CHIPS = [
  { id: 'off', label: 'Ein' },
  { id: '1h', label: '1 Std.' },
  { id: '8h', label: '8 Std.' },
  { id: '24h', label: '24 Std.' },
  { id: 'manual', label: 'Dauerhaft' },
];

function activeMuteChip(contact) {
  const value = notificationMuteSelectValue(contact);
  if (value === 'off' || value === 'manual') return value;
  const remaining = Number(contact?.notifyMutedUntil) - Date.now();
  if (remaining <= MUTE_1H_MS + 60_000) return '1h';
  if (remaining <= MUTE_8H_MS + 60_000) return '8h';
  return '24h';
}

/**
 * Profil-Ansicht eines (Nicht-KI-)Peers: Status, IDs und Chat-Aktionen.
 *
 * Props: open, selectedPeer, selectedContact, onClose(),
 * copyToClipboard(text, successTitle), actions
 */
export function PeerProfileDialog({
  open,
  selectedPeer,
  selectedContact,
  onClose,
  copyToClipboard,
  actions,
}) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !selectedPeer) return null;

  const presenceKind = peerPresenceKind(selectedPeer, false, false);
  const presenceLabel = peerPresenceLabel(selectedPeer, false, false);
  const address = peerProfileAddress(selectedPeer);
  const muted = isContactNotificationMuted(selectedContact);
  const muteValue = notificationMuteSelectValue(selectedContact);
  const muteChip = activeMuteChip(selectedContact);
  const contact = selectedContact || selectedPeer.contact;

  const closeThen = (fn) => {
    onClose();
    fn();
  };

  return (
    <aside
      className={`chat-profile-panel peer-profile-modal${selectedPeer.contact?.blocked ? ' peer-profile-modal--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' peer-profile-modal--blocked-by-peer' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby="peer-profile-title"
    >
        <div className="peer-profile-modal-toolbar">
          <h2 className="peer-profile-modal-title">Profil</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Schließen"
          >
            <X size={18} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <div className="peer-profile-modal-body">
          <div className="peer-profile-modal-hero">
            <span className="peer-profile-avatar-wrap">
              <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={80} />
              <span className={`chat-header-presence-dot is-${presenceKind}`} aria-hidden />
            </span>
            <h2 id="peer-profile-title" className="peer-profile-modal-name">
              {selectedPeer.displayName}
            </h2>
            {selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname ? (
              <div className="peer-profile-modal-aka">{selectedPeer.baseName}</div>
            ) : null}
            <div className={`peer-profile-status is-${presenceKind}`}>
              <span className="peer-profile-status-dot" aria-hidden />
              {presenceLabel}
            </div>
          </div>

          {selectedPeer.bio ? (
            <p className="peer-profile-bio">{selectedPeer.bio}</p>
          ) : null}

          <div className="peer-profile-card">
            <div className="peer-profile-card-row">
              <div className="peer-profile-card-copy">
                <span className="peer-profile-field-label">Peer-ID</span>
                <span className="peer-profile-id-text">{selectedPeer.id}</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-icon btn-sm"
                title="Peer-ID kopieren"
                aria-label="Peer-ID kopieren"
                onClick={() => copyToClipboard(selectedPeer.id, 'Peer-ID kopiert')}
              >
                <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
            </div>
            {address ? (
              <div className="peer-profile-card-row">
                <div className="peer-profile-card-copy">
                  <span className="peer-profile-field-label">Adresse</span>
                  <span className="peer-profile-id-text">{address}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon btn-sm"
                  title="Adresse kopieren"
                  aria-label="Adresse kopieren"
                  onClick={() => copyToClipboard(address, 'Adresse kopiert')}
                >
                  <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                </button>
              </div>
            ) : null}
          </div>

          <div className="peer-profile-section">
            <div className="peer-profile-section-title">Aktionen</div>

            {!contact?.blocked ? (
              <div className="peer-profile-mute">
                <div className="peer-profile-mute-head">
                  {muted ? (
                    <BellOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  ) : (
                    <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  )}
                  <div>
                    <div className="peer-profile-mute-title">Mitteilungen</div>
                    <div className="peer-profile-mute-hint">
                      {muted
                        ? muteValue === 'manual'
                          ? 'Stumm, bis du sie wieder einschaltest'
                          : `Stumm bis ${formatMuteExpiry(selectedContact?.notifyMutedUntil)}`
                        : 'Benachrichtigungen sind an'}
                    </div>
                  </div>
                </div>
                <div className="peer-profile-mute-chips" role="group" aria-label="Mitteilungen">
                  {MUTE_CHIPS.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      className={`peer-profile-mute-chip${muteChip === chip.id ? ' is-active' : ''}`}
                      onClick={() => actions.applyNotificationMute(selectedPeer.id, chip.id)}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <button
              type="button"
              className="peer-profile-action"
              onClick={() => closeThen(() => actions.onOpenNickname())}
            >
              <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Spitzname ändern
            </button>
            <button
              type="button"
              className="peer-profile-action"
              onClick={() => actions.onTogglePinned()}
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
              className="peer-profile-action"
              onClick={() => closeThen(() => actions.onStartSelection())}
            >
              <CheckSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Nachrichten auswählen
            </button>
            <button
              type="button"
              className="peer-profile-action"
              onClick={() => {
                actions.resetE2eeSession(selectedPeer.id);
                actions.toast({
                  variant: 'success',
                  title: 'Verschlüsselung erneuert',
                  message: 'Die E2EE-Sitzung wird neu ausgehandelt.',
                });
              }}
            >
              <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Verschlüsselung erneuern
            </button>
            <button
              type="button"
              className="peer-profile-action"
              onClick={() => {
                const next = !selectedPeer.contact?.blocked;
                actions.setContactBlocked(selectedPeer.id, next);
                actions.toast({
                  variant: 'success',
                  title: next ? 'Kontakt blockiert' : 'Kontakt entblockt',
                  message: next
                    ? 'Der Kontakt erscheint nicht mehr in der Liste und kann dir nicht schreiben.'
                    : 'Du kannst wieder chatten — über Neu oder durch erneutes Verbinden.',
                });
              }}
            >
              <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              {selectedPeer.contact?.blocked ? 'Entblocken' : 'Blockieren'}
            </button>
            <button
              type="button"
              className="peer-profile-action peer-profile-action--danger"
              onClick={() => closeThen(() => actions.onOpenDelete(selectedPeer.id))}
            >
              <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Chat löschen…
            </button>
          </div>
        </div>
    </aside>
  );
}
