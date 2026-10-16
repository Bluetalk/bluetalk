export const FILE_DATA_STRIP_BYTES = Math.floor(1.5 * 1024 * 1024);
export const PUSH_BATCH = 100;
export const PUSH_BODY_MAX_BYTES = 8 * 1024 * 1024;
export const PUSH_ITEM_MAX_BYTES = 3 * 1024 * 1024;
export const OUTBOX_KEY = 'cloudSyncOutbox';
export const META_KEY = 'cloudSyncApplied';
export const DEVICE_ID_KEY = 'cloudDeviceId';

/**
 * Gerätespezifische Settings-Felder, die nicht in die Cloud wandern.
 * Fenster-/Layout-Flags, Autostart, lokale Ports, Update-/Debug-Schalter,
 * Benachrichtigungs-Gerätezustand. Cloud-Relay liegt getrennt in der
 * Rust-Config; Ollama-Pfade in eigenen Store-Keys (aiChat.*).
 */
export const DEVICE_LOCAL_SETTINGS_KEYS = Object.freeze([
  'peerPort',
  'peerPorts',
  'apiPort',
  'autoUpdateEnabled',
  'autoDownloadUpdates',
  'minimizeToTray',
  'launchAtLogin',
  'debugMode',
  'windowsNotifications',
  'uiResize',
  'uiCollapse',
  'onboardingUsernameDone',
]);

const ARRAY_STORE_KEYS = new Set(['contacts', 'groups']);
const MAP_STORE_KEYS = new Set(['e2eeSessions', 'chatReadReceipts', 'chatLastViewedPeerTs']);

export function utf8ByteLength(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  return new TextEncoder().encode(value).byteLength;
}

export function jsonBytes(value) {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function prepareMessageForSync(message) {
  if (!message || typeof message !== 'object') return message;
  const next = { ...message };
  if (typeof next.fileData === 'string' && utf8ByteLength(next.fileData) > FILE_DATA_STRIP_BYTES) {
    delete next.fileData;
    next.syncStripped = true;
  }
  return next;
}

export function stripMessageFileData(message) {
  if (!message || typeof message !== 'object') return message;
  if (!Object.prototype.hasOwnProperty.call(message, 'fileData')) return message;
  const next = { ...message };
  delete next.fileData;
  next.syncStripped = true;
  return next;
}

export function isDeviceLocalSetting(field) {
  return DEVICE_LOCAL_SETTINGS_KEYS.includes(field);
}

export function logicalKeyOf(change) {
  if (!change || typeof change !== 'object') return '';
  if (change.type === 'store-entry') return `store:${change.key}:${change.id}`;
  if (change.type === 'store') return `store:${change.key}`;
  if (change.type === 'chat-del') return `chat:${change.peerId}`;
  if (change.type === 'msg' || change.type === 'msg-del') {
    return `msg:${change.peerId}:${change.messageId}`;
  }
  return '';
}

export function logicalKeyOfOp(op) {
  if (!op || typeof op !== 'object') return '';
  if (op.t === 'store-entry' && op.key && op.id != null && op.id !== '') {
    return `store:${op.key}:${op.id}`;
  }
  if (op.t === 'store' && op.key) return `store:${op.key}`;
  if (op.t === 'chat-del') return `chat:${op.peerId}`;
  if (op.t === 'msg' || op.t === 'msg-del') {
    return `msg:${op.peerId}:${op.messageId || op.message?.messageId}`;
  }
  return '';
}

function valueEqual(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function arrayEntryId(key, item) {
  if (!item || typeof item !== 'object') return '';
  if (key === 'groups') return String(item.id || item.groupId || '');
  return String(item.id || '');
}

export function entriesOfStore(key, value) {
  if (key === 'settings') {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const map = {};
    for (const [field, fieldValue] of Object.entries(obj)) {
      if (isDeviceLocalSetting(field)) continue;
      map[field] = fieldValue;
    }
    return map;
  }
  if (ARRAY_STORE_KEYS.has(key)) {
    const map = {};
    for (const item of Array.isArray(value) ? value : []) {
      const id = arrayEntryId(key, item);
      if (id) map[id] = item;
    }
    return map;
  }
  if (MAP_STORE_KEYS.has(key) || (value && typeof value === 'object' && !Array.isArray(value))) {
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const map = {};
    for (const [id, item] of Object.entries(obj)) {
      if (id) map[id] = item;
    }
    return map;
  }
  return {};
}

export function diffStoreEntries(key, currentValue, snapshotMap) {
  const current = entriesOfStore(key, currentValue);
  const prev = snapshotMap && typeof snapshotMap === 'object' && !Array.isArray(snapshotMap)
    ? snapshotMap
    : {};
  const changes = [];
  const ids = new Set([...Object.keys(current), ...Object.keys(prev)]);
  for (const id of ids) {
    const hasCur = Object.prototype.hasOwnProperty.call(current, id);
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, id);
    if (hasCur && hasPrev && valueEqual(current[id], prev[id])) continue;
    if (!hasCur && hasPrev) {
      changes.push({ type: 'store-entry', key, id, deleted: true });
    } else if (hasCur) {
      changes.push({ type: 'store-entry', key, id, value: current[id] });
    }
  }
  return changes;
}

export function applyStoreEntryToValue(key, currentValue, id, patch) {
  const entryId = String(id || '');
  if (!entryId) return currentValue;
  if (key === 'settings' && isDeviceLocalSetting(entryId)) return currentValue;

  if (ARRAY_STORE_KEYS.has(key)) {
    const list = Array.isArray(currentValue) ? currentValue.slice() : [];
    const idx = list.findIndex((item) => arrayEntryId(key, item) === entryId);
    if (patch?.deleted) {
      if (idx < 0) return list;
      list.splice(idx, 1);
      return list;
    }
    const nextItem = patch?.value;
    if (!nextItem || typeof nextItem !== 'object') return list;
    if (idx >= 0) list[idx] = nextItem;
    else list.push(nextItem);
    return list;
  }

  const obj = currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue)
    ? { ...currentValue }
    : {};
  if (patch?.deleted) {
    delete obj[entryId];
    return obj;
  }
  obj[entryId] = patch?.value;
  return obj;
}

