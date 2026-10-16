import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { b64ToBytes, bytesToB64, bytesToHex, randomBytes, utf8 } from './bytes.js';

export function generateSeed() {
  return randomBytes(32);
}

export function identityFromSeed(seed) {
  const secret = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
  if (secret.length !== 32) throw new Error('identity seed must contain exactly 32 bytes');
  const publicKey = ed25519.getPublicKey(secret);
  return {
    seed: secret,
    publicKey,
    peerId: peerIdForPublicKey(publicKey),
    publicKeyB64: bytesToB64(publicKey),
    seedB64: bytesToB64(secret),
    sign(message) {
      return ed25519.sign(message, secret);
    },
    signRelayAuth(nonce, host) {
      return this.sign(utf8(`bluetalk-relay-auth-v1\n${nonce}\n${host}`));
    },
  };
}

export function generateIdentity() {
  return identityFromSeed(generateSeed());
}

export function peerIdForPublicKey(publicKey) {
  return `bt2_${bytesToHex(sha256(publicKey))}`;
}

export function verifySignature(publicKey, message, signature) {
  try {
    return ed25519.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

export function randomHex(byteLength) {
  return bytesToHex(randomBytes(byteLength));
}

export function decodeB64Array(encoded, expected, label) {
  const value = b64ToBytes(encoded);
  if (value.length !== expected) {
    throw new Error(`invalid ${label} length ${value.length}; expected ${expected}`);
  }
  return value;
}
