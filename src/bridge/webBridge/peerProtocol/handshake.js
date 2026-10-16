import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToB64, bytesToHex, concatBytes, utf8, utf8Decode } from './bytes.js';
import {
  CLIENT_SIGNATURE_DOMAIN,
  HANDSHAKE_ENVELOPE_VERSION,
  HANDSHAKE_MAGIC,
  MAX_HANDSHAKE_BYTES,
  MAX_HANDSHAKE_CLOCK_SKEW_MS,
  PROTOCOL_VERSION,
  SERVER_SIGNATURE_DOMAIN,
} from './constants.js';
import { decodeB64Array, peerIdForPublicKey, randomHex, verifySignature } from './identity.js';
import {
  deriveSessionCiphers,
  ephemeralFromSeed,
  generateEphemeral,
  sharedSecret,
  transcriptHash,
} from './records.js';
import { ByteAssembler, encodePrefixed } from './frames.js';

export function unixTimeMs() {
  return Date.now();
}

export function makeClientHello(identity, displayName, timestampMs, nonceHex, ephemeralPublic) {
  const hello = {
    magic: HANDSHAKE_MAGIC,
    envelopeVersion: HANDSHAKE_ENVELOPE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    timestampMs,
    nonce: nonceHex,
    identityKey: identity.publicKeyB64,
    ephemeralKey: bytesToB64(ephemeralPublic),
    displayName,
    signature: '',
  };
  hello.signature = bytesToB64(identity.sign(clientSignatureInput(hello)));
  return hello;
}

export function makeServerHello(identity, displayName, clientBytes, timestampMs, nonceHex, ephemeralPublic) {
  const hello = {
    magic: HANDSHAKE_MAGIC,
    envelopeVersion: HANDSHAKE_ENVELOPE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    timestampMs,
    nonce: nonceHex,
    identityKey: identity.publicKeyB64,
    ephemeralKey: bytesToB64(ephemeralPublic),
    displayName,
    clientHelloHash: bytesToHex(sha256(clientBytes)),
    signature: '',
  };
  hello.signature = bytesToB64(identity.sign(serverSignatureInput(hello)));
  return hello;
}

export function clientHelloBytes(hello) {
  return utf8(JSON.stringify(hello));
}

export function serverHelloBytes(hello) {
  return utf8(JSON.stringify(hello));
}

function clientSignatureInput(hello) {
  const body = {
    magic: hello.magic,
    envelopeVersion: hello.envelopeVersion,
    protocolVersion: hello.protocolVersion,
    timestampMs: hello.timestampMs,
    nonce: hello.nonce,
    identityKey: hello.identityKey,
    ephemeralKey: hello.ephemeralKey,
    displayName: hello.displayName,
  };
  return concatBytes(CLIENT_SIGNATURE_DOMAIN, utf8(JSON.stringify(body)));
}

function serverSignatureInput(hello) {
  const body = {
    magic: hello.magic,
    envelopeVersion: hello.envelopeVersion,
    protocolVersion: hello.protocolVersion,
    timestampMs: hello.timestampMs,
    nonce: hello.nonce,
    identityKey: hello.identityKey,
    ephemeralKey: hello.ephemeralKey,
    displayName: hello.displayName,
    clientHelloHash: hello.clientHelloHash,
  };
  return concatBytes(SERVER_SIGNATURE_DOMAIN, utf8(JSON.stringify(body)));
}

function validateDisplayName(displayName) {
  const bytes = utf8(displayName);
  if (bytes.length === 0 || bytes.length > 128) {
    throw new Error('display name must contain 1..=128 UTF-8 bytes');
  }
}

