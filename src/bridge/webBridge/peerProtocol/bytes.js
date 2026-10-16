const B64_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function concatBytes(...parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function utf8(text) {
  return new TextEncoder().encode(text);
}

export function utf8Decode(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(hex) {
  const value = String(hex || '');
  if (value.length % 2 !== 0) throw new Error('invalid hex');
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex');
    out[i] = byte;
  }
  return out;
}

export function bytesToB64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    out += B64_TABLE[(triple >> 18) & 63];
    out += B64_TABLE[(triple >> 12) & 63];
    out += i + 1 < bytes.length ? B64_TABLE[(triple >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_TABLE[triple & 63] : '=';
  }
  return out;
}

export function b64ToBytes(encoded) {
  const cleaned = String(encoded || '').replace(/\s+/g, '');
  if (!cleaned) return new Uint8Array();
  if (cleaned.length % 4 !== 0) throw new Error('invalid base64');
  const padding = cleaned.endsWith('==') ? 2 : cleaned.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((cleaned.length / 4) * 3 - padding);
  let offset = 0;
  for (let i = 0; i < cleaned.length; i += 4) {
    const n0 = b64Value(cleaned.charCodeAt(i));
    const n1 = b64Value(cleaned.charCodeAt(i + 1));
    const n2 = cleaned[i + 2] === '=' ? 0 : b64Value(cleaned.charCodeAt(i + 2));
    const n3 = cleaned[i + 3] === '=' ? 0 : b64Value(cleaned.charCodeAt(i + 3));
    const triple = (n0 << 18) | (n1 << 12) | (n2 << 6) | n3;
    if (offset < out.length) out[offset++] = (triple >> 16) & 255;
    if (offset < out.length) out[offset++] = (triple >> 8) & 255;
    if (offset < out.length) out[offset++] = triple & 255;
  }
  return out;
}

function b64Value(code) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 71;
  if (code >= 48 && code <= 57) return code + 4;
  if (code === 43) return 62;
  if (code === 47) return 63;
  throw new Error('invalid base64');
}

export function u32Be(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function u64Be(value) {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  const big = BigInt(value);
  view.setUint32(0, Number((big >> 32n) & 0xffffffffn));
  view.setUint32(4, Number(big & 0xffffffffn));
  return out;
}

export function readU32Be(bytes, offset = 0) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
}

export function readU64Be(bytes, offset = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  return (BigInt(view.getUint32(0)) << 32n) | BigInt(view.getUint32(4));
}

export function randomBytes(length) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}
