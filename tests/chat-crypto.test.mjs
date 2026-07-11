import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeE2eeKeyId,
  decryptChatPayload,
  deriveSharedAesKey,
  encryptChatPayload,
  exportSpkiPublic,
  generateEcdhKeyPair,
  importPeerPublicFromSpki,
} from '../src/renderer/chatCrypto.js';

test('P-256 peers derive the same authenticated E2EE v2 key', async () => {
  const left = await generateEcdhKeyPair();
  const right = await generateEcdhKeyPair();
  const leftPublic = await exportSpkiPublic(left.publicKey);
  const rightPublic = await exportSpkiPublic(right.publicKey);
  const leftKey = await deriveSharedAesKey(left.privateKey, await importPeerPublicFromSpki(rightPublic));
  const rightKey = await deriveSharedAesKey(right.privateKey, await importPeerPublicFromSpki(leftPublic));
  const keyId = await computeE2eeKeyId(leftPublic, rightPublic);
  assert.equal(keyId, await computeE2eeKeyId(rightPublic, leftPublic));

  const payload = { kind: 'chat', messageId: 'm1', content: 'secret' };
  const envelope = await encryptChatPayload(leftKey, payload, { version: 2, keyId });
  assert.deepEqual(await decryptChatPayload(rightKey, envelope, { keyId }), payload);
  await assert.rejects(
    decryptChatPayload(rightKey, { ...envelope, keyId: `${keyId}-wrong` }, { keyId }),
    /wrong_key_id/,
  );
});

test('v1 E2EE envelopes remain readable during migration', async () => {
  const left = await generateEcdhKeyPair();
  const right = await generateEcdhKeyPair();
  const leftKey = await deriveSharedAesKey(left.privateKey, right.publicKey);
  const rightKey = await deriveSharedAesKey(right.privateKey, left.publicKey);
  const payload = { kind: 'chat', messageId: 'legacy', content: 'compatible' };
  const envelope = await encryptChatPayload(leftKey, payload, { version: 1 });
  assert.deepEqual(await decryptChatPayload(rightKey, envelope), payload);
});

