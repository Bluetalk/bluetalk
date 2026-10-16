// chatDrafts bewusst nicht: Entwürfe sind Tipp-Zustand pro Gerät
// (halbfertiger Text, Tastatur) und sollen nicht Desktop↔Handy kreisen.
const SYNCED_STORE_KEYS = Object.freeze([
  'contacts',
  'settings',
  'e2eeSessions',
  'groups',
  'chatReadReceipts',
  'chatLastViewedPeerTs',
]);

let sink = null;
let rawApi = null;

export { SYNCED_STORE_KEYS };

export function setSyncSink(next) {
  sink = next && typeof next.onLocalChange === 'function' ? next : null;
}

export function getRawApi() {
  return rawApi;
}

/** Ruft `fn(rawApi)` auf. Kein globaler Zähler — entfernte Ops über die rohe API anwenden. */
export function withoutSync(fn) {
  return fn(rawApi);
}

function report(change) {
  if (!sink) return;
  try {
    sink.onLocalChange(change);
  } catch {
    /* Senke darf den lokalen Pfad nicht blockieren */
  }
}

function isSyncedStoreKey(key) {
  return typeof key === 'string' && SYNCED_STORE_KEYS.includes(key);
}

export function wrapWithSync(api) {
  if (!api || typeof api !== 'object') return api;
  rawApi = api;
  const store = api.store || {};
  const messages = api.messages || {};

  return {
    ...api,
    store: {
      ...store,
      set: async (key, value) => {
        const result = await store.set(key, value);
        if (isSyncedStoreKey(key)) report({ type: 'store', key });
        return result;
      },
      delete: async (key) => {
        const result = await store.delete(key);
        if (isSyncedStoreKey(key)) report({ type: 'store', key });
        return result;
      },
    },
    messages: {
      ...messages,
      append: async (peerId, message) => {
        const result = await messages.append(peerId, message);
        const messageId = message?.messageId;
        if (peerId && messageId) report({ type: 'msg', peerId, messageId });
        return result;
      },
      patch: async (peerId, messageId, patch) => {
        const result = await messages.patch(peerId, messageId, patch);
        if (result !== false && peerId && messageId) {
          report({ type: 'msg', peerId, messageId });
        }
        return result;
      },
      deleteMessage: async (peerId, messageId) => {
        const result = await messages.deleteMessage(peerId, messageId);
        if (peerId && messageId) report({ type: 'msg-del', peerId, messageId });
        return result;
      },
      deleteChat: async (peerId) => {
        const result = await messages.deleteChat(peerId);
        if (peerId) report({ type: 'chat-del', peerId });
        return result;
      },
    },
  };
}
