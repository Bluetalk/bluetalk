/**
 * Globaler Mutex: nur ein Sprachnachrichten-Player spielt gleichzeitig.
 * Kein React-State — die Player rufen stop() des Vorgängers direkt auf.
 */
let current = null;

export function claimVoicePlayback(id, stop) {
  if (!id || typeof stop !== 'function') return;
  if (current && current.id !== id) {
    try {
      current.stop();
    } catch {
      /* ignore */
    }
  }
  current = { id, stop };
}

export function releaseVoicePlayback(id) {
  if (current?.id === id) current = null;
}

export function stopAllVoicePlayback() {
  if (!current) return;
  try {
    current.stop();
  } catch {
    /* ignore */
  }
  current = null;
}
