const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

async function loadChatCrypto() {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer', 'chatCrypto.js'), 'utf8');
  const transformed = await esbuild.transform(source, { format: 'cjs', platform: 'node', target: 'node20' });
  const module = { exports: {} };
  const evaluate = new Function('module', 'exports', transformed.code);
  evaluate(module, module.exports);
  return module.exports;
}

test('ECDH peers derive the same authenticated E2EE v2 key and payload', async () => {
  const cryptoApi = await loadChatCrypto();
  const left = await cryptoApi.generateEcdhKeyPair();
  const right = await cryptoApi.generateEcdhKeyPair();
  const leftPublic = await cryptoApi.exportSpkiPublic(left.publicKey);
  const rightPublic = await cryptoApi.exportSpkiPublic(right.publicKey);
  const leftKey = await cryptoApi.deriveSharedAesKey(
    left.privateKey,
    await cryptoApi.importPeerPublicFromSpki(rightPublic)
  );
  const rightKey = await cryptoApi.deriveSharedAesKey(
    right.privateKey,
    await cryptoApi.importPeerPublicFromSpki(leftPublic)
  );
  const keyId = await cryptoApi.computeE2eeKeyId(leftPublic, rightPublic);
  assert.equal(keyId, await cryptoApi.computeE2eeKeyId(rightPublic, leftPublic));

  const plain = { kind: 'chat', messageId: 'm1', content: 'secret' };
  const envelope = await cryptoApi.encryptChatPayload(leftKey, plain, { keyId, version: 2 });
  assert.equal(envelope.e2eeV, 2);
  assert.deepEqual(await cryptoApi.decryptChatPayload(rightKey, envelope, { keyId }), plain);

  await assert.rejects(
    cryptoApi.decryptChatPayload(rightKey, { ...envelope, keyId: `${keyId}x` }, { keyId }),
    /wrong_key_id/
  );
});

test('E2EE v1 payloads remain compatible with existing peers', async () => {
  const cryptoApi = await loadChatCrypto();
  const left = await cryptoApi.generateEcdhKeyPair();
  const right = await cryptoApi.generateEcdhKeyPair();
  const leftKey = await cryptoApi.deriveSharedAesKey(left.privateKey, right.publicKey);
  const rightKey = await cryptoApi.deriveSharedAesKey(right.privateKey, left.publicKey);
  const plain = { kind: 'chat', messageId: 'legacy', content: 'compatible' };
  const envelope = await cryptoApi.encryptChatPayload(leftKey, plain, { version: 1 });
  assert.equal(envelope.e2eeV, 1);
  assert.deepEqual(await cryptoApi.decryptChatPayload(rightKey, envelope), plain);
});

test('group payloads are encrypted independently for each pairwise recipient', async () => {
  const cryptoApi = await loadChatCrypto();
  const sender = await cryptoApi.generateEcdhKeyPair();
  const alice = await cryptoApi.generateEcdhKeyPair();
  const bob = await cryptoApi.generateEcdhKeyPair();
  const outsider = await cryptoApi.generateEcdhKeyPair();

  const senderAlice = await cryptoApi.deriveSharedAesKey(sender.privateKey, alice.publicKey);
  const aliceSender = await cryptoApi.deriveSharedAesKey(alice.privateKey, sender.publicKey);
  const senderBob = await cryptoApi.deriveSharedAesKey(sender.privateKey, bob.publicKey);
  const bobSender = await cryptoApi.deriveSharedAesKey(bob.privateKey, sender.publicKey);
  const outsiderSender = await cryptoApi.deriveSharedAesKey(outsider.privateKey, sender.publicKey);
  const payload = {
    kind: 'group-message-v1',
    protocolVersion: 1,
    groupId: 'group:12345678',
    senderPeerId: 'bt-sender',
    messageId: 'gm1',
    payload: { kind: 'chat', content: 'nur Mitglieder' },
  };

  const aliceEnvelope = await cryptoApi.encryptChatPayload(senderAlice, payload, { version: 1 });
  const bobEnvelope = await cryptoApi.encryptChatPayload(senderBob, payload, { version: 1 });
  assert.deepEqual(await cryptoApi.decryptChatPayload(aliceSender, aliceEnvelope), payload);
  assert.deepEqual(await cryptoApi.decryptChatPayload(bobSender, bobEnvelope), payload);
  await assert.rejects(cryptoApi.decryptChatPayload(outsiderSender, aliceEnvelope));
  await assert.rejects(cryptoApi.decryptChatPayload(bobSender, aliceEnvelope));
});
