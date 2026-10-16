const MAX_KEY_LENGTH = 256;
const MAX_KEY_SEGMENTS = 32;
const MAX_STORE_VALUE_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const DEFAULT_BATCH_SIZE = 24;
const MAX_BATCH_SIZE = 100;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SESSION_DB = 'bluetalk-web-session';
const DB_VERSION = 1;

function splitKey(key) {
  if (!key || key.length > MAX_KEY_LENGTH || key.includes('\0')) {
    throw new Error('invalid store key');
  }
  const segments = key.split('.');
  if (
    segments.length > MAX_KEY_SEGMENTS
    || segments.some((segment) => !segment || FORBIDDEN_SEGMENTS.has(segment))
  ) {
    throw new Error('invalid store key');
  }
  return segments;
}

function validatePeerId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > 192 || /[\0\r\n]/.test(trimmed)) {
    throw new Error('invalid peer or conversation id');
  }
  return trimmed;
}

function validateMessageId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.length > 192 || /[\0\r\n]/.test(trimmed)) {
    throw new Error('invalid message id');
  }
  return trimmed;
}

function ensureSize(bytes, limit, kind) {
  const size = new TextEncoder().encode(JSON.stringify(bytes)).length;
  if (size > limit) {
    throw new Error(`${kind} exceeds the ${Math.floor(limit / 1024 / 1024)} MiB limit`);
  }
}

function nowMillis() {
  return Date.now();
}

function summarizeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return message ?? null;
  const copy = { ...message };
  delete copy.fileData;
  delete copy.localPreviewUrl;
  return copy;
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('messages')) {
        const messages = db.createObjectStore('messages', { keyPath: 'seq', autoIncrement: true });
        messages.createIndex('byPeer', 'peerId', { unique: false });
        messages.createIndex('byPeerMessage', ['peerId', 'messageId'], { unique: false });
        messages.createIndex('byPeerStorage', ['peerId', 'storageId'], { unique: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'));
  });
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function setNested(root, segments, value) {
  if (segments.length === 0) return value;
  const object = root && typeof root === 'object' && !Array.isArray(root) ? { ...root } : {};
  if (segments.length === 1) {
    object[segments[0]] = value;
    return object;
  }
  object[segments[0]] = setNested(object[segments[0]], segments.slice(1), value);
  return object;
}

function deleteNested(root, segments) {
  if (!root || typeof root !== 'object' || Array.isArray(root)) return { next: root, changed: false };
  if (segments.length === 1) {
    if (!(segments[0] in root)) return { next: root, changed: false };
    const next = { ...root };
    delete next[segments[0]];
    return { next, changed: true };
  }
  const child = deleteNested(root[segments[0]], segments.slice(1));
  if (!child.changed) return { next: root, changed: false };
  return { next: { ...root, [segments[0]]: child.next }, changed: true };
}

function walk(value, segments) {
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function createIdbStore() {
  let sessionDbPromise = openDatabase(SESSION_DB);
  let accountDbPromise = null;
  let accountPeerId = '';

  async function sessionDb() {
    const db = await sessionDbPromise;
    if (db) return db;
    sessionDbPromise = openDatabase(SESSION_DB);
    return sessionDbPromise;
  }

  async function rememberPeerId(peerId) {
    const trimmed = String(peerId || '').trim();
    if (!trimmed || trimmed === accountPeerId) return;
    accountPeerId = trimmed;
    const session = await sessionDb();
    const tx = session.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key: 'activePeerId', value: trimmed });
    await txDone(tx);
    accountDbPromise = openDatabase(`bluetalk-web-${trimmed}`);
  }

  async function accountDb() {
    if (accountDbPromise) return accountDbPromise;
    const session = await sessionDb();
    const stored = await req(session.transaction('kv').objectStore('kv').get('activePeerId'));
    const peerId = stored?.value || '';
    if (peerId) {
      accountPeerId = peerId;
      accountDbPromise = openDatabase(`bluetalk-web-${peerId}`);
      return accountDbPromise;
    }
    return sessionDb();
  }

  async function kvGetRaw(key) {
    const db = await accountDb();
    const row = await req(db.transaction('kv').objectStore('kv').get(key));
    if (row) return row.value;
    if (db.name !== SESSION_DB) {
      const session = await sessionDb();
      const fallback = await req(session.transaction('kv').objectStore('kv').get(key));
      return fallback?.value;
    }
    return undefined;
  }

  async function kvPutRaw(key, value) {
    if (key === 'cloudAccount' && value?.peerId) {
      await rememberPeerId(value.peerId);
    }
    if (key === 'networkIdentity' && accountPeerId) {
      await rememberPeerId(accountPeerId);
    }
    const db = await accountDb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put({ key, value });
    await txDone(tx);
    if (key === 'cloudAccount' && value?.peerId && db.name !== SESSION_DB) {
      const session = await sessionDb();
      const copy = session.transaction('kv', 'readwrite');
      copy.objectStore('kv').put({ key, value });
      copy.objectStore('kv').put({ key: 'activePeerId', value: value.peerId });
      await txDone(copy);
    }
  }

  async function kvDeleteRaw(key) {
    const db = await accountDb();
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    await txDone(tx);
  }

  return {
    async openForPeer(peerId) {
      await rememberPeerId(peerId);
    },

    async get(key, defaultValue = null) {
      const segments = splitKey(key);
      if (segments[0] === 'messages') return defaultValue;
      const top = await kvGetRaw(segments[0]);
      if (top === undefined) return defaultValue;
      if (segments.length === 1) return top;
      const nested = walk(top, segments.slice(1));
      return nested === undefined ? defaultValue : nested;
    },

    async set(key, value) {
      const segments = splitKey(key);
      if (segments[0] === 'messages') {
        throw new Error('messages must be changed through the paginated message API');
      }
      ensureSize(value, MAX_STORE_VALUE_BYTES, 'store value');
      if (segments.length === 1) {
        await kvPutRaw(segments[0], value);
        return true;
      }
      const top = await kvGetRaw(segments[0]);
      const next = setNested(top, segments.slice(1), value);
      await kvPutRaw(segments[0], next);
      return true;
    },

    async delete(key) {
      const segments = splitKey(key);
      if (segments[0] === 'messages') {
        throw new Error('messages must be changed through the message API');
      }
      if (segments.length === 1) {
        const existing = await kvGetRaw(segments[0]);
        if (existing === undefined) return false;
        await kvDeleteRaw(segments[0]);
        return true;
      }
      const top = await kvGetRaw(segments[0]);
      if (top === undefined) return false;
      const result = deleteNested(top, segments.slice(1));
      if (!result.changed) return false;
      await kvPutRaw(segments[0], result.next);
      return true;
    },

    async getMeta() {
      const db = await accountDb();
      const rows = await req(db.transaction('messages').objectStore('messages').getAll());
      const byPeer = new Map();
      for (const row of rows.sort((a, b) => a.seq - b.seq)) {
        if (row.peerId === 'self') continue;
        let meta = byPeer.get(row.peerId);
        if (!meta) {
          meta = { count: 0, lastMessage: null };
          byPeer.set(row.peerId, meta);
        }
        meta.count += 1;
        meta.lastMessage = summarizeMessage(row.value);
      }
      const result = {};
      for (const peerId of [...byPeer.keys()].sort()) {
        const meta = byPeer.get(peerId);
        if (meta.count > 0) result[peerId] = meta;
      }
      return result;
    },

    async getBatch(peerId, options = {}) {
      const id = validatePeerId(peerId);
      const limit = Math.max(1, Math.min(MAX_BATCH_SIZE, options.limit ?? DEFAULT_BATCH_SIZE));
      const skip = Math.max(0, options.skip ?? 0);
      const db = await accountDb();
      const index = db.transaction('messages').objectStore('messages').index('byPeer');
      const rows = (await req(index.getAll(id))).sort((a, b) => a.seq - b.seq);
      const total = rows.length;
      const end = Math.max(0, total - skip);
      const start = Math.max(0, end - limit);
      const slice = rows.slice(start, end);
      return {
        messages: slice.map((row) => row.value),
        total,
        remaining: start,
        hasMore: start > 0,
        batchSize: slice.length,
      };
    },

    async append(peerId, message) {
      const id = validatePeerId(peerId);
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new Error('message must be an object');
      }
      ensureSize(message, MAX_MESSAGE_BYTES, 'message');
      const messageId = message.messageId
        ? validateMessageId(message.messageId)
        : null;
      const storageId = messageId || `anonymous-${crypto.randomUUID()}`;
      const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : nowMillis();
      const db = await accountDb();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const existing = await req(store.index('byPeerStorage').get([id, storageId]));
      let appended = false;
      if (!existing) {
        store.add({
          peerId: id,
          messageId,
          storageId,
          timestamp,
          value: message,
        });
        appended = true;
      }
      await txDone(tx);
      const meta = await this.chatMeta(id);
      meta.appended = appended;
      return meta;
    },

    async patch(peerId, messageId, patch) {
      const id = validatePeerId(peerId);
      const mid = validateMessageId(messageId);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('message patch must be an object');
      }
      const db = await accountDb();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const rows = await req(store.index('byPeerMessage').getAll([id, mid]));
      const row = rows.find((item) => item.messageId === mid);
      if (!row) {
        await txDone(tx);
        return false;
      }
      const next = { ...row.value };
      for (const [key, value] of Object.entries(patch)) {
        if (key !== 'messageId') next[key] = value;
      }
      ensureSize(next, MAX_MESSAGE_BYTES, 'message');
      store.put({ ...row, value: next });
      await txDone(tx);
      return true;
    },

    async deleteMessage(peerId, messageId) {
      const id = validatePeerId(peerId);
      const mid = validateMessageId(messageId);
      const db = await accountDb();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const rows = await req(store.index('byPeerMessage').getAll([id, mid]));
      let deleted = false;
      for (const row of rows) {
        if (row.messageId === mid) {
          store.delete(row.seq);
          deleted = true;
        }
      }
      await txDone(tx);
      return deleted;
    },

    async deleteChat(peerId) {
      const id = validatePeerId(peerId);
      const db = await accountDb();
      const tx = db.transaction('messages', 'readwrite');
      const store = tx.objectStore('messages');
      const rows = await req(store.index('byPeer').getAll(id));
      for (const row of rows) store.delete(row.seq);
      await txDone(tx);
      return rows.length > 0;
    },

    async chatMeta(peerId) {
      const db = await accountDb();
      const rows = (await req(
        db.transaction('messages').objectStore('messages').index('byPeer').getAll(peerId),
      )).sort((a, b) => a.seq - b.seq);
      const last = rows.length ? summarizeMessage(rows[rows.length - 1].value) : null;
      return { count: rows.length, lastMessage: last };
    },

    async listLibraryMedia() {
      const db = await accountDb();
      const rows = (await req(db.transaction('messages').objectStore('messages').getAll()))
        .sort((a, b) => (b.timestamp - a.timestamp) || (b.seq - a.seq));
      const items = [];
      for (const row of rows) {
        if (row.peerId === 'self') continue;
        const object = row.value;
        if (!object || typeof object !== 'object') continue;
        const kind = object.kind || '';
        if ((kind !== 'file' && kind !== 'sticker') || object.from === 'self') continue;
        const fileName = object.fileName || '';
        const fileType = object.fileType || '';
        items.push({
          messageId: object.messageId ?? null,
          peerId: row.peerId,
          from: object.from ?? null,
          sender: object.sender ?? null,
          timestamp: object.timestamp ?? 0,
          kind,
          fileName,
          fileType,
          fileSize: object.fileSize ?? 0,
          stickerId: object.stickerId ?? null,
          packId: object.packId ?? null,
          category: kind === 'sticker' ? 'sticker' : mediaCategory(fileType, fileName),
          hasData: Boolean(object.fileData),
        });
      }
      return items;
    },

    async getLibraryMediaData(peerId, messageId) {
      const id = validatePeerId(peerId);
      const mid = validateMessageId(messageId);
      const db = await accountDb();
      const rows = await req(
        db.transaction('messages').objectStore('messages').index('byPeerMessage').getAll([id, mid]),
      );
      const row = rows.find((item) => item.messageId === mid);
      if (!row?.value || (row.value.kind !== 'file' && row.value.kind !== 'sticker')) return null;
      return {
        fileData: row.value.fileData ?? null,
        fileName: row.value.fileName ?? null,
        fileType: row.value.fileType ?? null,
        fileSize: row.value.fileSize ?? null,
        kind: row.value.kind,
      };
    },

    async clearMessages() {
      const db = await accountDb();
      const tx = db.transaction('messages', 'readwrite');
      tx.objectStore('messages').clear();
      await txDone(tx);
    },

    async wipeAll() {
      const peerId = accountPeerId;
      await closeQuiet(accountDbPromise);
      await closeQuiet(sessionDbPromise);
      accountDbPromise = null;
      sessionDbPromise = Promise.resolve(null);
      accountPeerId = '';
      const names = new Set(['bluetalk-web-session']);
      if (peerId) names.add(`bluetalk-web-${peerId}`);
      try {
        if (typeof indexedDB.databases === 'function') {
          const listed = await indexedDB.databases();
          for (const entry of listed || []) {
            if (entry?.name?.startsWith('bluetalk-web-')) names.add(entry.name);
          }
        }
      } catch {
        /* Safari ohne databases() */
      }
      await Promise.all([...names].map(deleteDatabase));
      sessionDbPromise = openDatabase(SESSION_DB);
    },
  };
}

function closeQuiet(dbPromise) {
  return Promise.resolve(dbPromise).then((db) => {
    try {
      db?.close?.();
    } catch {
      /* ignore */
    }
  }).catch(() => {});
}

function deleteDatabase(name) {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    const finish = () => resolve();
    request.onsuccess = finish;
    request.onerror = finish;
    request.onblocked = () => setTimeout(finish, 300);
  });
}

function mediaCategory(mime, name) {
  const type = String(mime || '').toLowerCase();
  const extension = String(name || '').split('.').pop()?.toLowerCase() || '';
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extension)) {
    return 'image';
  }
  if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(extension)) {
    return 'video';
  }
  if (type.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(extension)) {
    return 'audio';
  }
  return 'other';
}
