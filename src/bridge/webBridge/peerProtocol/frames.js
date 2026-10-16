import { utf8, utf8Decode, u32Be, readU32Be } from './bytes.js';

export function encodePrefixed(bytes, maximum) {
  if (bytes.length > maximum || bytes.length > 0xffffffff) {
    throw new Error(`frame too large: ${bytes.length} > ${maximum}`);
  }
  const out = new Uint8Array(4 + bytes.length);
  out.set(u32Be(bytes.length), 0);
  out.set(bytes, 4);
  return out;
}

export function tryReadPrefixed(buffer, maximum) {
  if (buffer.length < 4) return null;
  const length = readU32Be(buffer, 0);
  if (length > maximum) {
    throw new Error(`frame too large: ${length} > ${maximum}`);
  }
  if (buffer.length < 4 + length) return null;
  return {
    frame: buffer.subarray(4, 4 + length),
    rest: buffer.subarray(4 + length),
  };
}

export class ByteAssembler {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    const next = new Uint8Array(this.buffer.length + chunk.length);
    next.set(this.buffer, 0);
    next.set(chunk, this.buffer.length);
    this.buffer = next;
  }

  nextFrame(maximum) {
    const parsed = tryReadPrefixed(this.buffer, maximum);
    if (!parsed) return null;
    this.buffer = parsed.rest.length ? parsed.rest.slice() : new Uint8Array(0);
    return parsed.frame;
  }
}

export function encodeWireFrame(frame, maximum) {
  const bytes = utf8(JSON.stringify(wireFrameJson(frame)));
  if (bytes.length > maximum) {
    throw new Error(`frame too large: ${bytes.length} > ${maximum}`);
  }
  return bytes;
}

export function decodeWireFrame(bytes, maximum) {
  if (bytes.length > maximum) {
    throw new Error(`frame too large: ${bytes.length} > ${maximum}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(utf8Decode(bytes));
  } catch (error) {
    throw new Error(`invalid wire frame: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
    throw new Error('invalid wire frame: missing type');
  }
  if (parsed.type === 'message') {
    const messageId = parsed.message_id ?? parsed.messageId;
    const sentAtMs = parsed.sent_at_ms ?? parsed.sentAtMs;
    if (String(messageId || '').length > 128) {
      throw new Error('message id exceeds 128 bytes');
    }
    return {
      type: 'message',
      messageId,
      sentAtMs,
      payload: parsed.payload,
    };
  }
  if (parsed.type === 'ping' || parsed.type === 'pong') {
    if (String(parsed.nonce || '').length > 128) {
      throw new Error('heartbeat nonce exceeds 128 bytes');
    }
    return { type: parsed.type, nonce: parsed.nonce };
  }
  if (parsed.type === 'close') {
    if (String(parsed.reason || '').length > 512) {
      throw new Error('close reason exceeds 512 bytes');
    }
    return { type: 'close', reason: parsed.reason };
  }
  throw new Error('invalid wire frame: unknown type');
}

function wireFrameJson(frame) {
  if (frame.type === 'message') {
    return {
      type: 'message',
      message_id: frame.messageId ?? frame.message_id,
      sent_at_ms: frame.sentAtMs ?? frame.sent_at_ms,
      payload: frame.payload,
    };
  }
  if (frame.type === 'ping' || frame.type === 'pong') {
    return { type: frame.type, nonce: frame.nonce };
  }
  if (frame.type === 'close') {
    return { type: 'close', reason: frame.reason };
  }
  throw new Error('invalid wire frame');
}
