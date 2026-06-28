const { EventEmitter } = require('events');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const vm = require('vm');
const { app, Notification } = require('electron');

const MAX_PLUGIN_FILES = 250;
const MAX_PLUGIN_BYTES = 25 * 1024 * 1024;
const RESERVED_IDS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * PluginHost — loads user plugins from `<userData>/plugins/<id>/`.
 *
 * Each plugin folder must contain `manifest.json`. Optional files:
 *   - main.js : runs in a Node VM sandbox with access to the host API
 *   - ui.js   : source is shipped to the renderer, executed there via the
 *               renderer-side runtime (`src/renderer/plugins/pluginRuntime.js`)
 *
 * Manifest fields:
 *   id            string (slug; must match folder name)
 *   name          string (display name)
 *   version       string
 *   description   string
 *   author        string
 *   main          string (optional: main-process entry, default "main.js")
 *   ui            string (optional: renderer entry, default "ui.js")
 *   permissions   string[] (informational; all APIs are currently available)
 *   autoEnable    boolean (default true on first install)
 *   debugOnly     boolean (only visible/active when settings.debugMode is true)
 *   game          boolean | object (game plugin — appears in built-in Spiele tab, no sidebar tab)
 *                 object fields: mark, title, description, alphaNotice, labels { launchNew, launchResume, openWindow }
 *
 * Plugin main-process API (exposed via `host.api`):
 *   store.get(key, default) / set(key, value) / delete(key)   // namespaced per plugin
 *   peer.send(peerId, data)   peer.broadcast(data)   peer.sendMany(peerIds, data)
 *   peer.list()               peer.connect(addr)   peer.disconnect(id)
 *   peer.info()
 *   realtime.createRoom(opts) / joinRoom(opts) / listRooms() / getRoom(id) / on(event, fn)
 *   realtime rooms: broadcast, sendTo, invite, createDocument, leave — see docs
 *   contacts.list() / update(patch) / remove(id) / block(id) / unblock(id)
 *   messages.list(peerId)     messages.append(peerId, msg)
 *   messages.patch(peerId, messageId, patch)
 *   messages.delete(peerId, messageId)
 *   notify.show({title, body})
 *   events.on(name, fn) => off()  // peer:connected, peer:disconnected,
 *                                  // peer:message, peer:file-offered,
 *                                  // peer:file-received, peer:discovered
 *   log.info/warn/error(...args)
 *   timer.setTimeout / setInterval / clearTimeout / clearInterval
 *   registerCommand(id, handler)  // invoke via plugins.invokeCommand in renderer
 *
 * Plugins may export a default module function `module.exports = (api) => {...}`
 * or an object with `activate(api)` / `deactivate()` lifecycle callbacks.
 */

const ALLOWED_EVENTS = [
  'peer:connected',
  'peer:disconnected',
  'peer:message',
  'peer:file-offered',
  'peer:file-received',
  'peer:discovered',
];

function safeId(raw) {
  const id = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
  return RESERVED_IDS.has(id) ? '' : id;
}

function resolvePluginEntry(dir, requested, fallback) {
  const relative = String(requested || fallback).replace(/\\/g, '/');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').some((part) => part === '..')) return '';
  const resolved = path.resolve(dir, relative);
  const rel = path.relative(path.resolve(dir), resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || path.extname(resolved).toLowerCase() !== '.js') return '';
  return resolved;
}

