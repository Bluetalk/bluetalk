const E2EE_INFO = new TextEncoder().encode('bluetalk-chat-e2ee-v1');
const E2EE_SALT = new TextEncoder().encode('bluetalk-e2ee-salt-v1');

function e2eeAdditionalData(keyId) {
  return new TextEncoder().encode(`bluetalk-chat-e2ee-v2:${keyId}`);
}

export function bytesToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importAesKeyFromRawB64(b64) {
  const raw = base64ToBytes(b64);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function exportAesKeyToB64(aesKey) {
  const raw = await crypto.subtle.exportKey('raw', aesKey);
  return bytesToBase64(raw);
}

async function deriveAesFromSharedSecret(sharedBits) {
  const base = await crypto.subtle.importKey('raw', sharedBits, { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', salt: E2EE_SALT, info: E2EE_INFO, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function generateEcdhKeyPair() {
  return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}

export async function exportSpkiPublic(key) {
  const spki = await crypto.subtle.exportKey('spki', key);
  return bytesToBase64(spki);
}

export async function importPeerPublicFromSpki(b64) {
  const raw = base64ToBytes(b64);
  return crypto.subtle.importKey('spki', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function deriveSharedAesKey(privateKey, peerPublicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPublicKey },
    privateKey,
    256
  );
  return deriveAesFromSharedSecret(bits);
}

export async function computeE2eeKeyId(ownPublicSpkiB64, peerPublicSpkiB64) {
  const ordered = [String(ownPublicSpkiB64 || ''), String(peerPublicSpkiB64 || '')].sort();
  if (!ordered[0] || !ordered[1]) throw new Error('missing_public_key');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${ordered[0]}\u0000${ordered[1]}`)
  );
  return bytesToBase64(new Uint8Array(digest).subarray(0, 18));
}

export async function encryptChatPayload(aesKey, plainObject, options = {}) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(plainObject));
  const version = options.version === 1 ? 1 : 2;
  const keyId = String(options.keyId || '');
  if (version === 2 && !keyId) throw new Error('missing_key_id');
  const algorithm = { name: 'AES-GCM', iv };
  if (version === 2) algorithm.additionalData = e2eeAdditionalData(keyId);
  const cipher = await crypto.subtle.encrypt(algorithm, aesKey, data);
  const envelope = {
    kind: 'encrypted-chat-e2ee',
    e2eeV: version,
    iv: bytesToBase64(iv),
    data: bytesToBase64(cipher),
  };
  if (version === 2) envelope.keyId = keyId;
  return envelope;
}

export async function decryptChatPayload(aesKey, envelope, options = {}) {
  if (!envelope || envelope.kind !== 'encrypted-chat-e2ee' || !envelope.iv || !envelope.data) {
    throw new Error('invalid_envelope');
  }
  const version = Number(envelope.e2eeV || 1);
  if (version !== 1 && version !== 2) throw new Error('unsupported_e2ee_version');
  const iv = base64ToBytes(envelope.iv);
  if (iv.length !== 12) throw new Error('invalid_iv');
  const cipher = base64ToBytes(envelope.data);
  const algorithm = { name: 'AES-GCM', iv };
  if (version === 2) {
    const keyId = String(envelope.keyId || '');
    if (!keyId || (options.keyId && options.keyId !== keyId)) throw new Error('wrong_key_id');
    algorithm.additionalData = e2eeAdditionalData(keyId);
  }
  const plain = await crypto.subtle.decrypt(algorithm, aesKey, cipher);
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text);
}
