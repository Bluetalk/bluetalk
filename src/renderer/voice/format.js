/** Maximale Aufnahmedauer laut Spezifikation. */
export const MAX_VOICE_MS = 5 * 60 * 1000;

/** Zielbitrate für MediaRecorder. */
export const VOICE_BITS_PER_SECOND = 32_000;

export function formatDurationMs(ms) {
  const totalSec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function voiceFileName(date = new Date(), ext = 'webm') {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const safeExt = String(ext || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
  return `Sprachnachricht-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${safeExt}`;
}

export function extForMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

export function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      /* ignore */
    }
  }
  return '';
}
