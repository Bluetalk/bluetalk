import React, { useEffect } from 'react';
import { PhoneOff } from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar } from '../pages/chats/messageHelpers.jsx';

export function CallOutgoingOverlay({ name, picture, ringing = false, video = false, onCancel }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="call-overlay call-overlay--outgoing" role="dialog" aria-label={video ? 'Ausgehender Videoanruf' : 'Ausgehender Sprachanruf'}>
      <div className="call-overlay-card">
        <div className={`call-avatar-pulse${ringing ? ' is-ringing' : ' is-dialing'}`}>
          <span className="call-pulse-ring" aria-hidden />
          <PeerAvatar pictureUrl={picture} name={name} size={72} />
        </div>
        <div className="call-overlay-name">{name}</div>
        <div className={`call-overlay-status${video ? ' call-overlay-status--video' : ''}`}>
          {ringing ? 'Klingelt…' : (video ? 'Videoanruf…' : 'Wird angerufen…')}
        </div>
        <div className="call-overlay-actions">
          <button type="button" className="call-action call-action--reject" onClick={onCancel} title="Abbrechen">
            <span className="call-action-orb">
              <PhoneOff size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </span>
            <span>Abbrechen</span>
          </button>
        </div>
      </div>
    </div>
  );
}
