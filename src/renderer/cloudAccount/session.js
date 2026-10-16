import { getRawApi } from '../../bridge/syncLayer.js';
import { createCloudApi, defaultRelayUrl, httpBaseFromRelayUrl, CloudApiError } from './api.js';
import {
  deriveKeys,
  importSessionKeys,
  isValidUsername,
  newKdf,
  normalizeUsername,
  openVault,
  sealVault,
  signAccountRegister,
} from './crypto.js';
import { clearSyncPersistence } from './syncLogic.js';

const ACCOUNT_KEY = 'cloudAccount';

let account = null;
let hydrated = false;
const listeners = new Set();

function persistable(next) {
  if (!next) return null;
  return {
    username: next.username,
    peerId: next.peerId,
    token: next.token,
    baseUrl: next.baseUrl,
    encKeyRawB64: next.encKeyRawB64,
    macKeyRawB64: next.macKeyRawB64,
    lastSeq: Number(next.lastSeq) || 0,
    deviceName: next.deviceName || defaultDeviceName(),
  };
}

function emit() {
  const snapshot = persistable(account);
  for (const cb of listeners) {
    try {
      cb(snapshot);
    } catch {
      /* ignore */
    }
  }
}

function defaultDeviceName() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'BlueTalk';
}

async function relayBaseUrl() {
  try {
    const status = await window.bluetalk?.cloud?.getStatus?.();
    if (status?.relayUrl) return httpBaseFromRelayUrl(status.relayUrl);
  } catch {
    /* Standard */
  }
  return httpBaseFromRelayUrl(defaultRelayUrl());
}

async function writeAccount(next) {
  account = next;
  hydrated = true;
  if (window.bluetalk?.store) {
    if (next) await window.bluetalk.store.set(ACCOUNT_KEY, persistable(next));
    else await window.bluetalk.store.delete(ACCOUNT_KEY);
  }
  emit();
}

async function hydrate() {
  if (hydrated) return account;
  hydrated = true;
  if (!window.bluetalk?.store) return null;
  const stored = await window.bluetalk.store.get(ACCOUNT_KEY, null);
  if (!stored?.token || !stored?.encKeyRawB64 || !stored?.macKeyRawB64) {
    account = null;
    return null;
  }
  try {
    const keys = await importSessionKeys(stored.encKeyRawB64, stored.macKeyRawB64);
    account = {
      ...stored,
      lastSeq: Number(stored.lastSeq) || 0,
      ...keys,
    };
  } catch {
    account = null;
  }
  return account;
}

export async function getAccount() {
  await hydrate();
  return persistable(account);
}

export function getLiveAccount() {
  return account;
}

export function onAccountChange(cb) {
  if (typeof cb !== 'function') return () => undefined;
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function updateAccountSeq(lastSeq) {
  await hydrate();
  if (!account) return;
  account = { ...account, lastSeq: Number(lastSeq) || 0 };
  if (window.bluetalk?.store) {
    await window.bluetalk.store.set(ACCOUNT_KEY, persistable(account));
  }
}

export async function updateAccountToken(token, extra = {}) {
  await hydrate();
  if (!account) return;
  account = { ...account, token, ...extra };
  if (window.bluetalk?.store) {
    await window.bluetalk.store.set(ACCOUNT_KEY, persistable(account));
  }
  emit();
}

export function apiForAccount(next = account) {
  const token = next?.token || '';
  return createCloudApi(next?.baseUrl || httpBaseFromRelayUrl(defaultRelayUrl()), () => token);
}

function persistenceStore() {
  return getRawApi()?.store || window.bluetalk?.store;
}

async function wipeSyncArtifacts() {
  await clearSyncPersistence(persistenceStore());
}

export async function clearAccountLocal() {
  account = null;
  hydrated = true;
  await wipeSyncArtifacts();
  if (window.bluetalk?.store) {
    await window.bluetalk.store.delete(ACCOUNT_KEY);
  }
  emit();
}

export async function commitLiveAccount() {
  await hydrate();
  if (!account) return persistable(account);
  await writeAccount(account);
  return persistable(account);
}

export async function prepareIdentityTakeover() {
  await hydrate();
  const store = persistenceStore();
  if (store) {
    await store.set('e2eeSessions', {});
    await wipeSyncArtifacts();
  }
  if (account) {
    account = { ...account, lastSeq: 0 };
    await writeAccount(account);
  }
}

function vaultPlain(identity) {
  return {
    v: 1,
    networkSeed: identity.networkSeedB64,
    e2eeIdentity: identity.e2eeIdentity,
    createdAt: Date.now(),
  };
}

export async function registerAccount({ username, password, identity }) {
  const name = normalizeUsername(username);
  if (!isValidUsername(name)) throw new Error('Benutzername: 3–32 Zeichen, nur a–z, 0–9, _ . -');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Passwort muss mindestens 8 Zeichen haben.');
  }
  if (!identity?.networkSeedB64 || !identity?.e2eeIdentity) {
    throw new Error('Identität fehlt.');
  }
  const baseUrl = await relayBaseUrl();
  const api = createCloudApi(baseUrl, () => '');
  const kdf = newKdf();
  const keys = await deriveKeys(name, password, kdf);
  const vault = await sealVault(keys.encKey, name, vaultPlain(identity));
  const signed = await signAccountRegister(identity.networkSeedB64, name, keys.authKeyB64);
  let result;
  try {
    result = await api.register({
      username: name,
      kdf,
      authKey: keys.authKeyB64,
      vault,
      publicKey: signed.publicKey,
      signature: signed.signature,
      deviceName: defaultDeviceName(),
    });
  } catch (error) {
    throw userFacingAuthError(error, 'register');
  }
  await wipeSyncArtifacts();
  await writeAccount({
    username: result.username || name,
    peerId: result.peerId,
    token: result.token,
    baseUrl,
    encKeyRawB64: keys.encKeyRawB64,
    macKeyRawB64: keys.macKeyRawB64,
    lastSeq: 0,
    deviceName: defaultDeviceName(),
    encKey: keys.encKey,
    macKey: keys.macKey,
  });
  return persistable(account);
}

