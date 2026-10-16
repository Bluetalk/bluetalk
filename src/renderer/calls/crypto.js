import { bytesToBase64, base64ToBytes } from '../chatCrypto.js';
import { buildCallIv } from './iv.js';

export async function generateCallKeyB64() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(raw);
}

export async function importCallKey(callKeyB64) {
  const raw = base64ToBytes(callKeyB64);
  if (raw.length !== 32) throw new Error('bad_call_key');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptCallPayload(callKey, frames, direction, seq) {
  const iv = buildCallIv(direction, seq);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, callKey, frames);
  return bytesToBase64(cipher);
}

export async function decryptCallPayload(callKey, dataB64, direction, seq) {
  const iv = buildCallIv(direction, seq);
  const raw = base64ToBytes(dataB64);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, callKey, raw);
  return new Uint8Array(plain);
}
