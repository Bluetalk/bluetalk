/**
 * Renderer-side plugin runtime.
 *
 * Responsibilities:
 *   - Keep a live list of installed plugins (from main via `bluetalk.plugins.list()`).
 *   - Execute each enabled plugin's `ui.js` source inside a per-plugin function
 *     closure so plugin globals don't collide.
 *   - Provide the plugin-facing `BlueTalkPlugin` API: events, peer, messages,
 *     (tabs, screens, commands, composer attachments), storage, toast, realtime.
 *   - Maintain registries for custom tabs + screens and notify subscribers
 *     via a tiny pub/sub.
 *
 * Game plugins (manifest.game): no sidebar tab; register launcher commands via
 * api.ui.registerCommand — launcherState, launchNew, launchResume, openWindow.
 *
 * The API is intentionally permissive — all plugins are locally installed by
 * the user. Guard rails are limited to avoiding obvious foot-guns (passing
 * frozen snapshots out, scoping storage per plugin, removing listeners on
 * disable/uninstall).
 */

import { createRealtimeManager } from '../../shared/plugin-realtime.mjs';

const LEGACY_GAME_TAB_IDS = new Set(['uno:game', 'poker:table']);

const EVENTS_FROM_MAIN = [
  'peer:connected',
  'peer:disconnected',
  'peer:message',
  'peer:file-offered',
  'peer:file-received',
  'peer:discovered',
  'peers:list-sync',
  'app:data-cleared',
];

