import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { CHAT_ICON_STROKE, getFileBlobUrl } from '../pages/chats/messageHelpers.jsx';
import { formatDurationMs } from './format.js';
import { claimVoicePlayback, releaseVoicePlayback } from './playbackController.js';
import { isVoiceMessage, sanitizeVoiceMeta } from './voiceMeta.js';
import { WAVEFORM_BARS } from './waveform.js';

const RATES = [1, 1.5, 2];

export function VoicePlayer({ message }) {
  const meta = sanitizeVoiceMeta(message?.voice) || { durationMs: 0, waveform: Array(WAVEFORM_BARS).fill(8), mime: '' };
  const src = getFileBlobUrl(message);
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const idRef = useRef(message?.messageId || `voice-${Math.random().toString(36).slice(2)}`);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) {
      el.pause();
    }
    setPlaying(false);
    releaseVoicePlayback(idRef.current);
  }, []);

  useEffect(() => () => {
    stop();
  }, [stop]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !src) return undefined;
    let cancelled = false;
    const restoreStart = () => {
      if (!cancelled && el.currentTime > 1) el.currentTime = 0;
    };
    const probeDuration = () => {
      if (cancelled) return;
      if (Number.isFinite(el.duration) && el.duration > 0 && el.duration !== Infinity) return;
      const onDur = () => {
        el.removeEventListener('durationchange', onDur);
        restoreStart();
      };
      el.addEventListener('durationchange', onDur);
      try {
        el.currentTime = 1e10;
      } catch {
        el.removeEventListener('durationchange', onDur);
      }
    };
    el.addEventListener('loadedmetadata', probeDuration);
    if (el.readyState >= 1) probeDuration();
    return () => {
      cancelled = true;
      el.removeEventListener('loadedmetadata', probeDuration);
    };
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;
    const onTime = () => {
      const dur = meta.durationMs || 0;
      const t = el.currentTime * 1000;
      setCurrentMs(t);
      setProgress(dur > 0 ? Math.min(1, t / dur) : 0);
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(1);
      releaseVoicePlayback(idRef.current);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('pause', () => {
      if (el.ended) return;
      setPlaying(false);
    });
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
    };
  }, [meta.durationMs, src]);

  const toggle = () => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      releaseVoicePlayback(idRef.current);
      return;
    }
    claimVoicePlayback(idRef.current, stop);
    el.playbackRate = RATES[rateIndex];
    void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
  };

  const seekFromClientX = (clientX, target) => {
    const el = audioRef.current;
    if (!el || !src) return;
    const rect = target.getBoundingClientRect();
    const ratio = rect.width <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dur = (meta.durationMs || 0) / 1000;
    el.currentTime = ratio * dur;
    setProgress(ratio);
    setCurrentMs(ratio * dur * 1000);
  };

  const onWavePointer = (event) => {
    event.preventDefault();
    const target = event.currentTarget;
    seekFromClientX(event.clientX, target);
    const move = (ev) => seekFromClientX(ev.clientX, target);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const cycleRate = () => {
    const next = (rateIndex + 1) % RATES.length;
    setRateIndex(next);
    if (audioRef.current) audioRef.current.playbackRate = RATES[next];
  };

  const remaining = Math.max(0, (meta.durationMs || 0) - currentMs);
  const timeLabel = playing || progress > 0
    ? formatDurationMs(remaining)
    : formatDurationMs(meta.durationMs);

  return (
    <div className="voice-player">
      <audio ref={audioRef} src={src || undefined} preload="metadata" />
      <button
        type="button"
        className="voice-player-toggle"
        onClick={toggle}
        disabled={!src}
        aria-label={playing ? 'Pause' : 'Abspielen'}
        title={playing ? 'Pause' : 'Abspielen'}
      >
        {playing ? (
          <Pause size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        ) : (
          <Play size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        )}
      </button>
      <div
        className="voice-waveform"
        role="slider"
        aria-label="Wiedergabeposition"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        tabIndex={0}
        onPointerDown={onWavePointer}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const el = audioRef.current;
          if (!el) return;
          el.currentTime = Math.max(0, el.currentTime + (event.key === 'ArrowRight' ? 1 : -1));
        }}
      >
        {meta.waveform.map((level, i) => {
          const filled = i / meta.waveform.length <= progress;
          const h = 4 + (level / 255) * 18;
          return (
            <span
              key={i}
              className={`voice-waveform-bar${filled ? ' is-played' : ''}`}
              style={{ height: `${h}px` }}
            />
          );
        })}
      </div>
      <span className="voice-player-time">{timeLabel}</span>
      <button
        type="button"
        className="voice-player-rate"
        onClick={cycleRate}
        title="Wiedergabegeschwindigkeit"
      >
        {RATES[rateIndex].toLocaleString('de-DE')}×
      </button>
    </div>
  );
}

export function maybeVoicePlayer(message) {
  return isVoiceMessage(message) ? <VoicePlayer message={message} /> : null;
}
