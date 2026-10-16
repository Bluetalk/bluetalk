/** Anrufer → Angerufener (4 Byte BE im IV). */
export const CALL_DIR_OUT = 0x00000001;
/** Angerufener → Anrufer. */
export const CALL_DIR_IN = 0x00000002;

/**
 * IV für AES-256-GCM der call-audio-Pakete:
 * 4 Byte Richtung || 8 Byte seq (beide Big-Endian) = 12 Byte.
 */
export function buildCallIv(direction, seq) {
  const dir = Number(direction) >>> 0;
  const n = toUint64Parts(seq);
  const iv = new Uint8Array(12);
  const view = new DataView(iv.buffer);
  view.setUint32(0, dir);
  view.setUint32(4, n.hi);
  view.setUint32(8, n.lo);
  return iv;
}

export function parseCallIv(iv) {
  const bytes = iv instanceof Uint8Array ? iv : new Uint8Array(iv || []);
  if (bytes.length !== 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    direction: view.getUint32(0),
    seq: fromUint64Parts(view.getUint32(4), view.getUint32(8)),
  };
}

function toUint64Parts(seq) {
  const value = Number(seq);
  if (!Number.isFinite(value) || value <= 0) return { hi: 0, lo: 0 };
  const floored = Math.floor(value);
  return {
    hi: Math.floor(floored / 0x100000000) >>> 0,
    lo: floored >>> 0,
  };
}

function fromUint64Parts(hi, lo) {
  return hi * 0x100000000 + (lo >>> 0);
}
