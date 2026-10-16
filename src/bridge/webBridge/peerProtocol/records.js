import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, equalBytes, u64Be } from './bytes.js';
import { RECORD_AAD_DOMAIN, SESSION_KDF_INFO, TRANSCRIPT_DOMAIN } from './constants.js';

export function ephemeralFromSeed(seed) {
  const secret = seed instanceof Uint8Array ? seed : new Uint8Array(seed);
  if (secret.length !== 32) throw new Error('ephemeral seed must contain exactly 32 bytes');
  return { secret, publicKey: x25519.getPublicKey(secret) };
}

export function generateEphemeral() {
  return ephemeralFromSeed(crypto.getRandomValues(new Uint8Array(32)));
}

export function sharedSecret(secret, peerPublic) {
  const shared = x25519.getSharedSecret(secret, peerPublic);
  if (shared.every((byte) => byte === 0)) {
    throw new Error('invalid low-order X25519 public key');
  }
  return shared;
}

export function transcriptHash(clientBytes, serverBytes) {
  return sha256(
    concatBytes(
      TRANSCRIPT_DOMAIN,
      u64Be(clientBytes.length),
      clientBytes,
      u64Be(serverBytes.length),
      serverBytes,
    ),
  );
}

export function deriveSessionCiphers(shared, transcript, initiator, maxPlaintextBytes) {
  const material = hkdf(sha256, shared, transcript, SESSION_KDF_INFO, 72);
  const initiatorKey = material.slice(0, 32);
  const responderKey = material.slice(32, 64);
  const initiatorPrefix = material.slice(64, 68);
  const responderPrefix = material.slice(68, 72);
  const sendKey = initiator ? initiatorKey : responderKey;
  const receiveKey = initiator ? responderKey : initiatorKey;
  const sendPrefix = initiator ? initiatorPrefix : responderPrefix;
  const receivePrefix = initiator ? responderPrefix : initiatorPrefix;
  return {
    send: new SendCipher(sendKey, sendPrefix, transcript, maxPlaintextBytes),
    receive: new ReceiveCipher(receiveKey, receivePrefix, transcript, maxPlaintextBytes),
    keys: {
      initiatorKey,
      responderKey,
      initiatorPrefix,
      responderPrefix,
    },
  };
}

function makeNonce(prefix, sequence) {
  return concatBytes(prefix, u64Be(sequence));
}

function makeAad(transcript, sequence) {
  return concatBytes(RECORD_AAD_DOMAIN, transcript, u64Be(sequence));
}

export class SendCipher {
  constructor(key, noncePrefix, transcriptHashBytes, maxPlaintextBytes) {
    this.key = key;
    this.noncePrefix = noncePrefix;
    this.transcriptHash = transcriptHashBytes;
    this.maxPlaintextBytes = maxPlaintextBytes;
    this.nextSequence = 0n;
  }

  encrypt(plaintext) {
    if (plaintext.length > this.maxPlaintextBytes) {
      throw new Error(`frame too large: ${plaintext.length} > ${this.maxPlaintextBytes}`);
    }
    if (this.nextSequence === 0xffffffffffffffffn) {
      throw new Error('record sequence exhausted; reconnect required');
    }
    const sequence = this.nextSequence;
    const nonce = makeNonce(this.noncePrefix, sequence);
    const aad = makeAad(this.transcriptHash, sequence);
    const ciphertext = chacha20poly1305(this.key, nonce, aad).encrypt(plaintext);
    this.nextSequence += 1n;
    return concatBytes(u64Be(sequence), ciphertext);
  }
}

export class ReceiveCipher {
  constructor(key, noncePrefix, transcriptHashBytes, maxPlaintextBytes) {
    this.key = key;
    this.noncePrefix = noncePrefix;
    this.transcriptHash = transcriptHashBytes;
    this.maxPlaintextBytes = maxPlaintextBytes;
    this.nextSequence = 0n;
  }

  maximumRecordBytes() {
    return this.maxPlaintextBytes + 8 + 16;
  }

  decrypt(record) {
    if (record.length < 8 + 16) {
      throw new Error('encrypted record is shorter than its header and tag');
    }
    if (record.length > this.maxPlaintextBytes + 8 + 16) {
      throw new Error(`frame too large: ${record.length - 8 - 16} > ${this.maxPlaintextBytes}`);
    }
    const sequence = new DataView(record.buffer, record.byteOffset, 8);
    const seq = (BigInt(sequence.getUint32(0)) << 32n) | BigInt(sequence.getUint32(4));
    if (seq !== this.nextSequence) {
      throw new Error(`unexpected record sequence ${seq}; expected ${this.nextSequence}`);
    }
    const nonce = makeNonce(this.noncePrefix, seq);
    const aad = makeAad(this.transcriptHash, seq);
    const plaintext = chacha20poly1305(this.key, nonce, aad).decrypt(record.subarray(8));
    this.nextSequence += 1n;
    return plaintext;
  }
}

export { equalBytes };