export function snapshotAfterEntry(snapshotMap, id, patch) {
  const next = snapshotMap && typeof snapshotMap === 'object' ? { ...snapshotMap } : {};
  const entryId = String(id || '');
  if (!entryId) return next;
  if (patch?.deleted) delete next[entryId];
  else next[entryId] = patch?.value;
  return next;
}

export function mergeOutbox(outbox, change) {
  const next = Array.isArray(outbox) ? outbox.slice() : [];
  if (!change?.type) return next;
  const stamped = { ...change, ts: Number(change.ts) > 0 ? Number(change.ts) : Date.now() };
  if (stamped.type === 'chat-del') {
    const kept = next.filter((item) => {
      if (!item) return false;
      if (item.type === 'chat-del' && item.peerId === stamped.peerId) return false;
      if ((item.type === 'msg' || item.type === 'msg-del') && item.peerId === stamped.peerId) return false;
      return true;
    });
    kept.push(stamped);
    return kept;
  }
  if (stamped.type === 'msg-del') {
    const kept = next.filter((item) => !(
      item?.type === 'msg'
      && item.peerId === stamped.peerId
      && item.messageId === stamped.messageId
    ));
    const key = logicalKeyOf(stamped);
    const idx = kept.findIndex((item) => logicalKeyOf(item) === key);
    if (idx >= 0) kept[idx] = stamped;
    else kept.push(stamped);
    return kept;
  }
  const key = logicalKeyOf(stamped);
  if (!key) return next;
  const idx = next.findIndex((item) => logicalKeyOf(item) === key);
  if (idx >= 0) next[idx] = stamped;
  else next.push(stamped);
  return next;
}

export function dropOutboxIfRemoteNewer(outbox, logicalKey, remoteTs) {
  const ts = Number(remoteTs) || 0;
  return (Array.isArray(outbox) ? outbox : []).filter((item) => {
    if (logicalKeyOf(item) !== logicalKey) return true;
    return (Number(item.ts) || 0) > ts;
  });
}

export function removeSentFromOutbox(outbox, sent) {
  const marks = new Set(
    (Array.isArray(sent) ? sent : []).map((item) => `${logicalKeyOf(item)}\0${Number(item.ts) || 0}`),
  );
  return (Array.isArray(outbox) ? outbox : []).filter((item) => {
    const stamp = `${logicalKeyOf(item)}\0${Number(item.ts) || 0}`;
    return !marks.has(stamp);
  });
}

export function pendingTsFor(outbox, logicalKey) {
  let max = 0;
  for (const item of Array.isArray(outbox) ? outbox : []) {
    if (logicalKeyOf(item) === logicalKey) {
      max = Math.max(max, Number(item.ts) || 0);
    }
  }
  return max;
}

export function createMemoryOutbox(initial = []) {
  let items = Array.isArray(initial) ? initial.slice() : [];
  return {
    snapshot() {
      return items.slice();
    },
    length() {
      return items.length;
    },
    replace(next) {
      items = Array.isArray(next) ? next.slice() : [];
      return items.slice();
    },
    enqueue(change) {
      items = mergeOutbox(items, change);
      return items.slice();
    },
    removeSent(sent) {
      items = removeSentFromOutbox(items, sent);
      return items.slice();
    },
    dropIfRemoteNewer(logicalKey, remoteTs) {
      items = dropOutboxIfRemoteNewer(items, logicalKey, remoteTs);
      return items.slice();
    },
  };
}

