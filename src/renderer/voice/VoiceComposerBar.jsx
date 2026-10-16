import React, { useEffect } from 'react';
import { Mic, SendHorizontal, Square, Trash2 } from 'lucide-react';
import { CHAT_ICON_STROKE } from '../pages/chats/messageHelpers.jsx';
import { formatDurationMs } from './format.js';
import { VoicePlayer } from './VoicePlayer.jsx';

export function VoiceComposerBar({
  phase,
  durationMs,
  liveWaveform,
  preview,
  onStop,
  onDiscard,
  onSend,
  sending = false,
}) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDiscard();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDiscard]);

  if (phase === 'preview' && preview) {
    return (
      <div className="voice-composer" role="region" aria-label="Sprachnachricht-Vorschau">
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onDiscard}
          disabled={sending}
          title="Verwerfen"
          aria-label="Aufnahme verwerfen"
        >
          <Trash2 size={16} strokeWidth={CHAT_ICON_STROKE} />
        </button>
        <div className="voice-composer-preview">
          <VoicePlayer
            message={{
              kind: 'file',
              fileType: preview.mime,
              fileData: '',
              localPreviewUrl: preview.objectUrl,
              voice: {
                durationMs: preview.durationMs,
                waveform: preview.waveform,
                mime: preview.mime,
              },
            }}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary btn-icon chat-send-btn"
          onClick={onSend}
          disabled={sending}
          title="Sprachnachricht senden"
          aria-label="Sprachnachricht senden"
          style={{ height: 32, width: 32 }}
        >
          <SendHorizontal size={17} strokeWidth={CHAT_ICON_STROKE} />
        </button>
      </div>
    );
  }

  return (
    <div className="voice-composer voice-composer--recording" role="region" aria-label="Aufnahme">
      <button
        type="button"
        className="btn btn-ghost btn-icon"
        onClick={onDiscard}
        title="Verwerfen"
        aria-label="Aufnahme verwerfen"
      >
        <Trash2 size={16} strokeWidth={CHAT_ICON_STROKE} />
      </button>
      <span className="voice-rec-dot" aria-hidden />
      <span className="voice-rec-time">{formatDurationMs(durationMs)}</span>
      <div className="voice-waveform voice-waveform--live" aria-hidden>
        {(liveWaveform || []).map((level, i) => (
          <span
            key={i}
            className="voice-waveform-bar is-live"
            style={{ height: `${4 + (level / 255) * 18}px` }}
          />
        ))}
      </div>
      <button
        type="button"
        className="btn btn-primary btn-icon"
        onClick={onStop}
        title="Aufnahme stoppen"
        aria-label="Aufnahme stoppen"
        style={{ height: 32, width: 32 }}
      >
        <Square size={14} strokeWidth={CHAT_ICON_STROKE} />
      </button>
    </div>
  );
}

export function MicSendButton({ showMic, disabled, onMic, onSend, showStop, onStop, sendBurst, title }) {
  return (
    <button
      className={`btn btn-primary btn-icon chat-send-btn${sendBurst ? ' is-sending' : ''}${showMic ? ' chat-send-btn--mic' : ''}`}
      onClick={showStop ? onStop : showMic ? onMic : onSend}
      disabled={disabled}
      style={{ height: 32, width: 32 }}
      title={title}
      type="button"
    >
      {showStop ? (
        <Square size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      ) : showMic ? (
        <Mic size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      ) : (
        <SendHorizontal size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      )}
    </button>
  );
}
