/**
 * Grenzen für eingehende Anruf-Felder. Werte kommen vom Gegenüber und
 * dürfen weder Speicher noch Decoder unbeschränkt aufblasen.
 */
import { isAllowedVideoCodec, normalizeCapabilityList } from './videoCaps.js';

export const CALL_ID_MAX_LEN = 128;
export const CALL_REASON_MAX_LEN = 64;
export const CALL_DEVICE_KEY_MAX_LEN = 256;
export const CALL_SENDER_MAX_LEN = 128;
export const CALL_MAX_CODECS = 8;
export const CALL_MAX_CODEC_LEN = 32;
export const CALL_KEY_B64_MAX_LEN = 64;

export const AUDIO_MAX_PACKET_BYTES = 8 * 1024;
export const AUDIO_GCM_OVERHEAD = 16;
export const AUDIO_MAX_PACKET_B64 = Math.ceil((AUDIO_MAX_PACKET_BYTES + AUDIO_GCM_OVERHEAD) * 4 / 3) + 8;

/** Klartext eines Video-Fragments laut VIDEO.md. */
export const VIDEO_MAX_FRAGMENT_BYTES = 24 * 1024;
/** GCM-Tag plus kleiner Spielraum. */
export const VIDEO_FRAGMENT_OVERHEAD = 64;
export const VIDEO_MAX_CIPHER_BYTES = VIDEO_MAX_FRAGMENT_BYTES + VIDEO_FRAGMENT_OVERHEAD;
export const VIDEO_MAX_PACKET_B64 = Math.ceil(VIDEO_MAX_CIPHER_BYTES * 4 / 3) + 8;
export const VIDEO_MAX_FRAGS = 64;
export const VIDEO_MAX_OPEN_FRAMES = 8;
export const VIDEO_MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024;
export const VIDEO_MAX_WIDTH = 3840;
export const VIDEO_MAX_HEIGHT = 2160;
export const VIDEO_MAX_DESC_BYTES = 8 * 1024;
export const VIDEO_MAX_DESC_B64 = Math.ceil(VIDEO_MAX_DESC_BYTES * 4 / 3) + 8;

export const CALL_SIGNAL_OPS = new Set([
  'ringing',
  'accept',
  'reject',
  'busy',
  'cancel',
  'end',
  'video-on',
  'video-off',
  'screen-on',
  'screen-off',
  'keyframe',
  'ping',
  'pong',
]);

export const CALL_AUDIO_CODECS = new Set(['opus', 'pcm16']);
export const CALL_VIDEO_STREAMS = new Set(['camera', 'screen']);

export function boundedString(value, maxLen) {
  if (typeof value !== 'string') return '';
  if (!value || value.length > maxLen) return '';
  return value;
}

export function isSafeSeq(seq) {
  const n = Number(seq);
  return Number.isSafeInteger(n) && n >= 0;
}

export function isPlausibleVideoSize(width, height) {
  if (width == null && height == null) return true;
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h)) return false;
  if (w < 1 || h < 1) return false;
  return w <= VIDEO_MAX_WIDTH && h <= VIDEO_MAX_HEIGHT;
}

