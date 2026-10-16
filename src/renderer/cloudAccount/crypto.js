const TEXT = new TextEncoder();
const KDF_ALG = 'pbkdf2-sha256';
const KDF_ITERATIONS = 600_000;
const HKDF_SALT = new Uint8Array();
const AUTH_INFO = TEXT.encode('bluetalk-cloud-auth-v1');
const ENC_INFO = TEXT.encode('bluetalk-cloud-enc-v1');
const MAC_INFO = TEXT.encode('bluetalk-cloud-mac-v1');
const ED25519_PKCS8_PREFIX = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

export function bytesToB64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function b64ToBytes(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64Url(buf) {
  return bytesToB64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function b64UrlToBytes(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (padded.length % 4)) % 4;
  return b64ToBytes(padded + '='.repeat(pad));
}

export function normalizeUsername(input) {
  return String(input || '').trim().toLowerCase();
}

export function isValidUsername(username) {
  return USERNAME_RE.test(username);
}

export function newKdf() {
  return {
    alg: KDF_ALG,
    iterations: KDF_ITERATIONS,
    salt: bytesToB64(crypto.getRandomValues(new Uint8Array(16))),
  };
}

function kdfParams(kdf) {
  const iterations = Number(kdf?.iterations) || KDF_ITERATIONS;
  if (!kdf?.salt) throw new Error('kdf_missing');
  return {
    salt: b64ToBytes(kdf.salt),
    iterations: Math.max(1, iterations),
  };
}

async function hkdfBits(master, info) {
  const ikm = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: HKDF_SALT, info },
    ikm,
    256,
  );
}

export async function importEncKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function importMacKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function importSessionKeys(encKeyRawB64, macKeyRawB64) {
  return {
    encKey: await importEncKey(b64ToBytes(encKeyRawB64)),
    macKey: await importMacKey(b64ToBytes(macKeyRawB64)),
  };
}

export async function deriveKeys(username, password, kdf) {
  const name = normalizeUsername(username);
  if (!isValidUsername(name)) throw new Error('invalid_username');
  if (typeof password !== 'string' || password.length < 1) throw new Error('invalid_password');
  const { salt, iterations } = kdfParams(kdf);
  const material = await crypto.subtle.importKey('raw', TEXT.encode(password), 'PBKDF2', false, ['deriveBits']);
  const master = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    256,
  );
  const authRaw = new Uint8Array(await hkdfBits(master, AUTH_INFO));
  const encRaw = new Uint8Array(await hkdfBits(master, ENC_INFO));
  const macRaw = new Uint8Array(await hkdfBits(master, MAC_INFO));
  return {
    authKeyB64: bytesToB64(authRaw),
    encKey: await importEncKey(encRaw),
    macKey: await importMacKey(macRaw),
    encKeyRawB64: bytesToB64(encRaw),
    macKeyRawB64: bytesToB64(macRaw),
  };
}

function vaultAad(username) {
  return TEXT.encode(`bluetalk-vault-v1:${normalizeUsername(username)}`);
}

function syncAad(key) {
  return TEXT.encode(`bluetalk-sync-v1:${key}`);
}

export async function sealVault(encKey, username, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: vaultAad(username) },
    encKey,
    TEXT.encode(JSON.stringify(plain)),
  );
  return { v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

export async function openVault(encKey, username, vault) {
  if (!vault?.iv || !vault?.ct) throw new Error('invalid_vault');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToBytes(vault.iv), additionalData: vaultAad(username) },
    encKey,
    b64ToBytes(vault.ct),
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

export async function syncKeyForLogicalKey(macKey, logicalKey) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', macKey, TEXT.encode(String(logicalKey))));
  return bytesToB64Url(mac).slice(0, 43);
}

export async function sealSyncItem(encKey, macKey, logicalKey, op) {
  const key = await syncKeyForLogicalKey(macKey, logicalKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: syncAad(key) },
    encKey,
    TEXT.encode(JSON.stringify(op)),
  ));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return { key, data: bytesToB64(packed) };
}

export async function openSyncItem(encKey, item) {
  const key = item?.key;
  const packed = b64ToBytes(item?.data);
  if (!key || packed.length < 13) throw new Error('invalid_sync_item');
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: syncAad(key) },
    encKey,
    ct,
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

function ed25519Pkcs8(seed) {
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX, 0);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
  return pkcs8;
}

export async function signAccountRegister(networkSeedB64, username, authKeyB64) {
  const seed = b64ToBytes(networkSeedB64);
  if (seed.length !== 32) throw new Error('invalid_seed');
  const key = await crypto.subtle.importKey('pkcs8', ed25519Pkcs8(seed), 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const publicRaw = b64UrlToBytes(jwk?.x);
  if (publicRaw.length !== 32) throw new Error('ed25519_public_missing');
  const message = TEXT.encode(`bluetalk-account-register-v1\n${normalizeUsername(username)}\n${authKeyB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, message));
  return {
    publicKey: bytesToB64(publicRaw),
    signature: bytesToB64(signature),
  };
}
