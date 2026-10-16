/** 20-ms-Opus-Frame; drei Stück ergeben ein 60-ms-Paket. */
export const OPUS_FRAME_MS = 20;
export const CALL_PACKET_MS = 60;
/** Gegnergesteuerte packed Frames: höchstens so viele und so groß. */
export const AUDIO_MAX_PACKED_FRAMES = 8;
export const AUDIO_MAX_PACKED_FRAME_BYTES = 4 * 1024;

/**
 * Monotone Decode-Zeit in Mikrosekunden: seq * 60 ms + Frame-Index * 20 ms.
 */
export function opusFrameTimestampUs(seq, frameIndex) {
  const s = Math.max(0, Number(seq) || 0);
  const i = Math.max(0, Number(frameIndex) || 0);
  return (s * CALL_PACKET_MS + i * OPUS_FRAME_MS) * 1000;
}

/**
 * Opus-Frames: `[u16 BE len][bytes]` × n.
 * pcm16 wird als Rohblock ohne Längenpräfix übertragen.
 */
export function packLengthPrefixedFrames(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  let total = 0;
  const parts = [];
  for (const chunk of list) {
    const bytes = toBytes(chunk);
    if (bytes.length > 0xffff) throw new Error('frame_too_long');
    total += 2 + bytes.length;
    parts.push(bytes);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const bytes of parts) {
    out[offset] = (bytes.length >> 8) & 0xff;
    out[offset + 1] = bytes.length & 0xff;
    out.set(bytes, offset + 2);
    offset += 2 + bytes.length;
  }
  return out;
}

export function unpackLengthPrefixedFrames(packed, options = {}) {
  const bytes = toBytes(packed);
  const maxFrames = Math.max(1, Number(options.maxFrames) || AUDIO_MAX_PACKED_FRAMES);
  const maxFrameBytes = Math.max(1, Number(options.maxFrameBytes) || AUDIO_MAX_PACKED_FRAME_BYTES);
  const frames = [];
  let offset = 0;
  while (offset + 2 <= bytes.length && frames.length < maxFrames) {
    const len = (bytes[offset] << 8) | bytes[offset + 1];
    offset += 2;
    if (len > maxFrameBytes || offset + len > bytes.length) break;
    frames.push(bytes.subarray(offset, offset + len));
    offset += len;
  }
  return frames;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}
