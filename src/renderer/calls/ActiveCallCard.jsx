import React, { useEffect, useState } from 'react';
import { Cloud, Mic, MicOff, Maximize2, Monitor, PhoneOff, Video, VideoOff } from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar } from '../pages/chats/messageHelpers.jsx';
import { formatDurationMs } from '../voice/format.js';
import { videoControlHint } from './callState.js';

function qualityFromRtt(rttMs) {
  if (rttMs == null) return { label: 'Verbinden…', kind: 'unknown' };
  if (rttMs < 80) return { label: 'Sehr gut', kind: 'great' };
  if (rttMs < 150) return { label: 'Gut', kind: 'good' };
  if (rttMs < 300) return { label: 'Okay', kind: 'ok' };
  return { label: 'Schwach', kind: 'poor' };
}

export function ActiveCallCard({
  name,
  picture,
  transport,
  connectedAt,
  rttMs,
  muted,
  localCamera = false,
  localScreen = false,
  hasVideo = false,
  videoCapable = false,
  peerVideoCapable = false,
  onToggleMute,
  onToggleCamera,
  onToggleScreen,
  onHangup,
  onExpand,
  getLevels,
}) {
  const [elapsed, setElapsed] = useState(() => Date.now() - (connectedAt || Date.now()));
  const [levels, setLevels] = useState({ capture: 0, playback: 0 });

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Date.now() - (connectedAt || Date.now()));
      const next = getLevels?.();
      if (next) setLevels({ capture: next.capture || 0, playback: next.playback || 0 });
    }, 250);
    return () => window.clearInterval(id);
  }, [connectedAt, getLevels]);

  const quality = qualityFromRtt(rttMs);
  const viaCloud = transport === 'relay';
  const captureH = 4 + Math.min(1, levels.capture * 3) * 16;
  const playH = 4 + Math.min(1, levels.playback * 3) * 16;
  const canVideo = Boolean(videoCapable && peerVideoCapable);
  const videoHint = videoControlHint(videoCapable, peerVideoCapable);

  return (
    <div className="call-float" role="status" aria-label={hasVideo ? 'Aktiver Videoanruf' : 'Aktiver Sprachanruf'}>
      <div className="call-float-card">
        <PeerAvatar pictureUrl={picture} name={name} size={28} />
        <div className="call-float-compact">
          <span className="call-float-time">{formatDurationMs(elapsed)}</span>
        </div>
        <div className="call-float-details">
          <div className="call-float-meta">
            <div className="call-float-name">{name}</div>
            <div className="call-float-sub">
              <span className={`call-quality is-${quality.kind}`}>{quality.label}</span>
              <span className="call-float-dot" aria-hidden />
              <span className="call-via" title={viaCloud ? 'Über Cloud verbunden' : 'Direktverbindung'}>
                {viaCloud ? (
                  <>
                    <Cloud size={11} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    Cloud
                  </>
                ) : 'Direkt'}
              </span>
            </div>
          </div>
          <div className="call-level" aria-hidden>
            <span className="call-level-bar" style={{ height: `${captureH}px` }} />
            <span className="call-level-bar" style={{ height: `${playH}px` }} />
          </div>
          <button
            type="button"
            className={`call-float-btn${muted ? ' is-muted' : ''}`}
            onClick={onToggleMute}
            title={muted ? 'Mikrofon an' : 'Stummschalten'}
          >
            {muted ? (
              <MicOff size={16} strokeWidth={CHAT_ICON_STROKE} />
            ) : (
              <Mic size={16} strokeWidth={CHAT_ICON_STROKE} />
            )}
          </button>
          <button
            type="button"
            className={`call-float-btn${localCamera ? '' : ' is-muted'}`}
            onClick={onToggleCamera}
            disabled={!canVideo}
            title={videoHint || (localCamera ? 'Kamera aus' : 'Kamera an')}
          >
            {localCamera
              ? <Video size={16} strokeWidth={CHAT_ICON_STROKE} />
              : <VideoOff size={16} strokeWidth={CHAT_ICON_STROKE} />}
          </button>
          <button
            type="button"
            className={`call-float-btn${localScreen ? '' : ''}`}
            onClick={onToggleScreen}
            disabled={!canVideo}
            title={videoHint || (localScreen ? 'Bildschirm beenden' : 'Bildschirm teilen')}
          >
            <Monitor size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
          {hasVideo && onExpand ? (
            <button
              type="button"
              className="call-float-btn"
              onClick={onExpand}
              title="Video einblenden"
            >
              <Maximize2 size={16} strokeWidth={CHAT_ICON_STROKE} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          className="call-float-btn call-float-btn--hangup"
          onClick={onHangup}
          title="Auflegen"
        >
          <PhoneOff size={16} strokeWidth={CHAT_ICON_STROKE} />
        </button>
      </div>
    </div>
  );
}
