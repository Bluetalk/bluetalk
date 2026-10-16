import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveKeys,
  newKdf,
  openSyncItem,
  openVault,
  sealSyncItem,
  sealVault,
  signAccountRegister,
  syncKeyForLogicalKey,
} from '../src/renderer/cloudAccount/crypto.js';

const KDF = {
  alg: 'pbkdf2-sha256',
  iterations: 600000,
  salt: 'AQEBAQEBAQEBAQEBAQEBEQ==',
};

test('deriveKeys is deterministic for the same username, password and kdf', async () => {
  const a = await deriveKeys('Ada', 'correct horse', KDF);
  const b = await deriveKeys('  ADA ', 'correct horse', KDF);
  assert.equal(a.authKeyB64, b.authKeyB64);
  assert.equal(a.encKeyRawB64, b.encKeyRawB64);
  assert.equal(a.macKeyRawB64, b.macKeyRawB64);
  assert.equal(a.authKeyB64.length > 20, true);
});

test('deriveKeys changes when the password changes', async () => {
  const a = await deriveKeys('ada', 'correct horse', KDF);
  const b = await deriveKeys('ada', 'correct horse!', KDF);
  assert.notEqual(a.authKeyB64, b.authKeyB64);
  assert.notEqual(a.encKeyRawB64, b.encKeyRawB64);
});

test('newKdf uses pbkdf2-sha256 with 600000 iterations and a 16-byte salt', () => {
  const kdf = newKdf();
  assert.equal(kdf.alg, 'pbkdf2-sha256');
  assert.equal(kdf.iterations, 600000);
  const salt = Buffer.from(kdf.salt, 'base64');
  assert.equal(salt.length, 16);
});

test('sealVault / openVault roundtrip', async () => {
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const plain = { v: 1, networkSeed: 'abc', createdAt: 1 };
  const vault = await sealVault(keys.encKey, 'Mina', plain);
  assert.equal(vault.v, 1);
  assert.equal(typeof vault.iv, 'string');
  assert.equal(typeof vault.ct, 'string');
  assert.deepEqual(await openVault(keys.encKey, 'mina', vault), plain);
});

test('vault AAD binds the username', async () => {
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const vault = await sealVault(keys.encKey, 'mina', { v: 1 });
  await assert.rejects(() => openVault(keys.encKey, 'other', vault));
});

test('sealSyncItem / openSyncItem roundtrip', async () => {
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const op = { t: 'store', key: 'contacts', value: [{ id: 'bt2_a' }], ts: 42 };
  const item = await sealSyncItem(keys.encKey, keys.macKey, 'store:contacts', op);
  assert.match(item.key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await openSyncItem(keys.encKey, item), op);
});

test('sync item AAD binds the opaque key', async () => {
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const item = await sealSyncItem(keys.encKey, keys.macKey, 'store:settings', { t: 'store', key: 'settings', ts: 1 });
  await assert.rejects(() => openSyncItem(keys.encKey, { ...item, key: `${item.key.slice(0, 42)}A` }));
});

test('signAccountRegister produces 32-byte public key and 64-byte signature', async () => {
  const seed = Buffer.alloc(32, 7).toString('base64');
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const signed = await signAccountRegister(seed, 'Mina', keys.authKeyB64);
  const publicRaw = Buffer.from(signed.publicKey, 'base64');
  const signature = Buffer.from(signed.signature, 'base64');
  assert.equal(publicRaw.length, 32);
  assert.equal(signature.length, 64);
  const publicKey = await crypto.subtle.importKey('raw', publicRaw, 'Ed25519', false, ['verify']);
  const message = new TextEncoder().encode(`bluetalk-account-register-v1\nmina\n${keys.authKeyB64}`);
  assert.equal(await crypto.subtle.verify('Ed25519', publicKey, signature, message), true);
});

test('sync key HMAC is stable for a logical key', async () => {
  const keys = await deriveKeys('mina', 'passwort-12', KDF);
  const a = await syncKeyForLogicalKey(keys.macKey, 'msg:bt2_aa:m1');
  const b = await syncKeyForLogicalKey(keys.macKey, 'msg:bt2_aa:m1');
  const c = await syncKeyForLogicalKey(keys.macKey, 'msg:bt2_aa:m2');
  assert.equal(a, b);
  assert.equal(a.length, 43);
  assert.notEqual(a, c);
});
