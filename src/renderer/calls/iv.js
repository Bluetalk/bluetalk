/** Anrufer → Angerufener (4 Byte BE im IV). */
export const CALL_DIR_OUT = 0x00000001;
/** Angerufener → Anrufer. */
export const CALL_DIR_IN = 0x00000002;

/** Kamera Anrufer → Angerufener (getrennter IV-Raum, nie mit Audio mischen). */
export const CALL_IV_CAM_OUT = 0x00000011;
/** Kamera Angerufener → Anrufer. */
export const CALL_IV_CAM_IN = 0x00000012;
/** Bildschirm Anrufer → Angerufener. */
export const CALL_IV_SCREEN_OUT = 0x00000021;
/** Bildschirm Angerufener → Anrufer. */
export const CALL_IV_SCREEN_IN = 0x00000022;

/**
 * IV-Richtung für Video: 0x11/0x12 Kamera, 0x21/0x22 Bildschirm.
 * `sending` = wir kodieren; sonst Empfang.
 */
export function callVideoIvDirection(stream, role, sending) {
  const isCaller = role === 'caller';
  const callerToCallee = sending ? isCaller : !isCaller;
  if (stream === 'screen') return callerToCallee ? CALL_IV_SCREEN_OUT : CALL_IV_SCREEN_IN;
  return callerToCallee ? CALL_IV_CAM_OUT : CALL_IV_CAM_IN;
}

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
