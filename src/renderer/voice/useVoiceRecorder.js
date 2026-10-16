import { useCallback, useEffect, useRef, useState } from 'react';
import { downsampleWaveform, rmsToBar, WAVEFORM_BARS } from './waveform.js';
import { extForMime, MAX_VOICE_MS, pickRecorderMime, VOICE_BITS_PER_SECOND } from './format.js';

/** Live-Wellenform im Composer ~14 fps statt 60 setState/s. */
const WAVEFORM_UI_MS = 70;

/**
 * Aufnahme via getUserMedia + MediaRecorder, Live-Wellenform aus RMS.
 * Phasen: idle → recording → preview. Esc/discard räumt Streams auf.
 */
export function useVoiceRecorder() {
  const [phase, setPhase] = useState('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [liveWaveform, setLiveWaveform] = useState(() => Array(WAVEFORM_BARS).fill(0));
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);

  const mediaRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const levelsRef = useRef([]);
  const startedAtRef = useRef(0);
  const rafRef = useRef(0);
  const lastWaveformUiRef = useRef(0);
  const timerRef = useRef(0);
  const stopTimerRef = useRef(0);
  const mimeRef = useRef('');

  const cleanupCapture = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = 0;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch { /* ignore */ }
    }
    const stream = mediaRef.current;
    mediaRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    analyserRef.current = null;
    if (ctx) {
      try { void ctx.close(); } catch { /* ignore */ }
    }
  }, []);

  const discardPreview = useCallback(() => {
    setPreview((prev) => {
      if (prev?.objectUrl) {
        try { URL.revokeObjectURL(prev.objectUrl); } catch { /* ignore */ }
      }
      return null;
    });
  }, []);

  const reset = useCallback(() => {
    cleanupCapture();
    discardPreview();
    chunksRef.current = [];
    levelsRef.current = [];
    setPhase('idle');
    setDurationMs(0);
    setLiveWaveform(Array(WAVEFORM_BARS).fill(0));
    setError(null);
  }, [cleanupCapture, discardPreview]);

  useEffect(() => () => reset(), [reset]);

  const tickMeters = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    const bar = rmsToBar(buf);
    levelsRef.current.push(bar);
    if (levelsRef.current.length > 400) levelsRef.current.shift();
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - lastWaveformUiRef.current >= WAVEFORM_UI_MS) {
      lastWaveformUiRef.current = now;
      setLiveWaveform(downsampleWaveform(levelsRef.current, WAVEFORM_BARS));
    }
    rafRef.current = requestAnimationFrame(tickMeters);
  }, []);

  const stopRef = useRef(null);

  const start = useCallback(async () => {
    if (phase !== 'idle') return false;
    setError(null);
    discardPreview();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      mediaRef.current = stream;
      const mime = pickRecorderMime();
      mimeRef.current = mime;
      const recorder = mime
        ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: VOICE_BITS_PER_SECOND })
        : new MediaRecorder(stream, { audioBitsPerSecond: VOICE_BITS_PER_SECOND });
      chunksRef.current = [];
      levelsRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorderRef.current = recorder;

      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.65;
      source.connect(analyser);
      analyserRef.current = analyser;

      startedAtRef.current = Date.now();
      lastWaveformUiRef.current = 0;
      setDurationMs(0);
      setPhase('recording');
      recorder.start(200);
      tickMeters();
      timerRef.current = window.setInterval(() => {
        setDurationMs(Date.now() - startedAtRef.current);
      }, 200);
      stopTimerRef.current = window.setTimeout(() => {
        void stopRef.current?.();
      }, MAX_VOICE_MS);
      return true;
    } catch (err) {
      cleanupCapture();
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      setError(denied ? 'denied' : 'unavailable');
      setPhase('idle');
      return false;
    }
  }, [cleanupCapture, discardPreview, phase, tickMeters]);

  const stop = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || phase !== 'recording') return null;
    const mime = recorder.mimeType || mimeRef.current || 'audio/webm';
    const duration = Math.max(400, Date.now() - startedAtRef.current);
    const waveform = downsampleWaveform(levelsRef.current, WAVEFORM_BARS);

    const blob = await new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: mime }));
      };
      try { recorder.stop(); } catch { resolve(new Blob(chunksRef.current, { type: mime })); }
    });

    cleanupCapture();
    if (!blob.size) {
      setPhase('idle');
      setError('empty');
      return null;
    }
    const objectUrl = URL.createObjectURL(blob);
    const next = {
      blob,
      objectUrl,
      mime,
      durationMs: duration,
      waveform,
      ext: extForMime(mime),
    };
    setPreview(next);
    setDurationMs(duration);
    setLiveWaveform(waveform);
    setPhase('preview');
    return next;
  }, [cleanupCapture, phase]);

  stopRef.current = stop;

  const consumePreview = useCallback(() => {
    const current = preview;
    setPreview(null);
    setPhase('idle');
    setDurationMs(0);
    return current;
  }, [preview]);

  return {
    phase,
    durationMs,
    liveWaveform,
    preview,
    error,
    start,
    stop,
    reset,
    consumePreview,
    recording: phase === 'recording',
    previewing: phase === 'preview',
  };
}