function createEmitter() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (typeof fn !== 'function') return () => undefined;
      let bucket = listeners.get(name);
      if (!bucket) {
        bucket = new Set();
        listeners.set(name, bucket);
      }
      bucket.add(fn);
      return () => bucket.delete(fn);
    },
    emit(name, payload) {
      const bucket = listeners.get(name);
      if (!bucket) return;
      for (const fn of bucket) {
        try {
          fn(payload);
        } catch (e) {
          console.error('[PluginRuntime] listener error:', e);
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

export class PluginRuntime {
  constructor() {
    this.plugins = [];
    this.active = new Map(); // id -> active record
    this.emitter = createEmitter(); // fires 'tabs-changed', 'plugins-changed'
    this._peerUnsubs = [];
    this._host = null;
    this._pluginListChanged = null;
    this._booted = false;
    this._applyingList = false;
    this._pendingPluginList = null;
  }

  setHost(host) {
    this._host = host;
  }

  async boot(host) {
    if (host) this._host = host;
    if (this._booted) return;
    this._booted = true;

    if (!window.bluetalk?.plugins) return;

    const forwardEvent = (name) => (data) => {
      for (const record of this.active.values()) {
        const listeners = record.eventListeners.get(name);
        if (!listeners) continue;
        for (const fn of listeners) {
          try {
            fn(data);
          } catch (e) {
            record.logger.error(`${name} handler:`, e);
          }
        }
      }
    };

    for (const evt of EVENTS_FROM_MAIN) {
      const off = window.bluetalk.on?.(evt, forwardEvent(evt));
      if (off) this._peerUnsubs.push(off);
    }

    // Dispatch plugin-specific events (ones routed through the plugin host)
    const offPluginEvent = window.bluetalk.on?.('plugins:event', ({ name, data }) => {
      forwardEvent(name)(data);
    });
    if (offPluginEvent) this._peerUnsubs.push(offPluginEvent);

    const offPluginMessage = window.bluetalk.on?.('plugins:message', ({ pluginId, payload }) => {
      const record = this.active.get(pluginId);
      if (!record) return;
      const listeners = record.eventListeners.get('plugin:message') || new Set();
      for (const fn of listeners) {
        try {
          fn(payload);
        } catch (e) {
          record.logger.error('plugin:message handler:', e);
        }
      }
    });
    if (offPluginMessage) this._peerUnsubs.push(offPluginMessage);

    const offChanged = window.bluetalk.on?.('plugins:changed', (list) => {
      this._applyList(list);
    });
    if (offChanged) this._peerUnsubs.push(offChanged);

    const initial = await window.bluetalk.plugins.list();
    this._applyList(initial);
  }

  _applyList(list) {
    if (this._applyingList) {
      this._pendingPluginList = list;
      return;
    }
    this._applyingList = true;
    let tabsDirty = false;

    try {
      const prev = new Map(this.plugins.map((p) => [p.id, p]));
      this.plugins = Array.isArray(list) ? list : [];

      const nextIds = new Set(this.plugins.map((p) => p.id));
      for (const id of Array.from(this.active.keys())) {
        if (!nextIds.has(id)) {
          this._deactivate(id, { emit: false });
          tabsDirty = true;
        }
      }

      for (const plugin of this.plugins) {
        const existing = prev.get(plugin.id);
        const activeRec = this.active.get(plugin.id);

        if (activeRec) {
          activeRec.manifest = plugin.manifest || activeRec.manifest;
          if (this._isGamePlugin(plugin) || activeRec.isGameLauncher) {
            activeRec.isGameLauncher = true;
            if (activeRec.tabs.size > 0) {
              activeRec.tabs.clear();
              tabsDirty = true;
            }
          }
        }

        if (plugin.enabled && plugin.hasUi) {
          const isGame = this._isGamePlugin(plugin);
          const uiChanged = Boolean(activeRec) && existing?.ui !== plugin.ui;
          const needsActivation = !activeRec
            || uiChanged
            || (isGame && !activeRec.commands.has('launcherState'));
          if (needsActivation) {
            if (activeRec) {
              this._deactivate(plugin.id, { emit: false });
            }
            this._activate(plugin);
            tabsDirty = true;
          }
        } else if (!plugin.enabled && activeRec) {
          this._deactivate(plugin.id, { emit: false });
          tabsDirty = true;
        }
      }

      this.emitter.emit('plugins-changed', this.plugins);
      if (tabsDirty) {
        this.emitter.emit('tabs-changed', this.listTabs());
        this.emitter.emit('screens-changed', this.listScreens());
        this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
      }
    } finally {
      this._applyingList = false;
      if (this._pendingPluginList) {
        const pending = this._pendingPluginList;
        this._pendingPluginList = null;
        this._applyList(pending);
      }
    }
  }

  _activate(plugin) {
    if (this.active.has(plugin.id)) {
      this._deactivate(plugin.id, { emit: false });
    }
    const logger = {
      info: (...a) => console.log(`[plugin:${plugin.id}]`, ...a),
      warn: (...a) => console.warn(`[plugin:${plugin.id}]`, ...a),
      error: (...a) => console.error(`[plugin:${plugin.id}]`, ...a),
    };

    const record = {
      id: plugin.id,
      manifest: plugin.manifest,
      isGameLauncher: this._isGamePlugin(plugin),
      tabs: new Map(),
      screens: new Map(),
      composerAttachments: new Map(),
      commands: new Map(),
      eventListeners: new Map(),
      disposers: new Set(),
      timers: new Map(),
      logger,
    };
    this.active.set(plugin.id, record);

    let api;
    try {
      api = this._buildPluginApi(record);
    } catch (e) {
      logger.error('API build failed:', e);
      this.active.delete(plugin.id);
      return;
    }
    record.api = api;

    try {
      // Wrap plugin source in a function scope for hygiene.
      // eslint-disable-next-line no-new-func
      const fn = new Function('BlueTalkPlugin', 'plugin', 'window', 'document', plugin.ui || '');
      fn(api, api, window, document);
    } catch (e) {
      logger.error('activation failed:', e);
      this._deactivate(plugin.id, { emit: false });
      return;
    }

    if (record.isGameLauncher && !record.commands.has('launcherState')) {
      logger.error('activation incomplete: missing launcher commands');
      this._deactivate(plugin.id, { emit: false });
    }
  }

  _deactivate(id, options = {}) {
    const { emit = true } = options;
    const record = this.active.get(id);
    if (!record) return;
    try {
      const off = record.api?._onDeactivate;
      if (typeof off === 'function') off();
    } catch (e) {
      record.logger.error('deactivate hook:', e);
    }
    for (const dispose of record.disposers) {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    }
    for (const [handle, kind] of record.timers) {
      if (kind === 'interval') clearInterval(handle);
      else clearTimeout(handle);
    }
    record.disposers.clear();
    record.timers.clear();
    record.tabs.clear();
    record.screens.clear();
    record.composerAttachments.clear();
    record.commands.clear();
    record.realtimeManager = null;
    record.eventListeners.clear();
    this.active.delete(id);
    if (emit) {
      this.emitter.emit('tabs-changed', this.listTabs());
      this.emitter.emit('screens-changed', this.listScreens());
      this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
    }
  }

  _buildPluginApi(record) {
    const { id, manifest, logger } = record;
    const host = () => this._host || {};

    const clearTrackedTimer = (handle, kind) => {
      if (kind === 'interval') clearInterval(handle);
      else clearTimeout(handle);
      record.timers.delete(handle);
    };

    const api = {
      manifest: { ...manifest },
      pluginId: id,

      log: logger,

      // Runtime storage scoped per plugin (localStorage with a prefix)
      storage: {
        get: (key, defVal) => {
          try {
            const raw = localStorage.getItem(`bt.plugin.${id}.${key}`);
            if (raw == null) return defVal;
            return JSON.parse(raw);
          } catch {
            return defVal;
          }
        },
        set: (key, value) => {
          try {
            localStorage.setItem(`bt.plugin.${id}.${key}`, JSON.stringify(value));
            return true;
          } catch {
            return false;
          }
        },
        delete: (key) => {
          try {
            localStorage.removeItem(`bt.plugin.${id}.${key}`);
            return true;
          } catch {
            return false;
          }
        },
      },

      // Event subscription (peer/connection events routed from main)
      on: (eventName, handler) => {
        if (typeof handler !== 'function') return () => undefined;
        let bucket = record.eventListeners.get(eventName);
        if (!bucket) {
          bucket = new Set();
          record.eventListeners.set(eventName, bucket);
        }
        bucket.add(handler);
        const off = () => bucket.delete(handler);
        record.disposers.add(off);
        return off;
      },

      // Snapshot accessors (read the current host state)
      peers: () => {
        const h = host();
        return typeof h.getPeers === 'function' ? h.getPeers() : [];
      },
      contacts: () => {
        const h = host();
        return typeof h.getContacts === 'function' ? h.getContacts() : [];
      },
      messages: (peerId) => {
        const h = host();
        return typeof h.getMessages === 'function' ? h.getMessages(peerId) : [];
      },

      // Peer operations (forwarded through the existing bluetalk bridge)
      peer: {
        info: () => window.bluetalk?.peer?.getInfo?.(),
        list: () => window.bluetalk?.peer?.getPeers?.(),
        send: (peerId, data) => window.bluetalk?.peer?.send?.(peerId, data),
        sendMany: (peerIds, data) => window.bluetalk?.peer?.sendMany?.(peerIds, data),
        broadcast: (data) => window.bluetalk?.peer?.broadcast?.(data),
        connect: (address) => window.bluetalk?.peer?.connect?.(address),
        disconnect: (peerId) => window.bluetalk?.peer?.disconnect?.(peerId),
        refreshDiscovery: () => window.bluetalk?.peer?.refreshDiscovery?.(),
      },

      // High level: send a chat through the app's outgoing pipeline (handles E2EE + self store)
      chat: {
        send: (peerId, payload) => host().sendMessage?.(peerId, payload),
        delete: (peerId, messageId) => host().deleteMessage?.(peerId, messageId),
        deleteChat: (peerId) => host().deleteChat?.(peerId),
      },

      contactsApi: {
        list: () => host().getContacts?.() || [],
        update: (patch) => host().upsertContact?.(patch),
        remove: (contactId) => host().removeContact?.(contactId),
        setBlocked: (contactId, blocked) => host().setContactBlocked?.(contactId, blocked),
        setNickname: (contactId, nickname) => host().setContactNickname?.(contactId, nickname),
        setPinned: (contactId, pinned) => host().setChatPinned?.(contactId, pinned),
      },

      notify: {
        show: (payload) => window.bluetalk?.notify?.show?.(payload),
        toast: (payload) => host().toast?.(payload),
      },

      ui: {
        /**
         * Register a new sidebar tab. The `render(container, ctx)` callback
         * is invoked whenever the route mounts; return an optional cleanup fn.
         * Tab id is auto-prefixed with the plugin id to avoid collisions.
         */
        registerTab: (tab) => {
          if (!tab || typeof tab.render !== 'function') return () => undefined;
          const pluginEntry = this.plugins.find((p) => p.id === id);
          if (
            record.isGameLauncher
            || this._isGamePlugin(pluginEntry)
            || this._isGamePlugin({ manifest: record.manifest })
          ) {
            logger.warn('registerTab ignored — game plugins belong in the built-in Spiele tab');
            return () => undefined;
          }
          const tabId = `${id}:${tab.id || tab.label || Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            tabId,
            pluginId: id,
            label: tab.label || manifest.name || id,
            icon: tab.icon || 'Plug',
            tag: tab.tag || manifest.tag || null,
            path: `/plugin/${encodeURIComponent(tabId)}`,
            render: tab.render,
            order: typeof tab.order === 'number' ? tab.order : 100,
          };
          record.tabs.set(tabId, entry);
          this.emitter.emit('tabs-changed', this.listTabs());
          const off = () => {
            record.tabs.delete(tabId);
            this.emitter.emit('tabs-changed', this.listTabs());
          };
          record.disposers.add(off);
          return off;
        },

        /**
         * Register a modal/screen that can be opened imperatively via
         * `BlueTalkPlugin.ui.openScreen(screenId)`.
         */
        registerScreen: (screen) => {
          if (!screen || typeof screen.render !== 'function') return () => undefined;
          const screenId = `${id}:${screen.id || Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            screenId,
            pluginId: id,
            title: screen.title || manifest.name,
            render: screen.render,
          };
          record.screens.set(screenId, entry);
          this.emitter.emit('screens-changed', this.listScreens());
          const off = () => {
            record.screens.delete(screenId);
            this.emitter.emit('screens-changed', this.listScreens());
          };
          record.disposers.add(off);
          return off;
        },

        openScreen: (screenId, ctx) => {
          const allScreens = this.listScreens();
          const key = screenId.includes(':') ? screenId : `${id}:${screenId}`;
          const found = allScreens.find((s) => s.screenId === key);
          if (!found) {
            logger.warn('openScreen: unknown screen', screenId);
            return null;
          }
          this.emitter.emit('screen-open', { screen: found, ctx });
          return found;
        },

        closeScreen: () => {
          this.emitter.emit('screen-close');
        },

        registerCommand: (commandId, handler) => {
          if (typeof commandId !== 'string' || typeof handler !== 'function') {
            return () => undefined;
          }
          record.commands.set(commandId, handler);
          if (commandId === 'launcherState') {
            record.isGameLauncher = true;
            if (record.tabs.size > 0) {
              record.tabs.clear();
            }
          }
          const off = () => record.commands.delete(commandId);
          record.disposers.add(off);
          return off;
        },

        /**
         * Register an extra option in the chat composer “+” attach menu.
         * `onSelect(ctx)` receives `{ peerId, closeMenu, sendMessage, toast, settings, contacts, peers }`.
         */
        registerComposerAttachment: (item) => {
          if (!item || typeof item.onSelect !== 'function') return () => undefined;
          const attachmentId = `${id}:${item.id || item.label || Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            attachmentId,
            pluginId: id,
            label: item.label || manifest.name || id,
            icon: item.icon || 'Plug',
            order: typeof item.order === 'number' ? item.order : 200,
            onSelect: item.onSelect,
          };
          record.composerAttachments.set(attachmentId, entry);
          this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
          const off = () => {
            record.composerAttachments.delete(attachmentId);
            this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
          };
          record.disposers.add(off);
          return off;
        },

        invokeCommand: async (commandId, args) => {
          const handler = record.commands.get(commandId);
          if (handler) return handler(args);
          return null;
        },
      },

      // Call into the plugin's main-process side (if any)
      sendToMain: (payload) => window.bluetalk?.plugins?.sendToMain?.(id, payload),
      invokeMainCommand: (commandId, args) =>
        window.bluetalk?.plugins?.invokeCommand?.(id, commandId, args),

      timer: {
        setTimeout: (fn, ms, ...args) => {
          let handle;
          handle = setTimeout((...callbackArgs) => {
            record.timers.delete(handle);
            fn(...callbackArgs);
          }, ms, ...args);
          record.timers.set(handle, 'timeout');
          return handle;
        },
        setInterval: (fn, ms, ...args) => {
          const handle = setInterval(fn, ms, ...args);
          record.timers.set(handle, 'interval');
          return handle;
        },
        clearTimeout: (handle) => clearTrackedTimer(handle, 'timeout'),
        clearInterval: (handle) => clearTrackedTimer(handle, 'interval'),
      },

      onDeactivate: (fn) => {
        if (typeof fn === 'function') {
          record._onDeactivate = fn;
          api._onDeactivate = fn;
        }
      },

      invokePluginCommand: (pluginId, commandId, args) =>
        this.invokePluginCommand(pluginId, commandId, args),

      // React helpers (available for plugins that want JSX at runtime).
      // Injected via injectReact() — App calls it before boot(), so the stashed
      // values are already set here; injectReact also patches active records.
      React: this._React,
      ReactDOM: this._ReactDOM,
    };

    const realtimeManager = createRealtimeManager({
      pluginId: id,
      peer: api.peer,
      selfPeerId: () => host().getOwnPeerId?.() || '',
      log: logger,
      onPeerMessage: (handler) => api.on('peer:message', handler),
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

    return api;
  }

  injectReact(React, ReactDOM) {
    for (const record of this.active.values()) {
      if (record.api) {
        record.api.React = React;
        record.api.ReactDOM = ReactDOM;
      }
    }
    this._React = React;
    this._ReactDOM = ReactDOM;
  }

  _isGamePlugin(plugin) {
    if (!plugin) return false;
    if (plugin.id === 'poker' || plugin.id === 'uno' || plugin.id === 'connect-four' || plugin.id === 'chess') return true;
    const game = plugin?.manifest?.game;
    return game === true || (typeof game === 'object' && game !== null);
  }

  listGames() {
    return this.plugins
      .filter((plugin) => this._isGamePlugin(plugin))
      .map((plugin) => this._mapGameEntry(plugin))
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  }

  _mapGameEntry(plugin) {
    const gameMeta = typeof plugin.manifest?.game === 'object' && plugin.manifest.game !== null
      ? plugin.manifest.game
      : {};
    return {
      id: plugin.id,
      enabled: Boolean(plugin.enabled),
      name: gameMeta.title || plugin.manifest?.name || plugin.id,
      description: gameMeta.description || plugin.manifest?.description || '',
      tag: plugin.manifest?.tag || gameMeta.tag || null,
      mark: gameMeta.mark || plugin.manifest?.gameMark || '🎮',
      alphaNotice: gameMeta.alphaNotice || null,
      labels: gameMeta.labels || null,
    };
  }

  listTabs() {
    const out = [];
    for (const record of this.active.values()) {
      const plugin = this.plugins.find((p) => p.id === record.id);
      if (
        record.isGameLauncher
        || this._isGamePlugin(plugin)
        || this._isGamePlugin({ manifest: record.manifest })
      ) {
        continue;
      }
      for (const tab of record.tabs.values()) {
        if (LEGACY_GAME_TAB_IDS.has(tab.tabId)) continue;
        out.push(tab);
      }
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  listScreens() {
    const out = [];
    for (const record of this.active.values()) {
      for (const screen of record.screens.values()) {
        out.push(screen);
      }
    }
    return out;
  }

  listComposerAttachments() {
    const out = [];
    for (const record of this.active.values()) {
      for (const item of record.composerAttachments.values()) {
        out.push(item);
      }
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  getTab(tabId) {
    return this.listTabs().find((t) => t.tabId === tabId) || null;
  }

  async invokePluginCommand(pluginId, commandId, args) {
    let record = this.active.get(pluginId);
    let handler = record?.commands.get(commandId);
    if (!record || !handler) {
      await this.refresh();
      const plugin = this.plugins.find((item) => item.id === pluginId);
      if (plugin?.enabled && plugin.hasUi) {
        if (this.active.has(pluginId)) {
          this._deactivate(pluginId, { emit: false });
        }
        this._activate(plugin);
      }
      record = this.active.get(pluginId);
      handler = record?.commands.get(commandId);
    }

    if (!record) return { ok: false, error: 'not_active' };
    if (!handler) return { ok: false, error: 'unknown_command' };
    try {
      const result = await handler(args);
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  onTabsChanged(fn) {
    return this.emitter.on('tabs-changed', fn);
  }

  onScreensChanged(fn) {
    return this.emitter.on('screens-changed', fn);
  }

  onComposerAttachmentsChanged(fn) {
    return this.emitter.on('composer-attachments-changed', fn);
  }

  onPluginsChanged(fn) {
    return this.emitter.on('plugins-changed', fn);
  }

  onScreenOpen(fn) {
    return this.emitter.on('screen-open', fn);
  }

  onScreenClose(fn) {
    return this.emitter.on('screen-close', fn);
  }

  getPlugins() {
    return this.plugins;
  }

  async refresh() {
    if (!window.bluetalk?.plugins) return;
    const list = await window.bluetalk.plugins.list();
    this._applyList(list);
  }
}

export const pluginRuntime = new PluginRuntime();
