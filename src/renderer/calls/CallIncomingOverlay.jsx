import React, { useEffect, useRef } from 'react';
import { Phone, PhoneOff, Video } from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar } from '../pages/chats/messageHelpers.jsx';

export function CallIncomingOverlay({
  name,
  picture,
  video = false,
  videoCapable = false,
  onAccept,
  onAcceptWithCamera,
  onReject,
}) {
  const acceptRef = useRef(null);
  const isVideo = Boolean(video);

  useEffect(() => {
    acceptRef.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (isVideo && videoCapable) onAcceptWithCamera?.();
        else onAccept?.();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onReject?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isVideo, onAccept, onAcceptWithCamera, onReject, videoCapable]);

  return (
    <div className="call-overlay call-overlay--incoming" role="dialog" aria-label={isVideo ? 'Eingehender Videoanruf' : 'Eingehender Sprachanruf'}>
      <div className="call-overlay-card">
        <div className="call-avatar-pulse">
          <span className="call-pulse-ring" aria-hidden />
          <span className="call-pulse-ring call-pulse-ring--delay" aria-hidden />
          <PeerAvatar pictureUrl={picture} name={name} size={72} />
        </div>
        <div className="call-overlay-name">{name}</div>
        <div className={`call-overlay-status${isVideo ? ' call-overlay-status--video' : ''}`}>
          {isVideo ? 'Videoanruf…' : 'Sprachanruf…'}
        </div>
        <div className="call-overlay-actions">
          <button type="button" className="call-action call-action--reject" onClick={onReject} title="Ablehnen">
            <span className="call-action-orb">
              <PhoneOff size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </span>
            <span>Ablehnen</span>
          </button>
          {isVideo ? (
            <>
              <button
                ref={acceptRef}
                type="button"
                className="call-action call-action--accept"
                onClick={onAccept}
                title="Annehmen ohne Kamera"
              >
                <span className="call-action-orb">
                  <Phone size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                </span>
                <span>Ohne Kamera</span>
              </button>
              <button
                type="button"
                className="call-action call-action--accept-video"
                onClick={onAcceptWithCamera}
                disabled={!videoCapable}
                title={videoCapable ? 'Annehmen mit Kamera' : 'Video auf diesem Gerät nicht verfügbar'}
              >
                <span className="call-action-orb">
                  <Video size={20} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                </span>
                <span>Mit Kamera</span>
              </button>
            </>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}