function resolvePluginPayloadPath(root, value) {
  const relative = String(value || '').replace(/\\/g, '/');
  if (!relative || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '..')) return '';
  const resolved = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), resolved);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? resolved : '';
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function readFileSafe(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

class PluginHost extends EventEmitter {
  constructor({ peerServer, store, mainWindowRef, isAppInForegroundRef }) {
    super();
    this.peerServer = peerServer;
    this.store = store;
    this.mainWindowRef = mainWindowRef;
    this.isAppInForegroundRef = isAppInForegroundRef;
    this.pluginsDir = path.join(app.getPath('userData'), 'plugins');
    /** @type {Map<string, { manifest: any, dir: string, enabled: boolean, module?: any, api?: any, context?: any, commands: Map<string, Function>, disposers: Set<Function>, timers: Set<any>, ui?: string, lastError?: string }>} */
    this.plugins = new Map();
    this._peerListeners = [];
  }

  async init() {
    try {
      await fsp.mkdir(this.pluginsDir, { recursive: true });
    } catch (e) {
      console.error('[PluginHost] mkdir plugins dir:', e);
    }
    this._hookPeerEvents();
    await this.scan();
  }

  _hookPeerEvents() {
    for (const event of ALLOWED_EVENTS) {
      const fn = (data) => this._dispatchEvent(event, data);
      this.peerServer.on(event, fn);
      this._peerListeners.push({ event, fn });
    }
  }

  _dispatchEvent(name, data) {
    for (const plugin of this.plugins.values()) {
      if (!plugin.enabled) continue;
      const bucket = plugin.eventListeners?.get(name);
      if (!bucket) continue;
      for (const listener of bucket) {
        try {
          listener(data);
        } catch (e) {
          console.error(`[PluginHost] ${plugin.manifest.id} ${name} handler:`, e);
        }
      }
    }
    this.emit('plugin:event', { name, data });
    const win = this.mainWindowRef?.();
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send('plugins:event', { name, data });
      } catch {
        /* ignore */
      }
    }
  }

  getEnabledMap() {
    return this.store.get('plugins.enabled', {}) || {};
  }

  _isDebugMode() {
    return Boolean(this.store?.get('settings.debugMode', false));
  }

  _isDebugOnly(manifest) {
    return manifest?.debugOnly === true;
  }

  _isGameManifest(manifest) {
    const game = manifest?.game;
    return game === true || (typeof game === 'object' && game !== null);
  }

  _isPluginVisible(record) {
    if (this._isGameManifest(record.manifest)) return true;
    if (!this._isDebugOnly(record.manifest)) return true;
    return this._isDebugMode();
  }

  _effectiveEnabled(id, manifest, enabledMap) {
    const userWantsEnabled =
      Object.prototype.hasOwnProperty.call(enabledMap, id)
        ? Boolean(enabledMap[id])
        : manifest.autoEnable === true;
    if (this._isDebugOnly(manifest) && !this._isDebugMode() && !this._isGameManifest(manifest)) {
      return false;
    }
    return userWantsEnabled;
  }

  setEnabled(id, enabled) {
    const map = { ...this.getEnabledMap(), [id]: Boolean(enabled) };
    this.store.set('plugins.enabled', map);
  }

  async scan() {
    const entries = await fsp.readdir(this.pluginsDir, { withFileTypes: true }).catch(() => []);
    const seen = new Set();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = safeId(entry.name);
      if (!id) continue;
      seen.add(id);
      await this._loadOne(id);
    }

    // Unload plugins whose folder no longer exists
    for (const id of Array.from(this.plugins.keys())) {
      if (!seen.has(id)) {
        await this._unload(id);
        this.plugins.delete(id);
      }
    }

    return this.listPlugins();
  }

  async _loadOne(id) {
    const dir = path.join(this.pluginsDir, id);
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath);
    if (!manifest || !manifest.id || safeId(manifest.id) !== id) {
      console.warn(`[PluginHost] ${id}: missing or invalid manifest.json`);
      return;
    }

    const existing = this.plugins.get(id);
    const enabledMap = this.getEnabledMap();
    const shouldEnable = this._effectiveEnabled(id, manifest, enabledMap);

    const uiFile = resolvePluginEntry(dir, manifest.ui, 'ui.js');
    const mainFile = resolvePluginEntry(dir, manifest.main, 'main.js');
    if (!uiFile || !mainFile) {
      console.warn(`[PluginHost] ${id}: plugin entry path escapes its folder or is not JavaScript`);
      return;
    }
    const ui = fs.existsSync(uiFile) ? await readFileSafe(uiFile) : '';

    if (existing) {
      existing.manifest = manifest;
      existing.ui = ui;
      existing.uiFile = uiFile;
      existing.mainFile = mainFile;
      if (existing.enabled !== shouldEnable) {
        if (shouldEnable) {
          await this._activate(existing);
        } else {
          await this._deactivate(existing);
        }
      }
      return;
    }

    const record = {
      manifest,
      dir,
      enabled: false,
      ui,
      uiFile,
      mainFile,
      eventListeners: new Map(),
      commands: new Map(),
      disposers: new Set(),
      timers: new Set(),
      lastError: '',
    };
    this.plugins.set(id, record);

    if (shouldEnable) {
      await this._activate(record);
    }
  }

  async _activate(record) {
    if (record.enabled) return;
    const { manifest, mainFile } = record;
    record.lastError = '';
    record.enabled = true;

    if (!fs.existsSync(mainFile)) {
      // UI-only plugin: mark enabled and be done.
      this.setEnabled(manifest.id, true);
      this._emitChange();
      return;
    }

    try {
      const code = await readFileSafe(mainFile);
      const { createRealtimeManager } = await import('../shared/plugin-realtime.mjs');
      const api = this._buildApi(record, { createRealtimeManager });
      record.api = api;
      const sandbox = {
        module: { exports: {} },
        exports: {},
        console: {
          log: (...args) => console.log(`[plugin:${manifest.id}]`, ...args),
          info: (...args) => console.info(`[plugin:${manifest.id}]`, ...args),
          warn: (...args) => console.warn(`[plugin:${manifest.id}]`, ...args),
          error: (...args) => console.error(`[plugin:${manifest.id}]`, ...args),
        },
        setTimeout: (fn, ms, ...args) => {
          const handle = setTimeout(fn, ms, ...args);
          record.timers.add({ kind: 'timeout', handle });
          return handle;
        },
        setInterval: (fn, ms, ...args) => {
          const handle = setInterval(fn, ms, ...args);
          record.timers.add({ kind: 'interval', handle });
          return handle;
        },
        clearTimeout,
        clearInterval,
        Buffer,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        fetch: globalThis.fetch?.bind(globalThis),
        crypto: globalThis.crypto,
        bluetalk: api,
      };
      sandbox.sandbox = sandbox;
      const context = vm.createContext(sandbox);
      record.context = context;
      const script = new vm.Script(code, { filename: `plugin:${manifest.id}/main.js` });
      script.runInContext(context, { timeout: 5000 });

      const mod = sandbox.module.exports || sandbox.exports;
      record.module = mod;
      if (typeof mod === 'function') {
        await mod(api);
      } else if (mod && typeof mod.activate === 'function') {
        await mod.activate(api);
      }
      this.setEnabled(manifest.id, true);
    } catch (e) {
      record.enabled = false;
      record.lastError = e?.message || String(e);
      console.error(`[PluginHost] activate ${manifest.id}:`, e);
    }
    this._emitChange();
  }

  async _deactivate(record) {
    if (!record.enabled) return;
    const { manifest } = record;

    try {
      const mod = record.module;
      if (mod && typeof mod.deactivate === 'function') {
        await mod.deactivate();
      }
    } catch (e) {
      console.error(`[PluginHost] deactivate ${manifest.id}:`, e);
    }

    for (const dispose of record.disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    record.disposers.clear();

    for (const t of record.timers) {
      if (t.kind === 'interval') clearInterval(t.handle);
      else clearTimeout(t.handle);
    }
    record.timers.clear();
    if (record.realtimeManager) {
      try {
        record.realtimeManager.dispose();
      } catch {
        /* ignore */
      }
      record.realtimeManager = null;
    }
    record.eventListeners.clear();
    record.commands.clear();
    record.module = null;
    record.api = null;
    record.context = null;
    record.enabled = false;

    this.setEnabled(manifest.id, false);
    this._emitChange();
  }

  async _unload(id) {
    const record = this.plugins.get(id);
    if (!record) return;
    await this._deactivate(record);
  }

  _buildApi(record, { createRealtimeManager } = {}) {
    const { manifest } = record;
    const pluginStoreKey = (sub) => `plugins.data.${manifest.id}${sub ? `.${sub}` : ''}`;
    const peerServer = this.peerServer;
    const store = this.store;

    const api = {
      manifest: { ...manifest },

      log: {
        info: (...a) => console.log(`[plugin:${manifest.id}]`, ...a),
        warn: (...a) => console.warn(`[plugin:${manifest.id}]`, ...a),
        error: (...a) => console.error(`[plugin:${manifest.id}]`, ...a),
      },

      store: {
        get: (key, defVal) => store.get(pluginStoreKey(key), defVal),
        set: (key, value) => {
          store.set(pluginStoreKey(key), value);
          return true;
        },
        delete: (key) => {
          store.delete(pluginStoreKey(key));
          return true;
        },
      },

      peer: {
        info: () => peerServer.getInfo?.() || null,
        list: () => peerServer.getPeers?.() || [],
        send: (peerId, data) => peerServer.sendTo(peerId, data),
        sendMany: (peerIds, data) => peerServer.sendMany(peerIds, data),
        broadcast: (data) => peerServer.broadcast(data),
        connect: (address) => peerServer.connectTo(address),
        disconnect: (peerId) => peerServer.disconnectPeer(peerId),
        refreshDiscovery: () => peerServer.refreshDiscovery?.(),
      },

      contacts: {
        list: () => store.get('contacts', []) || [],
        update: (patch) => {
          if (!patch?.id) return false;
          const list = store.get('contacts', []) || [];
          const idx = list.findIndex((c) => c?.id === patch.id);
          if (idx >= 0) {
            list[idx] = { ...list[idx], ...patch };
          } else {
            list.push({ addedAt: Date.now(), ...patch });
          }
          store.set('contacts', list);
          this._notifyRendererContacts();
          return true;
        },
        remove: (id) => {
          const list = store.get('contacts', []) || [];
          const next = list.filter((c) => c?.id !== id);
          store.set('contacts', next);
          this._notifyRendererContacts();
          return true;
        },
        block: (id) => api.contacts.update({ id, blocked: true }),
        unblock: (id) => api.contacts.update({ id, blocked: false }),
      },

      messages: {
        list: (peerId) => {
          if (!peerId) return [];
          const all = store.get(`messages.${peerId}`, []);
          return Array.isArray(all) ? all : [];
        },
        append: (peerId, message) => {
          if (!peerId || !message) return false;
          const current = api.messages.list(peerId);
          store.set(`messages.${peerId}`, [...current, message]);
          return true;
        },
        patch: (peerId, messageId, patch) => {
          if (!peerId || !messageId || !patch) return false;
          const current = api.messages.list(peerId);
          const idx = current.findIndex((m) => m && m.messageId === messageId);
          if (idx < 0) return false;
          const next = [...current];
          next[idx] = { ...next[idx], ...patch };
          store.set(`messages.${peerId}`, next);
          return true;
        },
        delete: (peerId, messageId) => {
          if (!peerId || !messageId) return false;
          const current = api.messages.list(peerId);
          const next = current.filter((m) => m?.messageId !== messageId);
          if (next.length === current.length) return false;
          store.set(`messages.${peerId}`, next);
          return true;
        },
      },

      notify: {
        show: (payload = {}) => {
          if (this.store?.get('settings.windowsNotifications', true) === false) {
            return false;
          }
          if (this.store?.get('settings.doNotDisturb', false) === true && payload.allowInForeground !== true) {
            return false;
          }
          if (!payload.allowInForeground && this.isAppInForegroundRef?.()) {
            return false;
          }
          const win = this.mainWindowRef?.();
          try {
            if (process.platform === 'win32' && Notification.isSupported()) {
              const n = new Notification({
                title: payload.title || manifest.name || 'BlueTalk plugin',
                body: payload.body || '',
                silent: Boolean(payload.silent),
              });
              if (win && !win.isDestroyed()) {
                n.on('click', () => win.show());
              }
              n.show();
              return true;
            }
          } catch (e) {
            console.error(`[plugin:${manifest.id}] notify:`, e);
          }
          return false;
        },
      },

      events: {
        on: (name, handler) => {
          if (!ALLOWED_EVENTS.includes(name) || typeof handler !== 'function') {
            return () => undefined;
          }
          let bucket = record.eventListeners.get(name);
          if (!bucket) {
            bucket = new Set();
            record.eventListeners.set(name, bucket);
          }
          bucket.add(handler);
          const off = () => {
            bucket.delete(handler);
          };
          record.disposers.add(off);
          return off;
        },
      },

      timer: {
        setTimeout: (fn, ms, ...args) => {
          const handle = setTimeout(fn, ms, ...args);
          record.timers.add({ kind: 'timeout', handle });
          return handle;
        },
        setInterval: (fn, ms, ...args) => {
          const handle = setInterval(fn, ms, ...args);
          record.timers.add({ kind: 'interval', handle });
          return handle;
        },
        clearTimeout: (h) => clearTimeout(h),
        clearInterval: (h) => clearInterval(h),
      },

      registerCommand: (commandId, handler) => {
        if (typeof commandId !== 'string' || typeof handler !== 'function') return () => undefined;
        record.commands.set(commandId, handler);
        const off = () => record.commands.delete(commandId);
        record.disposers.add(off);
        return off;
      },

      /** Send a message to the UI side of this plugin. Also broadcast to renderer. */
      postToUi: (payload) => {
        const win = this.mainWindowRef?.();
        if (!win || win.isDestroyed()) return false;
        try {
          win.webContents.send('plugins:message', {
            pluginId: manifest.id,
            direction: 'main->ui',
            payload,
          });
          return true;
        } catch {
          return false;
        }
      },
    };

    if (typeof createRealtimeManager === 'function') {
      const realtimeManager = createRealtimeManager({
        pluginId: manifest.id,
        peer: api.peer,
        selfPeerId: () => peerServer.getInfo?.()?.peerId,
        log: api.log,
        onPeerMessage: (handler) => api.events.on('peer:message', handler),
      });
      record.realtimeManager = realtimeManager;
      record.disposers.add(() => realtimeManager.dispose());

      api.realtime = {
        createRoom: (opts) => realtimeManager.createRoom(opts),
        joinRoom: (opts) => realtimeManager.joinRoom(opts),
        listRooms: () => realtimeManager.listRooms(),
        getRoom: (roomId) => realtimeManager.getRoom(roomId),
        on: (event, handler) => realtimeManager.on(event, handler),
      };
    }

    return api;
  }

  _notifyRendererContacts() {
    const win = this.mainWindowRef?.();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('plugins:contacts-updated');
    } catch {
      /* ignore */
    }
  }

  _emitChange() {
    const win = this.mainWindowRef?.();
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('plugins:changed', this.listPlugins());
    } catch {
      /* ignore */
    }
  }

  async syncDebugOnlyPlugins() {
    const enabledMap = this.getEnabledMap();
    for (const record of this.plugins.values()) {
      if (!this._isDebugOnly(record.manifest)) continue;
      const shouldEnable = this._effectiveEnabled(record.manifest.id, record.manifest, enabledMap);
      if (shouldEnable && !record.enabled) {
        await this._activate(record);
      } else if (!shouldEnable && record.enabled) {
        await this._deactivate(record);
      }
    }
    this._emitChange();
  }

  listPlugins() {
    const out = [];
    for (const [id, record] of this.plugins) {
      if (!this._isPluginVisible(record)) continue;
      out.push({
        id,
        manifest: { ...record.manifest },
        enabled: record.enabled,
        hasMain: Boolean(record.mainFile && fs.existsSync(record.mainFile)),
        hasUi: Boolean(record.ui),
        ui: record.ui || '',
        dir: record.dir,
        lastError: record.lastError || '',
      });
    }
    out.sort((a, b) => String(a.manifest.name || a.id).localeCompare(String(b.manifest.name || b.id)));
    return out;
  }

  /** Für Agent-Tools: Plugins inkl. registrierter Command-IDs. */
  listPluginsForAgent() {
    const out = [];
    for (const [id, record] of this.plugins) {
      if (!this._isPluginVisible(record)) continue;
      out.push({
        id,
        name: record.manifest?.name || id,
        description: record.manifest?.description || '',
        enabled: record.enabled,
        hasMain: Boolean(record.mainFile && fs.existsSync(record.mainFile)),
        hasUi: Boolean(record.ui),
        commands: [...record.commands.keys()],
        lastError: record.lastError || '',
      });
    }
    out.sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    return out;
  }

  getPlugin(id) {
    return this.listPlugins().find((p) => p.id === id) || null;
  }

  async setPluginEnabled(id, enabled) {
    const record = this.plugins.get(id);
    if (!record) return false;
    if (enabled && this._isDebugOnly(record.manifest) && !this._isDebugMode()) {
      return false;
    }
    if (Boolean(enabled) === record.enabled) {
      this.setEnabled(id, Boolean(enabled));
      return true;
    }
    if (enabled) await this._activate(record);
    else await this._deactivate(record);
    return true;
  }

  async invokeCommand(id, commandId, args) {
    const record = this.plugins.get(id);
    if (!record || !record.enabled) {
      return { ok: false, error: 'not_enabled' };
    }
    const handler = record.commands.get(commandId);
    if (!handler) return { ok: false, error: 'unknown_command' };
    try {
      const result = await handler(args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** Handle a message from the renderer (UI) side of a plugin to the main side. */
  async onUiMessage(id, payload) {
    const record = this.plugins.get(id);
    if (!record || !record.enabled) return;
    try {
      const mod = record.module;
      if (mod && typeof mod.onUiMessage === 'function') {
        await mod.onUiMessage(payload);
      }
    } catch (e) {
      console.error(`[PluginHost] ${id} onUiMessage:`, e);
    }
  }

  async installFromDirectory(sourceDir, options = {}) {
    const src = path.resolve(sourceDir);
    const manifest = readJsonSafe(path.join(src, 'manifest.json'));
    if (!manifest || !manifest.id) {
      throw new Error('Missing or invalid manifest.json');
    }
    const id = safeId(manifest.id);
    if (!id || id !== String(manifest.id).trim().toLowerCase()) throw new Error('Invalid plugin id');
    if (!resolvePluginEntry(src, manifest.main, 'main.js') || !resolvePluginEntry(src, manifest.ui, 'ui.js')) {
      throw new Error('Plugin entry path must stay inside the plugin folder and point to JavaScript');
    }
    const target = path.join(this.pluginsDir, id);
    if (path.resolve(target) === src) throw new Error('Cannot install a plugin from its destination folder');
    if (typeof options.initialEnabled === 'boolean') {
      this.setEnabled(id, options.initialEnabled);
    }
    await fsp.rm(target, { recursive: true, force: true });
    await copyDir(src, target, { files: 0, bytes: 0 });
    await this._loadOne(id);
    return this.getPlugin(id);
  }

  async installFromPayload({ id, files }, options = {}) {
    const pluginId = safeId(id);
    if (!pluginId) throw new Error('Invalid plugin id');
    if (!files || typeof files !== 'object') throw new Error('No files provided');
    const entries = Object.entries(files);
    if (entries.length > MAX_PLUGIN_FILES) throw new Error('Plugin contains too many files');
    const target = path.join(this.pluginsDir, pluginId);
    if (typeof options.initialEnabled === 'boolean') this.setEnabled(pluginId, options.initialEnabled);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    let totalBytes = 0;
    for (const [relPath, contents] of entries) {
      const dest = resolvePluginPayloadPath(target, relPath);
      if (!dest) throw new Error('Invalid plugin file path');
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      if (typeof contents === 'string') {
        totalBytes += Buffer.byteLength(contents);
        if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds the 25 MB limit');
        await fsp.writeFile(dest, contents, 'utf-8');
      } else if (contents && contents.base64) {
        const data = Buffer.from(contents.base64, 'base64');
        totalBytes += data.length;
        if (totalBytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds the 25 MB limit');
        await fsp.writeFile(dest, data);
      } else {
        throw new Error('Invalid plugin file contents');
      }
    }
    const manifest = readJsonSafe(path.join(target, 'manifest.json'));
    if (!manifest || safeId(manifest.id) !== pluginId) throw new Error('Plugin manifest id does not match');
    await this._loadOne(pluginId);
    return this.getPlugin(pluginId);
  }

  async uninstall(id) {
    const pluginId = safeId(id);
    if (!pluginId) return false;
    await this._unload(pluginId);
    this.plugins.delete(pluginId);
    const target = path.join(this.pluginsDir, pluginId);
    await fsp.rm(target, { recursive: true, force: true });
    const map = this.getEnabledMap();
    if (Object.prototype.hasOwnProperty.call(map, pluginId)) {
      delete map[pluginId];
      this.store.set('plugins.enabled', map);
    }
    this.store.delete(`plugins.data.${pluginId}`);
    this._emitChange();
    return true;
  }

  async stop() {
    for (const record of this.plugins.values()) {
      await this._deactivate(record);
    }
    for (const { event, fn } of this._peerListeners) {
      this.peerServer.off(event, fn);
    }
    this._peerListeners = [];
  }

  getPluginsDir() {
    return this.pluginsDir;
  }
}

async function copyDir(src, dest, state) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, state);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(srcPath);
      state.files += 1;
      state.bytes += stat.size;
      if (state.files > MAX_PLUGIN_FILES) throw new Error('Plugin contains too many files');
      if (state.bytes > MAX_PLUGIN_BYTES) throw new Error('Plugin exceeds the 25 MB limit');
      await fsp.copyFile(srcPath, destPath);
    } else {
      throw new Error('Plugin folders may not contain symbolic links or special files');
    }
  }
}

module.exports = { PluginHost };
