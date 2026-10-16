import { isAllowedVideoCodec } from './videoCaps.js';
import {
  VIDEO_MAX_DESC_BYTES,
  VIDEO_MAX_FRAGMENT_BYTES,
  VIDEO_MAX_FRAGS,
  VIDEO_MAX_HEIGHT,
  VIDEO_MAX_OPEN_FRAMES,
  VIDEO_MAX_REASSEMBLY_BYTES,
  VIDEO_MAX_WIDTH,
} from './callLimits.js';

export {
  VIDEO_MAX_DESC_BYTES,
  VIDEO_MAX_FRAGMENT_BYTES,
  VIDEO_MAX_FRAGS,
  VIDEO_MAX_HEIGHT,
  VIDEO_MAX_OPEN_FRAMES,
  VIDEO_MAX_REASSEMBLY_BYTES,
  VIDEO_MAX_WIDTH,
};

/** Unvollständige Frames nach 1 s verwerfen. */
export const VIDEO_REASSEMBLY_TTL_MS = 1000;

export function splitVideoFrame(bytes, maxBytes = VIDEO_MAX_FRAGMENT_BYTES) {
  const data = toBytes(bytes);
  const size = Math.max(1, Number(maxBytes) || VIDEO_MAX_FRAGMENT_BYTES);
  if (data.length === 0) return [new Uint8Array(0)];
  const parts = [];
  for (let offset = 0; offset < data.length; offset += size) {
    parts.push(data.subarray(offset, Math.min(data.length, offset + size)));
  }
  return parts;
}

function toFragCount(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > VIDEO_MAX_FRAGS) return 0;
  return n;
}

function toFragIndex(value, frags) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n >= frags) return -1;
  return n;
}

function streamKey(value) {
  return value === 'screen' ? 'screen' : 'camera';
}

function boundedDesc(value) {
  if (value == null) return undefined;
  const bytes = toBytes(value);
  if (!bytes.length || bytes.length > VIDEO_MAX_DESC_BYTES) return null;
  return bytes;
}

function validMeta(msg) {
  if (msg?.codec != null && !isAllowedVideoCodec(msg.codec)) return false;
  const w = msg?.w;
  const h = msg?.h;
  if (w != null || h != null) {
    const width = Number(w);
    const height = Number(h);
    if (!Number.isInteger(width) || !Number.isInteger(height)) return false;
    if (width < 1 || height < 1 || width > VIDEO_MAX_WIDTH || height > VIDEO_MAX_HEIGHT) {
      return false;
    }
  }
  if (msg?.desc != null && boundedDesc(msg.desc) == null) return false;
  return true;
}

/**
 * Setzt Fragmente eines Frames zusammen. Schlüssel ist (stream, Frame-Start-seq),
 * wobei Start-seq = seq - frag. Unvollständige Frames laufen nach ttlMs ab.
 * Gegnergesteuerte Felder (frags, Größe, Codec, desc) sind hart begrenzt.
 */
export function createFrameReassembler({
  ttlMs = VIDEO_REASSEMBLY_TTL_MS,
  now = () => Date.now(),
  maxOpenFrames = VIDEO_MAX_OPEN_FRAMES,
  maxBytes = VIDEO_MAX_REASSEMBLY_BYTES,
} = {}) {
  const pending = new Map();

  function entryBytes(entry) {
    let n = 0;
    if (!entry?.parts) return 0;
    for (const part of entry.parts) n += part?.length || 0;
    return n;
  }

  function totalBytes() {
    let n = 0;
    for (const entry of pending.values()) n += entryBytes(entry);
    return n;
  }

  function streamCount(stream) {
    let n = 0;
    for (const entry of pending.values()) {
      if (entry.stream === stream) n += 1;
    }
    return n;
  }

  function dropOldest(stream) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of pending) {
      if (stream && entry.stream !== stream) continue;
      if (entry.createdAt < oldestAt) {
        oldestAt = entry.createdAt;
        oldestKey = key;
      }
    }
    if (oldestKey != null) pending.delete(oldestKey);
    return oldestKey != null;
  }

  function gc(at) {
    for (const [key, entry] of pending) {
      if (at - entry.createdAt > ttlMs) pending.delete(key);
    }
  }

  function ensureBudget(extraBytes, stream) {
    while (streamCount(stream) >= maxOpenFrames) {
      if (!dropOldest(stream)) break;
    }
    while (totalBytes() + extraBytes > maxBytes) {
      if (!dropOldest()) break;
    }
    return totalBytes() + extraBytes <= maxBytes;
  }

  function push(msg, at = now()) {
    gc(at);
    const frags = toFragCount(msg?.frags ?? 1);
    if (!frags) return null;
    const frag = toFragIndex(msg?.frag ?? 0, frags);
    if (frag < 0) return null;
    if (!validMeta(msg)) return null;
    const payload = toBytes(msg?.data);
    if (!payload.length || payload.length > VIDEO_MAX_FRAGMENT_BYTES) return null;
    if (frags === 1) {
      return complete(msg, payload);
    }
    const startSeq = Number(msg?.seq) - frag;
    if (!Number.isFinite(startSeq)) return null;
    const stream = streamKey(msg?.stream);
    const key = `${stream}:${startSeq}`;
    let entry = pending.get(key);
    if (!entry || entry.frags !== frags) {
      if (!ensureBudget(payload.length, stream)) return null;
      entry = {
        parts: new Array(frags),
        got: 0,
        frags,
        createdAt: at,
        key: Boolean(msg?.key),
        ts: msg?.ts,
        codec: msg?.codec,
        w: msg?.w,
        h: msg?.h,
        stream,
        desc: msg?.desc != null ? boundedDesc(msg.desc) : undefined,
      };
      pending.set(key, entry);
    }
    const previous = entry.parts[frag];
    const delta = payload.length - (previous?.length || 0);
    if (delta > 0 && totalBytes() + delta > maxBytes) return null;
    if (!previous) entry.got += 1;
    entry.parts[frag] = payload;
    if (msg?.key) entry.key = true;
    if (msg?.desc) {
      const desc = boundedDesc(msg.desc);
      if (desc) entry.desc = desc;
    }
    if (entry.got < entry.frags) return null;
    pending.delete(key);
    let total = 0;
    for (const part of entry.parts) total += part?.length || 0;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of entry.parts) {
      if (!part) return null;
      bytes.set(part, offset);
      offset += part.length;
    }
    return complete(entry, bytes);
  }

  return {
    push,
    gc,
    clear() {
      pending.clear();
    },
    get size() {
      return pending.size;
    },
    get bufferedBytes() {
      return totalBytes();
    },
  };
}

function complete(meta, bytes) {
  return {
    bytes,
    key: Boolean(meta?.key),
    ts: meta?.ts,
    codec: meta?.codec,
    w: meta?.w,
    h: meta?.h,
    stream: meta?.stream,
    desc: meta?.desc,
  };
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return new Uint8Array(0);
}
