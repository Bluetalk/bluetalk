import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  ReceiveCipher,
  SendCipher,
  b64ToBytes,
  bytesToB64,
  bytesToHex,
  clientHelloBytes,
  decodeWireFrame,
  deriveSessionCiphers,
  encodeWireFrame,
  ephemeralFromSeed,
  establishFromHellos,
  hexToBytes,
  identityFromSeed,
  makeClientHello,
  makeServerHello,
  peerIdForPublicKey,
  serverHelloBytes,
  sharedSecret,
  transcriptHash,
  utf8,
} from '../src/bridge/webBridge/peerProtocol/index.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'peer-v2-vectors.json');

function loadVectors() {
  return JSON.parse(readFileSync(fixturePath, 'utf8'));
}

test('JS-Port trifft die Rust-Vektoren für Handshake, Schlüssel und Records', () => {
  const vectors = loadVectors();
  const initiator = identityFromSeed(b64ToBytes(vectors.initiator.seedB64));
  const responder = identityFromSeed(b64ToBytes(vectors.responder.seedB64));
  assert.equal(initiator.peerId, vectors.initiator.peerId);
  assert.equal(responder.peerId, vectors.responder.peerId);
  assert.equal(initiator.publicKeyB64, vectors.initiator.identityKeyB64);
  assert.equal(responder.publicKeyB64, vectors.responder.identityKeyB64);

  const initiatorEph = ephemeralFromSeed(b64ToBytes(vectors.initiator.ephemeralSeedB64));
  const responderEph = ephemeralFromSeed(b64ToBytes(vectors.responder.ephemeralSeedB64));
  assert.equal(bytesToB64(initiatorEph.publicKey), vectors.initiator.ephemeralPublicB64);
  assert.equal(bytesToB64(responderEph.publicKey), vectors.responder.ephemeralPublicB64);

  const clientHello = makeClientHello(
    initiator,
    vectors.initiator.displayName,
    vectors.initiator.timestampMs,
    vectors.initiator.nonceHex,
    initiatorEph.publicKey,
  );
  const clientBytes = clientHelloBytes(clientHello);
  assert.equal(bytesToB64(clientBytes), vectors.clientHelloB64);

  const serverHello = makeServerHello(
    responder,
    vectors.responder.displayName,
    clientBytes,
    vectors.responder.timestampMs,
    vectors.responder.nonceHex,
    responderEph.publicKey,
  );
  const serverBytes = serverHelloBytes(serverHello);
  assert.equal(bytesToB64(serverBytes), vectors.serverHelloB64);

  const shared = sharedSecret(initiatorEph.secret, responderEph.publicKey);
  assert.deepEqual(shared, sharedSecret(responderEph.secret, initiatorEph.publicKey));
  const transcript = transcriptHash(clientBytes, serverBytes);
  assert.equal(bytesToHex(transcript), vectors.transcriptHashHex);
  assert.equal(bytesToHex(transcript.subarray(0, 16)), vectors.connectionId);

  const established = establishFromHellos(clientBytes, serverBytes, initiatorEph.secret, true, vectors.maxFrameBytes);
  assert.equal(established.remotePeerId, vectors.responder.peerId);
  assert.equal(peerIdForPublicKey(responder.publicKey), vectors.responder.peerId);

  const initiatorCiphers = deriveSessionCiphers(shared, transcript, true, vectors.maxFrameBytes);
  const responderCiphers = deriveSessionCiphers(shared, transcript, false, vectors.maxFrameBytes);

  const finishedInit = initiatorCiphers.send.encrypt(b64ToBytes(vectors.finished.initiatorPlaintextB64));
  assert.equal(bytesToHex(finishedInit), vectors.finished.initiatorRecordHex);
  assert.deepEqual(
    responderCiphers.receive.decrypt(finishedInit),
    b64ToBytes(vectors.finished.initiatorPlaintextB64),
  );

  const finishedResp = responderCiphers.send.encrypt(b64ToBytes(vectors.finished.responderPlaintextB64));
  assert.equal(bytesToHex(finishedResp), vectors.finished.responderRecordHex);
  assert.deepEqual(
    initiatorCiphers.receive.decrypt(finishedResp),
    b64ToBytes(vectors.finished.responderPlaintextB64),
  );

  for (const record of vectors.records) {
    const cipher = record.from === 'initiator' ? initiatorCiphers.send : responderCiphers.send;
    const peer = record.from === 'initiator' ? responderCiphers.receive : initiatorCiphers.receive;
    const encrypted = cipher.encrypt(hexToBytes(record.plaintextHex));
    assert.equal(bytesToHex(encrypted), record.recordHex);
    assert.equal(bytesToHex(peer.decrypt(encrypted)), record.plaintextHex);
  }

  for (const frame of vectors.frames) {
    const parsed = decodeWireFrame(utf8(frame.utf8), vectors.maxFrameBytes);
    const roundTrip = encodeWireFrame(parsed, vectors.maxFrameBytes);
    assert.equal(new TextDecoder().decode(roundTrip), frame.utf8);
  }
});

test('Send/Receive-Cipher lehnt Replay ab', () => {
  const shared = new Uint8Array(32).fill(7);
  const transcript = new Uint8Array(32).fill(9);
  const sender = new SendCipher(
    deriveSessionCiphers(shared, transcript, true, 1024).keys.initiatorKey,
    deriveSessionCiphers(shared, transcript, true, 1024).keys.initiatorPrefix,
    transcript,
    1024,
  );
  const receiver = new ReceiveCipher(
    deriveSessionCiphers(shared, transcript, false, 1024).keys.initiatorKey,
    deriveSessionCiphers(shared, transcript, false, 1024).keys.initiatorPrefix,
    transcript,
    1024,
  );
  const record = sender.encrypt(utf8('hello'));
  assert.equal(new TextDecoder().decode(receiver.decrypt(record)), 'hello');
  assert.throws(() => receiver.decrypt(record));
});
