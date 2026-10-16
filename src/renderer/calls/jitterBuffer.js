/** Paketdauer; Lücken werden höchstens so lange gehalten. */
export const CALL_PACKET_MS = 60;
export { JITTER_TARGET_MS, JITTER_MAX_MS } from './playbackBuffer.js';

/**
 * Seq-Reorder-Puffer: ordnet Pakete, wartet auf eine fehlende seq höchstens
 * ~1 Paketdauer, dann Verlust. Der Sample-Jitterpuffer lebt im Worklet.
 */
export function createJitterBuffer(options = {}) {
  const packetMs = Math.max(1, Number(options.packetMs) || CALL_PACKET_MS);
  const waitMs = Number.isFinite(options.waitMs) ? Math.max(0, options.waitMs) : packetMs;
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now();
  const maxQueued = Math.max(2, Number(options.maxQueued) || 16);

  const queue = [];
  let nextSeq = null;
  let gapSince = null;

  function push(seq, payload) {
    const n = Number(seq);
    if (!Number.isFinite(n) || n < 0) return false;
    if (nextSeq != null && n < nextSeq) return false;
    if (queue.some((item) => item.seq === n)) return false;
    queue.push({ seq: n, payload });
    queue.sort((a, b) => a.seq - b.seq);
    while (queue.length > maxQueued) queue.pop();
    return true;
  }

  function pull(now = nowFn()) {
    if (nextSeq == null) {
      if (!queue.length) return null;
      nextSeq = queue[0].seq;
    }
    const idx = queue.findIndex((item) => item.seq === nextSeq);
    if (idx >= 0) {
      const item = queue.splice(idx, 1)[0];
      const seq = nextSeq;
      nextSeq += 1;
      gapSince = null;
      return { type: 'packet', seq, payload: item.payload };
    }
    const later = queue.length > 0 && queue[0].seq > nextSeq;
    if (!later) return null;
    if (gapSince == null) gapSince = now;
    if (now - gapSince >= waitMs) {
      const lost = nextSeq;
      nextSeq += 1;
      gapSince = null;
      return { type: 'loss', seq: lost };
    }
    return null;
  }

  function msUntilDecision(now = nowFn()) {
    if (nextSeq == null) return 0;
    if (queue.some((item) => item.seq === nextSeq)) return 0;
    const later = queue.length > 0 && queue[0].seq > nextSeq;
    if (!later || gapSince == null) return 0;
    return Math.max(0, waitMs - (now - gapSince));
  }

  function size() {
    return queue.length;
  }

  function reset() {
    queue.length = 0;
    nextSeq = null;
    gapSince = null;
  }

  return {
    push,
    pull,
    msUntilDecision,
    size,
    reset,
    packetMs,
    waitMs,
  };
}
