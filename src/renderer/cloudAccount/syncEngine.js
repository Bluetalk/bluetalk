import { getRawApi, setSyncSink, SYNCED_STORE_KEYS } from '../../bridge/syncLayer.js';
import { CloudApiError } from './api.js';
import { openSyncItem, sealSyncItem } from './crypto.js';
import {
  DEVICE_ID_KEY,
  META_KEY,
  OUTBOX_KEY,
  PUSH_BATCH,
  PUSH_BODY_MAX_BYTES,
  PUSH_ITEM_MAX_BYTES,
  appliedMetaAfterOp,
  clearSyncPersistence,
  createMemoryOutbox,
  diffStoreEntries,
  applyStoreEntryToValue,
  entriesOfStore,
  jsonBytes,
  logicalKeyOf,
  logicalKeyOfOp,
  normalizeSyncMeta,
  onSyncArtifactsCleared,
  peersAndStoresFromOps,
  pendingTsFor,
  prepareMessageForSync,
  shouldApplyMessage,
  shouldApplyStoreEntry,
  shouldApplyStoreOp,
  shouldSkipOwnOrigin,
  storeEntryAppliedTs,
  stripMessageFileData,
} from './syncLogic.js';
import {
  apiForAccount,
  clearAccountLocal,
  getLiveAccount,
  getAccount,
  updateAccountSeq,
} from './session.js';

const PULL_LIMIT = 200;
const PUSH_DEBOUNCE_MS = 1500;
const PULL_INTERVAL_MS = 60_000;
const BACKOFF_MIN_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const PERSIST_DEBOUNCE_MS = 50;
const MESSAGE_CACHE_MAX = 500;
const PUSH_BODY_SAFETY = 4096;

let running = false;
let pushTimer = null;
let pullTimer = null;
let inflight = null;
let backoffMs = BACKOFF_MIN_MS;
let focusHandler = null;
let onlineHandler = null;
let originId = '';
const memoryOutbox = createMemoryOutbox();
let outboxHydrated = false;
let persistTimer = null;
let persistInflight = null;
let persistQueued = false;
const messageCache = new Map();

const state = {
  state: 'off',
  lastSyncAt: null,
  error: null,
  pending: 0,
};
const stateListeners = new Set();

function rawBridge() {
  return getRawApi() || window.bluetalk;
}

function rawStore() {
  return rawBridge()?.store;
}

function rawMessages() {
  return rawBridge()?.messages;
}

function setState(patch) {
  Object.assign(state, patch);
  const snapshot = getSyncState();
  for (const cb of stateListeners) {
    try {
      cb(snapshot);
    } catch {
      /* ignore */
    }
  }
}

export function getSyncState() {
  return {
    state: state.state,
    lastSyncAt: state.lastSyncAt,
    error: state.error,
    pending: state.pending,
  };
}

export function onSyncState(cb) {
  if (typeof cb !== 'function') return () => undefined;
  stateListeners.add(cb);
  return () => stateListeners.delete(cb);
}

onSyncArtifactsCleared(() => {
  memoryOutbox.replace([]);
  outboxHydrated = true;
  notePending();
});

function notePending() {
  setState({ pending: memoryOutbox.length() });
}

async function hydrateOutbox() {
  if (outboxHydrated) return;
  const value = await rawStore()?.get?.(OUTBOX_KEY, []);
  memoryOutbox.replace(Array.isArray(value) ? value : []);
  outboxHydrated = true;
  notePending();
}

async function persistOutboxNow() {
  const store = rawStore();
  if (!store?.set) return;
  const snapshot = memoryOutbox.snapshot();
  await store.set(OUTBOX_KEY, snapshot);
  notePending();
}

async function flushPersist() {
  if (persistInflight) {
    persistQueued = true;
    await persistInflight;
    return;
  }
  persistInflight = persistOutboxNow();
  try {
    await persistInflight;
  } finally {
    persistInflight = null;
  }
  if (persistQueued) {
    persistQueued = false;
    await flushPersist();
  }
}

function schedulePersist() {
  notePending();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushPersist();
  }, PERSIST_DEBOUNCE_MS);
}

async function readMeta() {
  const value = await rawStore()?.get?.(META_KEY, null);
  return normalizeSyncMeta(value);
}

async function writeMeta(meta) {
  await rawStore()?.set?.(META_KEY, normalizeSyncMeta(meta));
}

export async function resetSyncLocalState() {
  memoryOutbox.replace([]);
  outboxHydrated = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistQueued = false;
  await flushPersist();
  await clearSyncPersistence(rawStore());
  notePending();
}