function validateCommonHello(hello, checkClock) {
  if (hello.magic !== HANDSHAKE_MAGIC) throw new Error('incorrect protocol magic');
  if (hello.envelopeVersion !== HANDSHAKE_ENVELOPE_VERSION) {
    throw new Error(`unsupported handshake envelope ${hello.envelopeVersion}`);
  }
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${hello.protocolVersion}`);
  }
  if (checkClock) {
    const delta = Math.abs(unixTimeMs() - Number(hello.timestampMs));
    if (delta > MAX_HANDSHAKE_CLOCK_SKEW_MS) {
      throw new Error('handshake timestamp is outside the permitted clock skew');
    }
  }
  const nonce = String(hello.nonce || '');
  if (nonce.length !== 64 || hexToLen(nonce) !== 32) {
    throw new Error('handshake nonce must be 32 random bytes');
  }
  validateDisplayName(hello.displayName);
}

function hexToLen(hex) {
  try {
    if (hex.length % 2 !== 0) return -1;
    for (let i = 0; i < hex.length; i += 1) {
      if (Number.isNaN(Number.parseInt(hex[i], 16))) return -1;
    }
    return hex.length / 2;
  } catch {
    return -1;
  }
}

function parseHello(bytes, label) {
  try {
    return JSON.parse(utf8Decode(bytes));
  } catch (error) {
    throw new Error(`invalid ${label}: ${error.message}`);
  }
}

export function establishFromHellos(clientBytes, serverBytes, localSecret, initiator, maxFrameBytes) {
  const client = parseHello(clientBytes, 'client hello');
  const server = parseHello(serverBytes, 'server hello');
  const remoteHello = initiator ? server : client;
  const remoteIdentity = decodeB64Array(remoteHello.identityKey, 32, initiator ? 'server identity key' : 'client identity key');
  const remoteEph = decodeB64Array(remoteHello.ephemeralKey, 32, initiator ? 'server ephemeral key' : 'client ephemeral key');
  const shared = sharedSecret(localSecret, remoteEph);
  const transcript = transcriptHash(clientBytes, serverBytes);
  const ciphers = deriveSessionCiphers(shared, transcript, initiator, maxFrameBytes);
  return {
    remotePeerId: peerIdForPublicKey(remoteIdentity),
    remoteDisplayName: remoteHello.displayName,
    connectionId: bytesToHex(transcript.subarray(0, 16)),
    transcriptHash: transcript,
    send: ciphers.send,
    receive: ciphers.receive,
    keys: ciphers.keys,
  };
}

export async function initiatorHandshake(transport, identity, displayName, expectedPeerId, maxFrameBytes, secrets) {
  validateDisplayName(displayName);
  const eph = secrets?.ephemeralSeed ? ephemeralFromSeed(secrets.ephemeralSeed) : generateEphemeral();
  const hello = makeClientHello(
    identity,
    displayName,
    secrets?.timestampMs ?? unixTimeMs(),
    secrets?.nonceHex ?? randomHex(32),
    eph.publicKey,
  );
  const clientBytes = clientHelloBytes(hello);
  await transport.write(encodePrefixed(clientBytes, MAX_HANDSHAKE_BYTES));
  const serverBytes = await transport.readPrefixed(MAX_HANDSHAKE_BYTES);
  const server = parseHello(serverBytes, 'server hello');
  validateCommonHello(server, secrets?.skipClockCheck !== true);
  decodeB64Array(server.identityKey, 32, 'server identity key');
  decodeB64Array(server.ephemeralKey, 32, 'server ephemeral key');
  const serverSig = decodeB64Array(server.signature, 64, 'server signature');
  if (server.clientHelloHash !== bytesToHex(sha256(clientBytes))) {
    throw new Error('server response is not bound to this client hello');
  }
  const serverIdentity = decodeB64Array(server.identityKey, 32, 'server identity key');
  if (!verifySignature(serverIdentity, serverSignatureInput(server), serverSig)) {
    throw new Error('server signature is invalid');
  }
  const remotePeerId = peerIdForPublicKey(serverIdentity);
  if (expectedPeerId && expectedPeerId !== remotePeerId) {
    throw new Error(`peer identity mismatch: expected ${expectedPeerId}, got ${remotePeerId}`);
  }
  const session = establishFromHellos(clientBytes, serverBytes, eph.secret, true, maxFrameBytes);
  await sendFinished(transport, session.send, 'initiator', session.transcriptHash, maxFrameBytes);
  await receiveFinished(transport, session.receive, 'responder', session.transcriptHash, maxFrameBytes);
  return session;
}

export async function responderHandshake(transport, identity, displayName, maxFrameBytes, secrets) {
  validateDisplayName(displayName);
  const clientBytes = await transport.readPrefixed(MAX_HANDSHAKE_BYTES);
  const client = parseHello(clientBytes, 'client hello');
  validateCommonHello(client, secrets?.skipClockCheck !== true);
  const clientIdentity = decodeB64Array(client.identityKey, 32, 'client identity key');
  decodeB64Array(client.ephemeralKey, 32, 'client ephemeral key');
  const clientSig = decodeB64Array(client.signature, 64, 'client signature');
  if (!verifySignature(clientIdentity, clientSignatureInput(client), clientSig)) {
    throw new Error('client signature is invalid');
  }
  const eph = secrets?.ephemeralSeed ? ephemeralFromSeed(secrets.ephemeralSeed) : generateEphemeral();
  const hello = makeServerHello(
    identity,
    displayName,
    clientBytes,
    secrets?.timestampMs ?? unixTimeMs(),
    secrets?.nonceHex ?? randomHex(32),
    eph.publicKey,
  );
  const serverBytes = serverHelloBytes(hello);
  await transport.write(encodePrefixed(serverBytes, MAX_HANDSHAKE_BYTES));
  const session = establishFromHellos(clientBytes, serverBytes, eph.secret, false, maxFrameBytes);
  await receiveFinished(transport, session.receive, 'initiator', session.transcriptHash, maxFrameBytes);
  await sendFinished(transport, session.send, 'responder', session.transcriptHash, maxFrameBytes);
  return session;
}

async function sendFinished(transport, sendCipher, role, transcript, maxFrameBytes) {
  const finished = utf8(JSON.stringify({
    marker: 'finished',
    role,
    transcriptHash: bytesToHex(transcript),
  }));
  const record = sendCipher.encrypt(finished);
  await transport.write(encodePrefixed(record, maxFrameBytes + 8 + 16));
}

async function receiveFinished(transport, receiveCipher, expectedRole, transcript, maxFrameBytes) {
  const record = await transport.readPrefixed(maxFrameBytes + 8 + 16);
  const bytes = receiveCipher.decrypt(record);
  const finished = JSON.parse(utf8Decode(bytes));
  if (
    finished.marker !== 'finished'
    || finished.role !== expectedRole
    || finished.transcriptHash !== bytesToHex(transcript)
  ) {
    throw new Error('finished record does not match the negotiated transcript');
  }
}

export function createStreamTransport(sendBytes, close) {
  const assembler = new ByteAssembler();
  const pending = [];
  let failed = null;
  let closed = false;

  function settle() {
    if (!pending.length) return;
    if (failed) {
      while (pending.length) pending.shift().reject(failed);
      return;
    }
    if (closed && assembler.buffer.length === 0) {
      while (pending.length) pending.shift().reject(new Error('connection closed'));
    }
  }

  return {
    write(bytes) {
      return sendBytes(bytes);
    },
    push(chunk) {
      assembler.push(chunk);
      while (pending.length) {
        const waiter = pending[0];
        try {
          const frame = assembler.nextFrame(waiter.maximum);
          if (!frame) break;
          pending.shift();
          waiter.resolve(frame);
        } catch (error) {
          pending.shift();
          waiter.reject(error);
        }
      }
    },
    readPrefixed(maximum) {
      const immediate = assembler.nextFrame(maximum);
      if (immediate) return Promise.resolve(immediate);
      if (failed) return Promise.reject(failed);
      if (closed) return Promise.reject(new Error('connection closed'));
      return new Promise((resolve, reject) => {
        pending.push({ maximum, resolve, reject });
      });
    },
    fail(error) {
      failed = error instanceof Error ? error : new Error(String(error));
      settle();
      close?.();
    },
    close() {
      closed = true;
      settle();
      close?.();
    },
  };
}