export async function loginAccount({ username, password }) {
  const name = normalizeUsername(username);
  if (!isValidUsername(name)) throw new Error('Benutzername ungültig.');
  if (typeof password !== 'string' || !password) throw new Error('Passwort fehlt.');
  const baseUrl = await relayBaseUrl();
  const api = createCloudApi(baseUrl, () => '');
  let pre;
  try {
    pre = await api.prelogin(name);
  } catch (error) {
    throw userFacingAuthError(error, 'login');
  }
  const keys = await deriveKeys(name, password, pre?.kdf);
  let result;
  try {
    result = await api.login({
      username: name,
      authKey: keys.authKeyB64,
      deviceName: defaultDeviceName(),
    });
  } catch (error) {
    throw userFacingAuthError(error, 'login');
  }
  let opened;
  try {
    opened = await openVault(keys.encKey, name, result.vault);
  } catch {
    throw new Error('Tresor konnte nicht geöffnet werden.');
  }
  const next = {
    username: result.username || name,
    peerId: result.peerId,
    token: result.token,
    baseUrl,
    encKeyRawB64: keys.encKeyRawB64,
    macKeyRawB64: keys.macKeyRawB64,
    lastSeq: 0,
    deviceName: defaultDeviceName(),
    encKey: keys.encKey,
    macKey: keys.macKey,
  };
  await wipeSyncArtifacts();
  let localId = '';
  try {
    localId = (await window.bluetalk?.peer?.getInfo?.())?.id || '';
  } catch {
    localId = '';
  }
  const identityPending = Boolean(next.peerId && localId && next.peerId !== localId);
  account = next;
  hydrated = true;
  if (identityPending) {
    emit();
  } else {
    await writeAccount(next);
  }
  return {
    account: persistable(account),
    vault: {
      networkSeed: opened.networkSeed,
      e2eeIdentity: opened.e2eeIdentity,
    },
    identityPending,
  };
}

export async function logoutAccount() {
  await hydrate();
  const current = account;
  if (current?.token) {
    try {
      await apiForAccount(current).logout();
    } catch {
      /* lokal trotzdem abmelden */
    }
  }
  await clearAccountLocal();
}

export async function changePassword(oldPassword, newPassword) {
  await hydrate();
  if (!account) throw new Error('Nicht angemeldet.');
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('Neues Passwort muss mindestens 8 Zeichen haben.');
  }
  const api = apiForAccount();
  const pre = await api.prelogin(account.username);
  const currentKeys = await deriveKeys(account.username, oldPassword, pre?.kdf);
  const kdf = newKdf();
  const nextKeys = await deriveKeys(account.username, newPassword, kdf);
  const identity = await currentIdentityForVault();
  const vault = await sealVault(nextKeys.encKey, account.username, vaultPlain(identity));
  let result;
  try {
    result = await api.changePassword({
      currentAuthKey: currentKeys.authKeyB64,
      kdf,
      authKey: nextKeys.authKeyB64,
      vault,
    });
  } catch (error) {
    throw userFacingAuthError(error, 'password');
  }
  await writeAccount({
    ...account,
    token: result?.token || account.token,
    encKeyRawB64: nextKeys.encKeyRawB64,
    macKeyRawB64: nextKeys.macKeyRawB64,
    encKey: nextKeys.encKey,
    macKey: nextKeys.macKey,
  });
  return persistable(account);
}

export async function deleteAccount(password) {
  await hydrate();
  if (!account) throw new Error('Nicht angemeldet.');
  const api = apiForAccount();
  const pre = await api.prelogin(account.username);
  const keys = await deriveKeys(account.username, password, pre?.kdf);
  try {
    await api.deleteAccount({ authKey: keys.authKeyB64 });
  } catch (error) {
    throw userFacingAuthError(error, 'delete');
  }
  await clearAccountLocal();
}

async function currentIdentityForVault() {
  const networkSeedB64 = (await window.bluetalk?.account?.exportIdentity?.())?.seedB64;
  const e2eeIdentity = await window.bluetalk?.store?.get?.('e2eeIdentity', null);
  if (!networkSeedB64 || !e2eeIdentity) throw new Error('Identität fehlt.');
  return { networkSeedB64, e2eeIdentity };
}

function userFacingAuthError(error, kind) {
  if (error instanceof CloudApiError) {
    if (error.status === 401 || error.code === 'invalid_credentials') {
      return new Error(kind === 'register' ? 'Registrierung abgelehnt.' : 'Benutzername oder Passwort ist falsch.');
    }
    if (error.code === 'username_taken') return new Error('Dieser Benutzername ist bereits vergeben.');
    if (error.code === 'peer_taken') return new Error('Für diese Identität existiert bereits ein Konto.');
    if (error.status === 429 || error.code === 'rate') return new Error('Zu viele Versuche. Bitte kurz warten.');
    if (error.code === 'quota') return new Error('Cloud-Speicher ist voll.');
    return new Error(error.message || 'Cloud-Anfrage fehlgeschlagen.');
  }
  return error instanceof Error ? error : new Error('Cloud-Anfrage fehlgeschlagen.');
}