async function handleUnauthorized() {
  running = false;
  teardownTimers();
  setSyncSink(null);
  await resetSyncLocalState();
  await clearAccountLocal();
  setState({ state: 'off', error: 'Abgemeldet (Sitzung ungültig).', pending: 0 });
}

function classifyError(error) {
  if (error instanceof CloudApiError) {
    if (error.status === 401 || error.code === 'unauthorized' || error.code === 'invalid_credentials') {
      return 'auth';
    }
    if (error.code === 'too_large') return 'too_large';
    if (error.status === 413) {
      return error.code === 'quota' ? 'quota' : 'too_large';
    }
    if (error.code === 'quota') return 'quota';
  }
  return 'network';
}

function publicErrorMessage(kind) {
  if (kind === 'quota') return 'Cloud-Speicher ist voll.';
  if (kind === 'too_large') return 'Ein Sync-Eintrag ist zu groß.';
  if (kind === 'auth') return 'Abgemeldet (Sitzung ungültig).';
  return 'Synchronisation derzeit nicht möglich.';
}

async function getDeviceOrigin() {
  if (originId) return originId;
  const store = rawStore();
  let id = await store?.get?.(DEVICE_ID_KEY, null);
  if (typeof id === 'string' && id.length >= 8) {
    originId = id;
    return originId;
  }
  id = (typeof crypto?.randomUUID === 'function')
    ? crypto.randomUUID()
    : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  await store?.set?.(DEVICE_ID_KEY, id);
  originId = id;
  return originId;
}

function cacheMessage(peerId, message) {
  if (!peerId || !message?.messageId) return;
  messageCache.set(`${peerId}:${message.messageId}`, message);
}

function trimMessageCache() {
  while (messageCache.size > MESSAGE_CACHE_MAX) {
    const first = messageCache.keys().next().value;
    messageCache.delete(first);
  }
}

async function enqueue(change) {
  if (!running || !getLiveAccount()) return;
  await hydrateOutbox();
  if (change?.type === 'store') {
    const current = await rawStore()?.get?.(change.key, null);
    const meta = await readMeta();
    const snapshot = meta.storeSnapshots?.[change.key] || {};
    const diffs = diffStoreEntries(change.key, current, snapshot);
    const ts = Number(change.ts) > 0 ? Number(change.ts) : Date.now();
    for (const diff of diffs) memoryOutbox.enqueue({ ...diff, ts });
  } else if (change?.type) {
    memoryOutbox.enqueue(change);
  }
  schedulePersist();
  schedulePush();
}

function schedulePush() {
  if (!running) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void runCycle('push');
  }, PUSH_DEBOUNCE_MS);
}

function teardownTimers() {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (pullTimer) {
    clearInterval(pullTimer);
    pullTimer = null;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (focusHandler) {
    window.removeEventListener('focus', focusHandler);
    focusHandler = null;
  }
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    onlineHandler = null;
  }
}

async function localPeerId() {
  try {
    const info = await window.bluetalk?.peer?.getInfo?.();
    return info?.id || '';
  } catch {
    return '';
  }
}

export async function startSync() {
  const stored = await getAccount();
  if (!stored) {
    setState({ state: 'off', error: null, pending: 0 });
    return;
  }
  const peerId = await localPeerId();
  if (stored.peerId && peerId && stored.peerId !== peerId) {
    running = false;
    teardownTimers();
    setSyncSink(null);
    setState({
      state: 'error',
      error: 'Konto-Identität stimmt nicht mit diesem Gerät überein. Bitte abmelden oder die Identität übernehmen.',
      pending: 0,
    });
    return;
  }
  if (running) return;
  running = true;
  backoffMs = BACKOFF_MIN_MS;
  outboxHydrated = false;
  await hydrateOutbox();
  await getDeviceOrigin();
  setState({ state: 'idle', error: null, pending: memoryOutbox.length() });
  setSyncSink({
    onLocalChange: (change) => {
      void enqueue(change);
    },
  });
  focusHandler = () => { void runCycle('pull'); };
  onlineHandler = () => { void runCycle('pull'); };
  window.addEventListener('focus', focusHandler);
  window.addEventListener('online', onlineHandler);
  pullTimer = setInterval(() => { void runCycle('pull'); }, PULL_INTERVAL_MS);
  await runCycle('start');
}

export function stopSync() {
  running = false;
  teardownTimers();
  setSyncSink(null);
  void flushPersist();
  setState({ state: 'off', error: null });
}

export async function syncNow() {
  if (!running) await startSync();
  else await runCycle('pull');
}

