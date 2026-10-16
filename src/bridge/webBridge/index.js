import { wrapWithSync } from '../syncLayer.js';
import { createEventBus } from './events.js';
import { createGameWindows } from './games.js';
import { createIdbStore } from './idbStore.js';
import {
  b64ToBytes,
  identityFromSeed,
  openInitiatorSession,
  openResponderSession,
} from './peerProtocol/index.js';
import { DEFAULT_RELAY_URL, RelayClient } from './relayClient.js';
import { shouldPurgeEphemeral } from './persistFlags.js';

const bus = createEventBus();
const storeApi = createIdbStore();
const peers = new Map();
let identity = null;
let relay = null;
let runtimePromise = null;
let displayNameCache = 'BlueTalk user';

function unavailable(feature) {
  return async () => {
    throw new Error(`${feature} ist im Browser nicht verfügbar.`);
  };
}

function emptyState() {
  return {
    runtimeMode: '',
    runtimeStatus: 'missing',
    runtimePath: '',
    runtimeError: '',
    runtimePercent: 0,
    runtimeDownloadedBytes: 0,
    runtimeTotalBytes: 0,
    serverRunning: false,
    selectedModelTier: '',
    modelStatus: {},
    modelPercent: {},
    modelDownloadedBytes: {},
    modelTotalBytes: {},
    modelProgressStatus: {},
    modelError: {},
    cloudAuth: false,
    selectedCloudModelId: '',
    setupComplete: false,
    activeModel: '',
  };
}

function updaterState() {
  return {
    supported: false,
    status: 'unsupported',
    message: 'Aktualisierungen gibt es nur in der Desktop-App.',
    errorMessage: '',
    currentVersion: '',
    availableVersion: '',
    downloadedVersion: '',
    releaseName: '',
    releaseDate: 0,
    autoUpdateEnabled: false,
    autoDownloadUpdates: false,
    percent: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    lastCheckedAt: 0,
  };
}

async function loadIdentity() {
  const stored = await storeApi.get('networkIdentity', null);
  const seedB64 = stored?.seedB64 || stored?.secretKey || (typeof stored === 'string' ? stored : '');
  if (!seedB64) return null;
  return identityFromSeed(b64ToBytes(seedB64));
}

async function refreshDisplayName() {
  const name = await storeApi.get('settings.displayName', '');
  const trimmed = String(name || '').trim();
  displayNameCache = trimmed ? trimmed.slice(0, 100) : 'BlueTalk user';
  return displayNameCache;
}

function peerList() {
  return [...peers.values()].map((entry) => entry.info);
}

function emitPeerList() {
  bus.emit('peers:list-sync', peerList());
}

function handlePeerMessage(fromPeerId, messageId, sentAtMs, payload) {
  const kind = payload?.kind || '';
  if (kind === 'bt2:file-request' || kind === 'bt2:file-response') return;
  const event = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload }
    : { content: payload };
  event.from = fromPeerId;
  if (event.timestamp == null) event.timestamp = sentAtMs;
  if (!event.transportMessageId) event.transportMessageId = messageId;
  if (kind === 'file-hosted') bus.emit('peer:file-offered', event);
  bus.emit('peer:message', event);
}

function forgetPeer(peerId, reason) {
  if (!peers.has(peerId)) return;
  peers.delete(peerId);
  bus.emit('peer:disconnected', { id: peerId, reason });
  emitPeerList();
}

