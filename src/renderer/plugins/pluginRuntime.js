/**
 * Renderer-side plugin runtime.
 *
 * Responsibilities:
 *   - Keep a live list of installed plugins (from main via `bluetalk.plugins.list()`).
 *   - Execute each enabled plugin's `ui.js` source inside a per-plugin function
 *     closure so plugin globals don't collide.
 *   - Provide the plugin-facing `BlueTalkPlugin` API: events, peer, messages,
 *     (tabs, screens, commands, composer attachments), storage, toast.
 *   - Maintain registries for custom tabs + screens and notify subscribers
 *     via a tiny pub/sub.
 *
 * The API is intentionally permissive — all plugins are locally installed by
 * the user. Guard rails are limited to avoiding obvious foot-guns (passing
 * frozen snapshots out, scoping storage per plugin, removing listeners on
 * disable/uninstall).
 */

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

class PluginRuntime {
  constructor() {
    this.plugins = [];
    this.active = new Map(); // id -> active record
    this.emitter = createEmitter(); // fires 'tabs-changed', 'plugins-changed'
    this._peerUnsubs = [];
    this._host = null;
    this._pluginListChanged = null;
    this._booted = false;
  }

  setHost(host) {
    this._host = host;
  }

  async boot(host) {
    if (this._booted) return;
    this._booted = true;
    this._host = host;

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
    const prev = new Map(this.plugins.map((p) => [p.id, p]));
    this.plugins = Array.isArray(list) ? list : [];

    const nextIds = new Set(this.plugins.map((p) => p.id));
    for (const id of Array.from(this.active.keys())) {
      if (!nextIds.has(id)) {
        this._deactivate(id);
      }
    }

    for (const plugin of this.plugins) {
      const existing = prev.get(plugin.id);
      const activeRec = this.active.get(plugin.id);
      if (plugin.enabled && plugin.hasUi && !activeRec) {
        this._activate(plugin);
      } else if (!plugin.enabled && activeRec) {
        this._deactivate(plugin.id);
      } else if (plugin.enabled && plugin.hasUi && activeRec && existing?.ui !== plugin.ui) {
        // Plugin UI source changed — re-activate
        this._deactivate(plugin.id);
        this._activate(plugin);
      }
    }

    this.emitter.emit('plugins-changed', this.plugins);
    this.emitter.emit('tabs-changed', this.listTabs());
    this.emitter.emit('screens-changed', this.listScreens());
    this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
  }

  _activate(plugin) {
    if (this.active.has(plugin.id)) return;
    const logger = {
      info: (...a) => console.log(`[plugin:${plugin.id}]`, ...a),
      warn: (...a) => console.warn(`[plugin:${plugin.id}]`, ...a),
      error: (...a) => console.error(`[plugin:${plugin.id}]`, ...a),
    };

    const record = {
      id: plugin.id,
      manifest: plugin.manifest,
      tabs: new Map(),
      screens: new Map(),
      composerAttachments: new Map(),
      commands: new Map(),
      eventListeners: new Map(),
      disposers: new Set(),
      timers: new Set(),
      logger,
    };
    this.active.set(plugin.id, record);

    const api = this._buildPluginApi(record);
    record.api = api;

    try {
      // Wrap plugin source in a function scope for hygiene.
      // eslint-disable-next-line no-new-func
      const fn = new Function('BlueTalkPlugin', 'plugin', 'window', 'document', plugin.ui || '');
      fn(api, api, window, document);
    } catch (e) {
      record.logger.error('activation failed:', e);
    }
  }

  _deactivate(id) {
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
    for (const t of record.timers) {
      if (t.kind === 'interval') clearInterval(t.handle);
      else clearTimeout(t.handle);
    }
    record.disposers.clear();
    record.timers.clear();
    record.tabs.clear();
    record.screens.clear();
    record.composerAttachments.clear();
    record.commands.clear();
    record.eventListeners.clear();
    this.active.delete(id);
    this.emitter.emit('tabs-changed', this.listTabs());
    this.emitter.emit('screens-changed', this.listScreens());
    this.emitter.emit('composer-attachments-changed', this.listComposerAttachments());
  }

  _buildPluginApi(record) {
    const { id, manifest, logger } = record;
    const host = () => this._host || {};

    const trackTimer = (kind, handle) => {
      record.timers.add({ kind, handle });
      return handle;
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
          const tabId = `${id}:${tab.id || tab.label || Math.random().toString(36).slice(2, 8)}`;
          const entry = {
            tabId,
            pluginId: id,
            label: tab.label || manifest.name || id,
            icon: tab.icon || 'Plug',
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
        setTimeout: (fn, ms, ...args) => trackTimer('timeout', setTimeout(fn, ms, ...args)),
        setInterval: (fn, ms, ...args) => trackTimer('interval', setInterval(fn, ms, ...args)),
        clearTimeout: (h) => clearTimeout(h),
        clearInterval: (h) => clearInterval(h),
      },

      onDeactivate: (fn) => {
        if (typeof fn === 'function') {
          record._onDeactivate = fn;
          api._onDeactivate = fn;
        }
      },

      // React helpers (available for plugins that want JSX at runtime)
      React: undefined,
      ReactDOM: undefined,
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

  listTabs() {
    const out = [];
    for (const record of this.active.values()) {
      for (const tab of record.tabs.values()) {
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