async function runCycle(reason) {
  if (!running) return;
  if (inflight) {
    await inflight;
    if (!running) return;
  }
  const live = getLiveAccount();
  if (!live?.encKey || !live?.macKey || !live?.token) {
    stopSync();
    return;
  }
  inflight = (async () => {
    setState({ state: 'syncing' });
    try {
      if (reason !== 'push') await pullRemote();
      await pushOutbox();
      backoffMs = BACKOFF_MIN_MS;
      setState({
        state: 'idle',
        lastSyncAt: Date.now(),
        error: null,
        pending: memoryOutbox.length(),
      });
    } catch (error) {
      const kind = classifyError(error);
      if (kind === 'auth') {
        await handleUnauthorized();
        return;
      }
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      setState({
        state: 'error',
        error: publicErrorMessage(kind),
        pending: memoryOutbox.length(),
      });
      if (running && kind !== 'quota' && kind !== 'too_large') {
        setTimeout(() => { void runCycle('retry'); }, backoffMs);
      }
    }
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

async function findMessage(peerId, messageId) {
  const cached = messageCache.get(`${peerId}:${messageId}`);
  if (cached) return cached;
  let skip = 0;
  for (;;) {
    const batch = await rawMessages()?.getBatch?.(peerId, { skip, limit: 100 });
    const messages = batch?.messages || [];
    for (const row of messages) cacheMessage(peerId, row);
    const found = messages.find((row) => row?.messageId === messageId);
    if (found) {
      trimMessageCache();
      return found;
    }
    if (!batch?.hasMore || messages.length === 0) {
      trimMessageCache();
      return null;
    }
    skip += messages.length;
  }
}

async function loadAllMessages(peerId) {
  const all = [];
  let skip = 0;
  for (;;) {
    const batch = await rawMessages()?.getBatch?.(peerId, { skip, limit: 100 });
    const messages = batch?.messages || [];
    all.unshift(...messages);
    for (const row of messages) cacheMessage(peerId, row);
    if (!batch?.hasMore || messages.length === 0) break;
    skip += messages.length;
  }
  return all;
}

async function buildOp(change, origin) {
  const ts = Number(change.ts) || Date.now();
  if (change.type === 'store-entry') {
    const current = await rawStore()?.get?.(change.key, null);
    const entries = entriesOfStore(change.key, current);
    if (change.deleted) {
      return {
        logicalKey: logicalKeyOf(change),
        op: { t: 'store-entry', key: change.key, id: change.id, deleted: true, ts, origin },
      };
    }
    if (!Object.prototype.hasOwnProperty.call(entries, change.id)) return null;
    return {
      logicalKey: logicalKeyOf(change),
      op: { t: 'store-entry', key: change.key, id: change.id, value: entries[change.id], ts, origin },
    };
  }
  if (change.type === 'store') {
    const value = await rawStore()?.get?.(change.key, null);
    return {
      logicalKey: `store:${change.key}`,
      op: { t: 'store', key: change.key, value, ts, origin },
    };
  }
  if (change.type === 'chat-del') {
    return {
      logicalKey: `chat:${change.peerId}`,
      op: { t: 'chat-del', peerId: change.peerId, ts, origin },
    };
  }
  if (change.type === 'msg-del') {
    return {
      logicalKey: `msg:${change.peerId}:${change.messageId}`,
      op: {
        t: 'msg-del',
        peerId: change.peerId,
        messageId: change.messageId,
        ts,
        origin,
      },
    };
  }
  if (change.type === 'msg') {
    const message = change.message || await findMessage(change.peerId, change.messageId);
    if (!message) return null;
    return {
      logicalKey: `msg:${change.peerId}:${change.messageId}`,
      op: {
        t: 'msg',
        peerId: change.peerId,
        message: prepareMessageForSync(message),
        origin,
      },
    };
  }
  return null;
}

function logDiscard(kind, logicalKey) {
  try {
    console.warn(`[BlueTalk Sync] Eintrag verworfen (${kind}): ${logicalKey || '?'}`);
  } catch {
    /* ignore */
  }
}

async function sealWithinLimit(live, built) {
  let op = built.op;
  let item = await sealSyncItem(live.encKey, live.macKey, built.logicalKey, op);
  if (jsonBytes(item) <= PUSH_ITEM_MAX_BYTES) return item;
  if (op?.t === 'msg' && op.message?.fileData) {
    op = {
      ...op,
      message: stripMessageFileData(op.message),
    };
    item = await sealSyncItem(live.encKey, live.macKey, built.logicalKey, op);
    if (jsonBytes(item) <= PUSH_ITEM_MAX_BYTES) return item;
  }
  return null;
}

async function pushPrepared(api, sealed, sentChanges) {
  if (sealed.length === 0) return;
  try {
    await api.push(sealed);
  } catch (error) {
    const kind = classifyError(error);
    if (kind !== 'too_large') throw error;
    if (sealed.length === 1) {
      logDiscard('too_large', logicalKeyOf(sentChanges[0]));
      memoryOutbox.removeSent(sentChanges);
      schedulePersist();
      return;
    }
    for (let i = 0; i < sealed.length; i += 1) {
      await pushPrepared(api, [sealed[i]], [sentChanges[i]]);
    }
    return;
  }
  memoryOutbox.removeSent(sentChanges);
  schedulePersist();
}

async function pushOutbox() {
  const live = getLiveAccount();
  if (!live) return;
  await hydrateOutbox();
  const api = apiForAccount(live);
  const origin = await getDeviceOrigin();
  while (memoryOutbox.length() > 0 && running) {
    const snapshot = memoryOutbox.snapshot();
    const sealed = [];
    const sent = [];
    for (const change of snapshot) {
      if (sealed.length >= PUSH_BATCH) break;
      const built = await buildOp(change, origin);
      if (!built) {
        memoryOutbox.removeSent([change]);
        schedulePersist();
        continue;
      }
      const item = await sealWithinLimit(live, built);
      if (!item) {
        logDiscard('too_large', built.logicalKey);
        memoryOutbox.removeSent([change]);
        schedulePersist();
        continue;
      }
      const nextBody = jsonBytes({ items: [...sealed, item] });
      if (sealed.length > 0 && nextBody > PUSH_BODY_MAX_BYTES - PUSH_BODY_SAFETY) break;
      if (nextBody > PUSH_BODY_MAX_BYTES - PUSH_BODY_SAFETY && sealed.length === 0) {
        logDiscard('too_large', built.logicalKey);
        memoryOutbox.removeSent([change]);
        schedulePersist();
        continue;
      }
      sealed.push(item);
      sent.push(change);
    }
    if (sealed.length === 0) {
      if (memoryOutbox.length() === snapshot.length) break;
      continue;
    }
    await pushPrepared(api, sealed, sent);
    const meta = await readMeta();
    let nextMeta = meta;
    for (const change of sent) {
      if (change.type === 'store-entry') {
        const current = await rawStore()?.get?.(change.key, null);
        const entries = entriesOfStore(change.key, current);
        nextMeta = appliedMetaAfterOp(nextMeta, {
          t: 'store-entry',
          key: change.key,
          id: change.id,
          ts: change.ts,
          ...(change.deleted ? { deleted: true } : { value: entries[change.id] ?? change.value }),
        });
      }
    }
    if (nextMeta !== meta) await writeMeta(nextMeta);
  }
}

async function applyOp(op, meta, outboxSnapshot) {
  if (!op || typeof op !== 'object') return { meta, applied: false };
  const store = rawStore();
  const messages = rawMessages();
  if (op.t === 'store-entry') {
    if (!SYNCED_STORE_KEYS.includes(op.key) || op.id == null || op.id === '') {
      return { meta, applied: false };
    }
    const logical = logicalKeyOfOp(op);
    if (!shouldApplyStoreEntry({
      incomingTs: op.ts,
      appliedTs: storeEntryAppliedTs(meta, op.key, op.id),
      pendingLocalTs: pendingTsFor(outboxSnapshot, logical),
    })) {
      return { meta, applied: false };
    }
    const current = await store?.get?.(op.key, op.key === 'contacts' || op.key === 'groups' ? [] : {});
    const merged = applyStoreEntryToValue(op.key, current, op.id, op);
    await store?.set?.(op.key, merged);
    return { meta: appliedMetaAfterOp(meta, op), applied: true };
  }
  if (op.t === 'store') {
    if (!SYNCED_STORE_KEYS.includes(op.key)) return { meta, applied: false };
    if (!shouldApplyStoreOp(op.ts, meta.storeTs[op.key])) return { meta, applied: false };
    const incomingEntries = entriesOfStore(op.key, op.value);
    let current = await store?.get?.(op.key, op.key === 'contacts' || op.key === 'groups' ? [] : {});
    let nextMeta = meta;
    let appliedAny = false;
    for (const [id, value] of Object.entries(incomingEntries)) {
      const logical = `store:${op.key}:${id}`;
      if (!shouldApplyStoreEntry({
        incomingTs: op.ts,
        appliedTs: storeEntryAppliedTs(nextMeta, op.key, id),
        pendingLocalTs: pendingTsFor(outboxSnapshot, logical),
      })) continue;
      current = applyStoreEntryToValue(op.key, current, id, { value });
      nextMeta = appliedMetaAfterOp(nextMeta, {
        t: 'store-entry',
        key: op.key,
        id,
        value,
        ts: op.ts,
        origin: op.origin,
      });
      appliedAny = true;
    }
    if (appliedAny) {
      await store?.set?.(op.key, current);
      nextMeta = appliedMetaAfterOp(nextMeta, op);
    }
    return { meta: nextMeta, applied: appliedAny };
  }
  if (op.t === 'chat-del' && op.peerId) {
    await messages?.deleteChat?.(op.peerId);
    return { meta: appliedMetaAfterOp(meta, op), applied: true };
  }
  if (op.t === 'msg-del' && op.peerId && op.messageId) {
    if (!shouldApplyMessage({ timestamp: op.ts }, meta.chatDel[op.peerId])) {
      return { meta, applied: false };
    }
    await messages?.deleteMessage?.(op.peerId, op.messageId);
    return { meta, applied: true };
  }
  if (op.t === 'msg' && op.peerId && op.message) {
    if (!shouldApplyMessage(op.message, meta.chatDel[op.peerId])) {
      return { meta, applied: false };
    }
    const message = op.message;
    const metaRow = await messages?.append?.(op.peerId, message);
    if (metaRow?.appended === false && message.messageId) {
      const { messageId, ...patch } = message;
      await messages?.patch?.(op.peerId, messageId, patch);
    }
    return { meta: appliedMetaAfterOp(meta, op), applied: true };
  }
  return { meta, applied: false };
}

function emitApplied(detail) {
  try {
    window.dispatchEvent(new CustomEvent('bluetalk:sync-applied', { detail }));
  } catch {
    /* ignore */
  }
}

async function pullRemote() {
  const live = getLiveAccount();
  if (!live) return;
  await hydrateOutbox();
  const api = apiForAccount(live);
  const origin = await getDeviceOrigin();
  let after = Number(live.lastSeq) || 0;
  let meta = await readMeta();
  const appliedOps = [];
  let more = true;
  while (more && running) {
    const page = await api.pull(after, PULL_LIMIT);
    const items = Array.isArray(page?.items) ? page.items : [];
    for (const item of items) {
      let op;
      try {
        op = await openSyncItem(live.encKey, item);
      } catch {
        if (typeof item.seq === 'number' && item.seq > after) after = item.seq;
        continue;
      }
      const logical = logicalKeyOfOp(op);
      const remoteTs = item.ts || op.ts;
      if (logical) memoryOutbox.dropIfRemoteNewer(logical, remoteTs);
      if (typeof item.seq === 'number' && item.seq > after) after = item.seq;
      if (shouldSkipOwnOrigin(op, origin)) continue;
      const result = await applyOp(op, meta, memoryOutbox.snapshot());
      meta = result.meta;
      if (result.applied) appliedOps.push(op);
    }
    if (typeof page?.latestSeq === 'number' && page.latestSeq > after) after = page.latestSeq;
    more = page?.more === true && items.length > 0;
    if (items.length === 0) more = false;
  }
  await writeMeta(meta);
  schedulePersist();
  await updateAccountSeq(after);
  if (appliedOps.length) emitApplied(peersAndStoresFromOps(appliedOps));
}

export async function fullUpload() {
  const live = getLiveAccount();
  if (!live?.encKey || !live?.macKey) throw new Error('Nicht angemeldet.');
  await hydrateOutbox();
  const changes = [];
  const now = Date.now();
  for (const key of SYNCED_STORE_KEYS) {
    const value = await rawStore()?.get?.(key, null);
    const diffs = diffStoreEntries(key, value, {});
    for (const diff of diffs) changes.push({ ...diff, ts: now });
  }
  const meta = await rawMessages()?.getMeta?.();
  for (const peerId of Object.keys(meta || {})) {
    if (!peerId || peerId === 'self') continue;
    const messages = await loadAllMessages(peerId);
    for (const message of messages) {
      if (!message?.messageId) continue;
      cacheMessage(peerId, message);
      changes.push({
        type: 'msg',
        peerId,
        messageId: message.messageId,
        ts: Number(message.timestamp) || now,
      });
    }
  }
  for (const change of changes) memoryOutbox.enqueue(change);
  schedulePersist();
  await flushPersist();
  if (!running) await startSync();
  else await runCycle('push');
  trimMessageCache();
}