async function attachTunnel({ peerId, initiator, send, remoteAddress, onReady }) {
  if (!identity) throw new Error('identity unavailable');
  const name = await refreshDisplayName();
  const opener = initiator ? openInitiatorSession : openResponderSession;
  const { transport, ready } = await opener({
    sendBytes: async (bytes) => send(bytes),
    identity,
    displayName: name,
    expectedPeerId: initiator ? peerId : undefined,
    remoteAddress,
    onMessage: (message) => {
      handlePeerMessage(message.fromPeerId, message.messageId, message.sentAtMs, message.payload);
    },
    onClose: (reason) => forgetPeer(peerId, reason || 'connection closed'),
  });
  onReady?.({
    push: (chunk) => transport.push(chunk),
    close: () => transport.close(),
  });
  const { info, peer } = await ready;
  if (info.id === identity.peerId) {
    await peer.close('refusing to connect to self');
    throw new Error('refusing to connect to self');
  }
  const existing = peers.get(info.id);
  if (existing) {
    const own = identity.peerId;
    const preferred = own < info.id ? 'outbound' : 'inbound';
    if (info.direction === preferred) {
      await existing.peer.close('replaced by preferred relay leg');
    } else {
      await peer.close('duplicate');
      return existing.info;
    }
  }
  peers.set(info.id, { info, peer, transport });
  bus.emit('peer:connected', info);
  emitPeerList();
  return info;
}

function watchIdsFromContacts(contacts) {
  if (!Array.isArray(contacts)) return [];
  return contacts
    .filter((contact) => contact?.id && contact.blocked !== true)
    .map((contact) => contact.id);
}

function isBlockedContact(contacts, peerId) {
  return Array.isArray(contacts) && contacts.some((contact) => contact?.id === peerId && contact.blocked === true);
}

async function contacts() {
  const value = await storeApi.get('contacts', []);
  return Array.isArray(value) ? value : [];
}

function createRelay() {
  return new RelayClient({
    getIdentity: () => identity,
    getDisplayName: () => displayNameCache,
    getWatchIds: () => watchCache,
    isBlocked: (peerId) => blockedCache.has(peerId),
    hasPeer: (peerId) => peers.has(peerId),
    onStatus: (status) => bus.emit('cloud:status', status),
    onPresence: (payload) => bus.emit('cloud:presence', payload),
    onMail: (payload) => bus.emit('cloud:mail', payload),
    attachTunnel,
  });
}

let watchCache = [];
let blockedCache = new Set();

async function refreshContactCaches() {
  const list = await contacts();
  watchCache = watchIdsFromContacts(list);
  blockedCache = new Set(list.filter((c) => c?.blocked).map((c) => c.id));
  relay?.refreshWatch();
}

async function startRuntime() {
  identity = await loadIdentity();
  if (!identity) return false;
  await storeApi.openForPeer(identity.peerId);
  await refreshDisplayName();
  await refreshContactCaches();
  if (!relay) relay = createRelay();
  const cloud = await storeApi.get('settings.cloud', null);
  if (cloud && typeof cloud === 'object') {
    try {
      relay.setConfig({
        enabled: cloud.enabled !== false,
        relayUrl: cloud.relayUrl || DEFAULT_RELAY_URL,
      });
    } catch {
      relay.setConfig({ enabled: true, relayUrl: DEFAULT_RELAY_URL });
    }
  }
  relay.start();
  return true;
}

const bootPromise = (async () => {
  if (shouldPurgeEphemeral()) {
    try {
      await storeApi.wipeAll();
    } catch {
      /* Login bleibt leer */
    }
  }
})();

async function afterBoot(fn) {
  await bootPromise;
  return fn();
}

function ensureRuntime() {
  if (!runtimePromise) {
    runtimePromise = bootPromise.then(() => startRuntime());
  }
  return runtimePromise;
}

function restartRuntime() {
  runtimePromise = (runtimePromise || Promise.resolve()).catch(() => {}).then(() => startRuntime());
  return runtimePromise;
}

window.addEventListener('bluetalk:web-identity-ready', () => {
  void restartRuntime();
});

void bootPromise.then(() => ensureRuntime());