export function shouldApplyStoreOp(incomingTs, appliedTs) {
  return (Number(incomingTs) || 0) >= (Number(appliedTs) || 0);
}

export function shouldApplyStoreEntry({ incomingTs, appliedTs, pendingLocalTs } = {}) {
  const incoming = Number(incomingTs) || 0;
  if ((Number(pendingLocalTs) || 0) > incoming) return false;
  return incoming >= (Number(appliedTs) || 0);
}

export function shouldApplyMessage(message, chatDelTs) {
  const tombstone = Number(chatDelTs) || 0;
  if (tombstone <= 0) return true;
  const ts = Number(message?.timestamp) || Number(message?.ts) || 0;
  return ts > tombstone;
}

export function shouldSkipOwnOrigin(op, origin) {
  return Boolean(origin && op?.origin && op.origin === origin);
}

export function emptySyncMeta() {
  return {
    storeTs: {},
    chatDel: {},
    storeSnapshots: {},
    storeEntryTs: {},
  };
}

export function normalizeSyncMeta(value) {
  const base = emptySyncMeta();
  if (!value || typeof value !== 'object') return base;
  if (value.storeTs && typeof value.storeTs === 'object') base.storeTs = { ...value.storeTs };
  if (value.chatDel && typeof value.chatDel === 'object') base.chatDel = { ...value.chatDel };
  if (value.storeSnapshots && typeof value.storeSnapshots === 'object') {
    base.storeSnapshots = {};
    for (const [key, snap] of Object.entries(value.storeSnapshots)) {
      base.storeSnapshots[key] = snap && typeof snap === 'object' ? { ...snap } : {};
    }
  }
  if (value.storeEntryTs && typeof value.storeEntryTs === 'object') {
    base.storeEntryTs = { ...value.storeEntryTs };
  }
  return base;
}

function entryTsKey(storeKey, id) {
  return `${storeKey}:${id}`;
}

export function appliedMetaAfterOp(meta, op) {
  const next = normalizeSyncMeta(meta);
  if (op?.t === 'store' && op.key) {
    next.storeTs[op.key] = Number(op.ts) || 0;
    next.storeSnapshots[op.key] = entriesOfStore(op.key, op.value);
  }
  if (op?.t === 'store-entry' && op.key && op.id != null && op.id !== '') {
    const id = String(op.id);
    next.storeEntryTs[entryTsKey(op.key, id)] = Number(op.ts) || 0;
    next.storeSnapshots[op.key] = snapshotAfterEntry(
      next.storeSnapshots[op.key],
      id,
      op.deleted ? { deleted: true } : { value: op.value },
    );
  }
  if (op?.t === 'chat-del' && op.peerId) {
    const ts = Number(op.ts) || 0;
    const prev = Number(next.chatDel[op.peerId]) || 0;
    if (ts >= prev) next.chatDel[op.peerId] = ts;
  }
  if (op?.t === 'msg' && op.peerId) {
    const ts = Number(op.message?.timestamp) || Number(op.ts) || 0;
    const tombstone = Number(next.chatDel[op.peerId]) || 0;
    if (ts > tombstone) delete next.chatDel[op.peerId];
  }
  return next;
}

export function storeEntryAppliedTs(meta, key, id) {
  return Number(meta?.storeEntryTs?.[entryTsKey(key, id)]) || 0;
}

export function peersAndStoresFromOps(ops) {
  const peers = new Set();
  const storeKeys = new Set();
  for (const op of ops || []) {
    if ((op?.t === 'store' || op?.t === 'store-entry') && op.key) storeKeys.add(op.key);
    if (op?.peerId) peers.add(op.peerId);
    if (op?.t === 'msg' && op.message?.peerId) peers.add(op.message.peerId);
  }
  return {
    peers: [...peers],
    storeKeys: [...storeKeys],
  };
}

const wipeListeners = new Set();

export function onSyncArtifactsCleared(cb) {
  if (typeof cb !== 'function') return () => undefined;
  wipeListeners.add(cb);
  return () => wipeListeners.delete(cb);
}

export async function clearSyncPersistence(store) {
  if (store) {
    if (typeof store.set === 'function') await store.set(OUTBOX_KEY, []);
    if (typeof store.delete === 'function') await store.delete(META_KEY);
  }
  for (const cb of wipeListeners) {
    try { cb(); } catch { /* ignore */ }
  }
}
