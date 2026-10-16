import React, { useEffect, useRef } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar } from '../pages/chats/messageHelpers.jsx';

export function CallIncomingOverlay({ name, picture, onAccept, onReject }) {
  const acceptRef = useRef(null);

  useEffect(() => {
    acceptRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        onAccept?.();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onReject?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAccept, onReject]);

  return (
    <div className="call-overlay call-overlay--incoming" role="dialog" aria-label="Eingehender Sprachanruf">
      <div className="call-overlay-card">
        <div className="call-avatar-pulse">
          <span className="call-pulse-ring" aria-hidden />
          <span className="call-pulse-ring call-pulse-ring--delay" aria-hidden />
          <PeerAvatar pictureUrl={picture} name={name} size={72} />
        </div>
        <div className="call-overlay-name">{name}</div>
        <div className="call-overlay-status">Sprachanruf…</div>
        <div className="call-overlay-actions">
          <button type="button" className="call-action call-action--reject" onClick={onReject} title="Ablehnen">
            <span className="call-action-orb">
              <PhoneOff size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </span>
            <span>Ablehnen</span>
          </button>
          <button
            ref={acceptRef}
            type="button"
            className="call-action call-action--accept"
            onClick={onAccept}
            title="Annehmen"
          >
            <span className="call-action-orb">
              <Phone size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </span>
            <span>Annehmen</span>
          </button>
        </div>
      </div>
    </div>
  );
}