async function downloadBlob(name, data) {
  const bytes = typeof data === 'string'
    ? b64ToBytes(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array();
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name || 'download.bin';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { ok: true, path: name || 'download.bin' };
}

const games = createGameWindows(bus);

const rawApi = {
  window: Object.freeze({
    minimize: async () => undefined,
    maximize: async () => false,
    close: async () => undefined,
    getMaximized: async () => false,
    onMaximizedChange: (callback) => bus.subscribe('window:maximized', callback),
  }),

  store: Object.freeze({
    get: (key, defaultValue) => afterBoot(() => storeApi.get(key, defaultValue)),
    set: async (key, value) => afterBoot(async () => {
      const result = await storeApi.set(key, value);
      if (key === 'contacts' || key.startsWith('contacts.')) await refreshContactCaches();
      if (key === 'settings.displayName' || key === 'settings') await refreshDisplayName();
      if (key === 'networkIdentity' || key === 'settings.cloud') {
        await restartRuntime();
      }
      return result;
    }),
    delete: (key) => afterBoot(() => storeApi.delete(key)),
  }),

  messages: Object.freeze({
    getMeta: () => afterBoot(() => storeApi.getMeta()),
    getBatch: (peerId, options = {}) => afterBoot(() => storeApi.getBatch(peerId, options)),
    append: (peerId, message) => afterBoot(() => storeApi.append(peerId, message)),
    patch: (peerId, messageId, patch) => afterBoot(() => storeApi.patch(peerId, messageId, patch)),
    deleteMessage: (peerId, messageId) => afterBoot(() => storeApi.deleteMessage(peerId, messageId)),
    deleteChat: (peerId) => afterBoot(() => storeApi.deleteChat(peerId)),
  }),

  peer: Object.freeze({
    getInfo: async () => {
      await ensureRuntime();
      const name = await refreshDisplayName();
      return {
        id: identity?.peerId || '',
        name,
        port: 0,
        ports: [],
        addresses: [],
        endpoints: [],
        peers: peerList(),
        hostedFiles: [],
        started: Boolean(identity),
      };
    },
    connect: async (address) => {
      await ensureRuntime();
      if (!relay || relay.getStatus().state !== 'online') {
        throw new Error('Cloud ist nicht online.');
      }
      let peerId = '';
      if (typeof address === 'string') {
        peerId = address.startsWith('bt2_') ? address.trim() : '';
        if (!peerId) throw new Error('Im Browser ist nur eine Cloud-Verbindung über die Peer-ID möglich.');
      } else if (address && typeof address === 'object') {
        peerId = address.id || address.peerId || '';
      }
      if (!peerId) throw new Error('connect target needs an address or peer id');
      if (peers.has(peerId)) return peers.get(peerId).info;
      const list = await contacts();
      if (isBlockedContact(list, peerId)) throw new Error('Kontakt ist blockiert.');
      const info = await relay.openPeer(peerId);
      return info || peers.get(peerId)?.info;
    },
    normalizeAddress: async (raw) => ({ ok: false, error: 'invalid address' }),
    reconnectContacts: async () => {
      await ensureRuntime();
      const list = await contacts();
      for (const contact of list) {
        if (!contact?.id || contact.blocked || peers.has(contact.id)) continue;
        relay?.openPeer(contact.id).catch(() => {});
      }
      return { ok: true };
    },
    resetAllConnections: async () => {
      for (const entry of [...peers.values()]) {
        await entry.peer.close('reset');
      }
      await rawApi.peer.reconnectContacts();
      return { ok: true };
    },
    disconnect: async (peerId) => {
      const entry = peers.get(peerId);
      if (!entry) return true;
      await entry.peer.close('closed locally');
      return true;
    },
    send: async (peerId, data) => {
      const entry = peers.get(peerId);
      if (!entry) return false;
      try {
        return Boolean(await entry.peer.sendPayload(data));
      } catch {
        return false;
      }
    },
    sendMany: async (peerIds, data) => Promise.all(
      (peerIds || []).map(async (peerId) => ({
        peerId,
        sent: await rawApi.peer.send(peerId, data),
      })),
    ),
    broadcast: async (data) => rawApi.peer.sendMany([...peers.keys()], data),
    getPeers: async () => peerList(),
    refreshDiscovery: async () => undefined,
  }),

  file: Object.freeze({
    host: unavailable('Datei-Hosting'),
    getHosted: async () => [],
    request: unavailable('Datei-Anfragen'),
    saveAs: async (payload) => downloadBlob(
      payload?.name || payload?.fileName || payload?.payload?.name,
      payload?.data || payload?.fileData || payload?.payload?.data,
    ),
    openPath: unavailable('Lokale Dateipfade'),
  }),

  library: Object.freeze({
    listMedia: () => storeApi.listLibraryMedia(),
    getMediaData: (peerId, messageId) => storeApi.getLibraryMediaData(peerId, messageId),
  }),

  notify: Object.freeze({
    show: async (payload = {}) => {
      const enabled = await storeApi.get('settings.windowsNotifications', true);
      const dnd = await storeApi.get('settings.doNotDisturb', false);
      if (!enabled || dnd) return false;
      if (document.hasFocus() && !payload.allowInForeground) return false;
      if (typeof Notification === 'undefined') return false;
      if (Notification.permission === 'default') {
        if (!navigator.userActivation?.isActive) return false;
        try {
          await Notification.requestPermission();
        } catch {
          return false;
        }
      }
      if (Notification.permission !== 'granted') return false;
      const title = String(payload.title || 'BlueTalk').slice(0, 160);
      const body = String(payload.body || '').slice(0, 500);
      const note = new Notification(title, { body, silent: Boolean(payload.silent) });
      note.onclick = () => {
        window.focus();
        note.close();
      };
      return true;
    },
  }),

  network: Object.freeze({
    testPorts: async () => ({
      host: '',
      testedAt: Date.now(),
      checks: [],
      recommendedPort: null,
      summary: { openCount: 0, blockedCount: 0 },
    }),
    doctor: async () => ({
      checkedAt: Date.now(),
      portProbe: { summary: { openCount: 0, blockedCount: 0 } },
      peerInfo: await rawApi.peer.getInfo(),
      apiPort: null,
      issues: [{ code: 'web_runtime', message: 'LAN-Diagnose ist im Browser nicht verfügbar.' }],
      fixes: ['Nutze BlueTalk Cloud, um Peers über das Internet zu erreichen.'],
    }),
    getApiAccess: async () => ({ enabled: false, port: null }),
  }),

  updater: Object.freeze({
    getState: async () => updaterState(),
    check: async () => updaterState(),
    download: unavailable('Aktualisierungen'),
    install: unavailable('Aktualisierungen'),
  }),

  ollama: Object.freeze({
    getState: async () => emptyState(),
    getModelCatalog: async () => [],
    downloadRuntime: unavailable('Lokale KI'),
    selectRuntimeMode: async () => emptyState(),
    selectModelTier: async () => emptyState(),
    selectCloudModel: async () => emptyState(),
    downloadModel: unavailable('Lokale KI'),
    deleteModel: unavailable('Lokale KI'),
    openModelsDir: unavailable('Lokale KI'),
    getStoragePaths: async () => ({}),
    chat: unavailable('Lokale KI'),
    abortChat: async () => undefined,
    clearAgentContext: async () => undefined,
    onAskUser: (callback) => bus.subscribe('ollama:ask-user', callback),
    onAskUserDone: (callback) => bus.subscribe('ollama:ask-user-done', callback),
    replyAskUser: async () => undefined,
    startCloudSignIn: unavailable('Lokale KI'),
    confirmCloudAuth: unavailable('Lokale KI'),
    resetAndDelete: unavailable('Lokale KI'),
    runRoutine: unavailable('Lokale KI'),
  }),

  agent: Object.freeze({
    pickFolder: async () => null,
    sendMessageReply: async () => undefined,
    connectPeerReply: async () => undefined,
  }),

  ...games,

  app: Object.freeze({
    clearCache: async () => true,
    clearMessages: async () => {
      await storeApi.clearMessages();
      bus.emit('app:data-cleared', { scope: 'messages' });
      return true;
    },
    wipeAllData: async () => {
      for (const entry of [...peers.values()]) {
        try {
          await entry.peer.close('sign-out');
        } catch {
          /* ignore */
        }
      }
      peers.clear();
      try {
        await relay?.stop();
      } catch {
        /* ignore */
      }
      relay = null;
      identity = null;
      runtimePromise = null;
      watchCache = [];
      blockedCache = new Set();
      await storeApi.wipeAll();
      bus.emit('app:data-cleared', { scope: 'all' });
      return true;
    },
    getConfigLogPath: async () => '',
    readConfigTail: async () => '',
    openUrl: async (url) => {
      window.open(String(url || ''), '_blank', 'noopener,noreferrer');
      return true;
    },
  }),

  cloud: Object.freeze({
    getStatus: async () => {
      await ensureRuntime();
      return relay?.getStatus() || {
        enabled: true,
        relayUrl: DEFAULT_RELAY_URL,
        state: 'offline',
        peerId: identity?.peerId || '',
        lastError: null,
        latencyMs: null,
        connectedAt: null,
        tunnels: 0,
        onlinePeers: [],
      };
    },
    setConfig: async (config) => {
      await ensureRuntime();
      if (!relay) relay = createRelay();
      const status = relay.setConfig(config || {});
      await storeApi.set('settings.cloud', { enabled: status.enabled, relayUrl: status.relayUrl });
      return status;
    },
    postMail: async (peerId, body, id) => {
      await ensureRuntime();
      return relay.postMail(peerId, body, id);
    },
    drainMail: async () => relay?.drainMail() || [],
    ackMail: async (ids) => relay?.ackMail(ids),
    refreshWatch: async () => {
      await refreshContactCaches();
    },
    takeover: async () => {
      await ensureRuntime();
      if (!relay) relay = createRelay();
      return relay.takeover();
    },
    onStatus: (callback) => bus.subscribe('cloud:status', callback),
    onPresence: (callback) => bus.subscribe('cloud:presence', callback),
    onMail: (callback) => bus.subscribe('cloud:mail', callback),
  }),

  account: Object.freeze({
    exportIdentity: async () => {
      const stored = await storeApi.get('networkIdentity', null);
      const seedB64 = stored?.seedB64 || stored?.secretKey || (typeof stored === 'string' ? stored : '');
      if (!seedB64) throw new Error('Keine Identität vorhanden.');
      return { seedB64 };
    },
    importIdentity: async (seedB64) => {
      const seed = String(seedB64 || '').trim();
      if (!seed) throw new Error('seedB64 fehlt');
      identityFromSeed(b64ToBytes(seed));
      await storeApi.set('networkIdentity', { seedB64: seed });
      await restartRuntime();
      return { ok: true };
    },
  }),

  plugins: Object.freeze({
    list: async () => [],
    rescan: async () => [],
    reseedBundled: async () => [],
    setEnabled: unavailable('Erweiterungen'),
    openDir: unavailable('Erweiterungen'),
    installFromDialog: unavailable('Erweiterungen'),
    install: unavailable('Erweiterungen'),
    uninstall: unavailable('Erweiterungen'),
    invokeCommand: unavailable('Erweiterungen'),
    sendToMain: async () => undefined,
  }),

  on: bus.subscribe,
};

const synced = wrapWithSync(rawApi);
const api = Object.freeze({
  ...synced,
  store: Object.freeze(synced.store),
  messages: Object.freeze(synced.messages),
});

Object.defineProperty(window, 'bluetalk', {
  value: api,
  configurable: false,
  enumerable: true,
  writable: false,
});

export default api;
