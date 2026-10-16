import { downsampleWaveform, WAVEFORM_BARS } from './waveform.js';
import { formatDurationMs, MAX_VOICE_MS } from './format.js';

/**
 * Prüft, ob eine Datei-Nachricht als Sprachnachricht gerendert werden soll.
 * Alte Clients ohne `voice` bleiben bei der generischen Audio-Datei.
 */
export function isVoiceMessage(message) {
  if (!message || message.kind !== 'file') return false;
  return Boolean(sanitizeVoiceMeta(message.voice));
}

export function voicePreviewText(message) {
  const meta = sanitizeVoiceMeta(message?.voice);
  const duration = formatDurationMs(meta?.durationMs || 0);
  return `🎤 Sprachnachricht (${duration})`;
}

/**
 * Normalisiert eingehende/ausgehende `voice`-Metadaten.
 * Ungültige Objekte werden verworfen (Nachricht bleibt eine normale Datei).
 */
export function sanitizeVoiceMeta(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const durationMs = Math.round(Number(raw.durationMs) || 0);
  if (durationMs <= 0 || durationMs > MAX_VOICE_MS + 15_000) return null;
  const mime = String(raw.mime || '').trim().slice(0, 80);
  const waveform = downsampleWaveform(
    Array.isArray(raw.waveform) ? raw.waveform : [],
    WAVEFORM_BARS,
  );
  return { durationMs, waveform, mime };
}