export function payloadByteLength(data) {
  if (typeof data === 'string') return Math.ceil(data.length * 3 / 4);
  if (data instanceof Uint8Array) return data.length;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

export function payloadWithin(data, maxBytes, maxB64) {
  if (typeof data === 'string') {
    return data.length > 0 && data.length <= maxB64;
  }
  const n = payloadByteLength(data);
  return n > 0 && n <= maxBytes;
}

function sanitizeCapabilities(raw) {
  if (!raw || typeof raw !== 'object') return { video: [], screen: false };
  const video = normalizeCapabilityList(
    Array.isArray(raw.video) ? raw.video.slice(0, CALL_MAX_CODECS) : [],
  );
  return { video, screen: raw.screen === true && video.length > 0 };
}

function sanitizeCodecList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list.slice(0, CALL_MAX_CODECS) : []) {
    const value = String(item || '');
    if (!value || value.length > CALL_MAX_CODEC_LEN) continue;
    if (!CALL_AUDIO_CODECS.has(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * Nur bekannte, größenbegrenzte call-signal-Felder. Unbekannte ops und
 * überlange Strings werden verworfen.
 */
export function sanitizeCallSignal(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const op = typeof msg.op === 'string' ? msg.op : '';
  if (!CALL_SIGNAL_OPS.has(op)) return null;
  const callId = boundedString(msg.callId, CALL_ID_MAX_LEN);
  if (!callId) return null;
  const out = { kind: 'call-signal', op, callId };
  const fromDevice = boundedString(msg.fromDevice, CALL_DEVICE_KEY_MAX_LEN);
  if (fromDevice) out.fromDevice = fromDevice;
  if (op === 'accept') {
    const codec = typeof msg.codec === 'string' ? msg.codec : '';
    if (codec && codec.length <= CALL_MAX_CODEC_LEN && CALL_AUDIO_CODECS.has(codec)) {
      out.codec = codec;
    }
  }
  if (op === 'cancel') {
    const reason = boundedString(msg.reason, CALL_REASON_MAX_LEN);
    if (reason) out.reason = reason;
  }
  if (op === 'ping' || op === 'pong') {
    const t = Number(msg.t);
    if (Number.isFinite(t) && Math.abs(t) <= Number.MAX_SAFE_INTEGER) out.t = t;
  }
  if (op === 'video-on' || op === 'video-off' || op === 'screen-on' || op === 'screen-off' || op === 'keyframe') {
    out.stream = msg.stream === 'screen' ? 'screen' : 'camera';
  }
  if (op === 'ringing' || op === 'accept') {
    if (msg.capabilities && typeof msg.capabilities === 'object') {
      out.capabilities = sanitizeCapabilities(msg.capabilities);
    }
  }
  return out;
}

export function sanitizeCallOffer(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const callId = boundedString(msg.callId, CALL_ID_MAX_LEN);
  const callKeyB64 = boundedString(msg.callKeyB64, CALL_KEY_B64_MAX_LEN);
  if (!callId || !callKeyB64) return null;
  const out = {
    kind: 'call-offer',
    callId,
    callKeyB64,
    codecs: sanitizeCodecList(msg.codecs),
    media: { video: msg.media?.video === true },
    capabilities: sanitizeCapabilities(msg.capabilities),
  };
  const ts = Number(msg.timestamp);
  if (Number.isFinite(ts) && ts >= 0) out.timestamp = ts;
  const sender = boundedString(msg.sender, CALL_SENDER_MAX_LEN);
  if (sender) out.sender = sender;
  const fromDevice = boundedString(msg.fromDevice, CALL_DEVICE_KEY_MAX_LEN);
  if (fromDevice) out.fromDevice = fromDevice;
  return out;
}

export function sanitizeCallAudio(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const callId = boundedString(msg.callId, CALL_ID_MAX_LEN);
  if (!callId || !isSafeSeq(msg.seq)) return null;
  if (!payloadWithin(msg.data, AUDIO_MAX_PACKET_BYTES + AUDIO_GCM_OVERHEAD, AUDIO_MAX_PACKET_B64)) {
    return null;
  }
  const out = {
    kind: 'call-audio',
    callId,
    seq: Number(msg.seq),
    data: msg.data,
  };
  const fromDevice = boundedString(msg.fromDevice, CALL_DEVICE_KEY_MAX_LEN);
  if (fromDevice) out.fromDevice = fromDevice;
  return out;
}

export function sanitizeCallVideo(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const callId = boundedString(msg.callId, CALL_ID_MAX_LEN);
  if (!callId || !isSafeSeq(msg.seq)) return null;
  const frags = Number(msg.frags);
  const frag = Number(msg.frag);
  if (!Number.isInteger(frags) || frags < 1 || frags > VIDEO_MAX_FRAGS) return null;
  if (!Number.isInteger(frag) || frag < 0 || frag >= frags) return null;
  if (!payloadWithin(msg.data, VIDEO_MAX_CIPHER_BYTES, VIDEO_MAX_PACKET_B64)) return null;
  if (msg.codec != null && !isAllowedVideoCodec(msg.codec)) return null;
  if (String(msg.codec || '').length > CALL_MAX_CODEC_LEN) return null;
  if (!isPlausibleVideoSize(msg.w, msg.h)) return null;
  if (msg.desc != null) {
    if (typeof msg.desc === 'string') {
      if (msg.desc.length > VIDEO_MAX_DESC_B64) return null;
    } else if (payloadByteLength(msg.desc) > VIDEO_MAX_DESC_BYTES) {
      return null;
    }
  }
  const stream = msg.stream === 'screen' ? 'screen' : 'camera';
  const out = {
    kind: 'call-video',
    callId,
    stream,
    seq: Number(msg.seq),
    frag,
    frags,
    key: msg.key === true,
    data: msg.data,
  };
  if (msg.codec != null) out.codec = String(msg.codec);
  if (Number.isInteger(Number(msg.w))) out.w = Number(msg.w);
  if (Number.isInteger(Number(msg.h))) out.h = Number(msg.h);
  if (Number.isFinite(Number(msg.ts))) out.ts = Number(msg.ts);
  if (msg.desc != null) out.desc = msg.desc;
  const fromDevice = boundedString(msg.fromDevice, CALL_DEVICE_KEY_MAX_LEN);
  if (fromDevice) out.fromDevice = fromDevice;
  return out;
}
