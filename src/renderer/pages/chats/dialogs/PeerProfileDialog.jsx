import React, { useEffect } from 'react';
import { Copy, X } from 'lucide-react';
import {
  CHAT_ICON_STROKE,
  PeerAvatar,
  peerProfileAddress,
} from '../messageHelpers.jsx';

/**
 * Profil-Ansicht eines (Nicht-KI-)Peers: Status, Peer-ID, Adresse, Info.
 * Escape-Handler ist aus Chats.jsx mitgewandert (greift nur bei open).
 *
 * Props: open, selectedPeer, onClose(), copyToClipboard(text, successTitle)
 */
export function PeerProfileDialog({ open, selectedPeer, onClose, copyToClipboard }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className={`modal animate-scale peer-profile-modal${selectedPeer.contact?.blocked ? ' peer-profile-modal--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' peer-profile-modal--blocked-by-peer' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="peer-profile-title"
      >
        <div className="peer-profile-modal-toolbar">
          <h2 id="peer-profile-title" className="peer-profile-modal-title">
            Profil
          </h2>
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
            <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={72} />
            <div className="peer-profile-modal-name">{selectedPeer.displayName}</div>
            {selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname ? (
              <div className="text-sm text-muted">{selectedPeer.baseName}</div>
            ) : null}
          </div>
          <div className="peer-profile-field">
            <span className="peer-profile-field-label">Status</span>
            <span>
              {selectedPeer.contact?.blocked
                ? 'Blockiert'
                : selectedPeer.contact?.blockedByPeer
                  ? 'Hat dich blockiert'
                  : selectedPeer.contact?.chatDeletedByPeer
                    ? 'Hat den Chat gelöscht'
                    : selectedPeer.offline
                      ? 'Offline'
                      : 'Online'}
            </span>
          </div>
          <div className="peer-profile-field">
            <span className="peer-profile-field-label">Peer-ID</span>
            <div className="peer-profile-id-row">
              <span className="peer-profile-id-text">{selectedPeer.id}</span>
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
          </div>
          {peerProfileAddress(selectedPeer) ? (
            <div className="peer-profile-field">
              <span className="peer-profile-field-label">Adresse</span>
              <div className="peer-profile-id-row">
                <span className="peer-profile-id-text">{peerProfileAddress(selectedPeer)}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon btn-sm"
                  title="Adresse kopieren"
                  aria-label="Adresse kopieren"
                  onClick={() =>
                    copyToClipboard(peerProfileAddress(selectedPeer), 'Adresse kopiert')
                  }
                >
                  <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                </button>
              </div>
            </div>
          ) : null}
          {selectedPeer.bio ? (
            <div className="peer-profile-field peer-profile-field--bio">
              <span className="peer-profile-field-label">Info</span>
              <p className="peer-profile-bio">{selectedPeer.bio}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
