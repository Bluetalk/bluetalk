const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bluetalk', {
  // Window controls
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    getMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (callback) => {
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('window:maximized', listener);
      return () => ipcRenderer.removeListener('window:maximized', listener);
    },
  },

  // Store
  store: {
    get: (key, defaultVal) => ipcRenderer.invoke('store:get', key, defaultVal),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    delete: (key) => ipcRenderer.invoke('store:delete', key),
  },

  messages: {
    getMeta: () => ipcRenderer.invoke('messages:getMeta'),
    getBatch: (peerId, options) => ipcRenderer.invoke('messages:getBatch', peerId, options),
    append: (peerId, message) => ipcRenderer.invoke('messages:append', peerId, message),
    patch: (peerId, messageId, patch) => ipcRenderer.invoke('messages:patch', peerId, messageId, patch),
    deleteMessage: (peerId, messageId) => ipcRenderer.invoke('messages:deleteMessage', peerId, messageId),
    deleteChat: (peerId) => ipcRenderer.invoke('messages:deleteChat', peerId),
  },

  // Peer networking
  peer: {
    getInfo: () => ipcRenderer.invoke('peer:getInfo'),
    connect: (address) => ipcRenderer.invoke('peer:connect', address),
    normalizeAddress: (raw) => ipcRenderer.invoke('peer:normalizeAddress', raw),
    reconnectContacts: () => ipcRenderer.invoke('peer:reconnectContacts'),
    resetAllConnections: () => ipcRenderer.invoke('peer:resetAllConnections'),
    disconnect: (peerId) => ipcRenderer.invoke('peer:disconnect', peerId),
    send: (peerId, data) => ipcRenderer.invoke('peer:send', peerId, data),
    broadcast: (data) => ipcRenderer.invoke('peer:broadcast', data),
    getPeers: () => ipcRenderer.invoke('peer:getPeers'),
    refreshDiscovery: () => ipcRenderer.invoke('peer:refreshDiscovery'),
  },

  // File operations
  file: {
    host: (fileMeta) => ipcRenderer.invoke('file:host', fileMeta),
    getHosted: () => ipcRenderer.invoke('file:getHosted'),
    request: (peerId, fileId) => ipcRenderer.invoke('file:request', peerId, fileId),
    saveAs: (payload) => ipcRenderer.invoke('file:saveAs', payload),
  },

  library: {
    listMedia: () => ipcRenderer.invoke('library:listMedia'),
    getMediaData: (peerId, messageId) => ipcRenderer.invoke('library:getMediaData', peerId, messageId),
  },

  // Native notifications
  notify: {
    show: (payload) => ipcRenderer.invoke('notify:show', payload),
  },

  // Network diagnostics
  network: {
    testPorts: () => ipcRenderer.invoke('network:testPorts'),
    doctor: () => ipcRenderer.invoke('network:doctor'),
    getApiAccess: () => ipcRenderer.invoke('network:getApiAccess'),
  },

  // Auto updater
  updater: {
    getState: () => ipcRenderer.invoke('updater:getState'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    install: () => ipcRenderer.invoke('updater:install'),
  },

  /** Poker-Spiel-Fenster: Zustand vom Hauptfenster, Aktionen zurück zum Plugin */
  poker: {
    openGameWindow: () => ipcRenderer.invoke('poker:openGameWindow'),
    closeGameWindow: () => ipcRenderer.invoke('poker:closeGameWindow'),
    minimizeWindow: () => ipcRenderer.invoke('poker:minimizeWindow'),
    maximizeWindow: () => ipcRenderer.invoke('poker:maximizeWindow'),
    isWindowMaximized: () => ipcRenderer.invoke('poker:isWindowMaximized'),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('poker:windowMaximized', listener);
      return () => ipcRenderer.removeListener('poker:windowMaximized', listener);
    },
    pushState: (payload) => ipcRenderer.send('poker:pumpState', payload),
    sendAction: (payload) => ipcRenderer.send('poker:fromChild', payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('poker:state', listener);
      return () => ipcRenderer.removeListener('poker:state', listener);
    },
    onFromChild: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('poker:fromChild', listener);
      return () => ipcRenderer.removeListener('poker:fromChild', listener);
    },
  },

  /** UNO-Spiel-Fenster: Zustand vom Hauptfenster, Aktionen zurück zum Plugin */
  uno: {
    openGameWindow: () => ipcRenderer.invoke('uno:openGameWindow'),
    closeGameWindow: () => ipcRenderer.invoke('uno:closeGameWindow'),
    minimizeWindow: () => ipcRenderer.invoke('uno:minimizeWindow'),
    maximizeWindow: () => ipcRenderer.invoke('uno:maximizeWindow'),
    isWindowMaximized: () => ipcRenderer.invoke('uno:isWindowMaximized'),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('uno:windowMaximized', listener);
      return () => ipcRenderer.removeListener('uno:windowMaximized', listener);
    },
    pushState: (payload) => ipcRenderer.send('uno:pumpState', payload),
    sendAction: (payload) => ipcRenderer.send('uno:fromChild', payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('uno:state', listener);
      return () => ipcRenderer.removeListener('uno:state', listener);
    },
    onFromChild: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('uno:fromChild', listener);
      return () => ipcRenderer.removeListener('uno:fromChild', listener);
    },
  },

  app: {
    clearCache: () => ipcRenderer.invoke('app:clearCache'),
    clearMessages: () => ipcRenderer.invoke('app:clearMessages'),
    wipeAllData: () => ipcRenderer.invoke('app:wipeAllData'),
    getConfigLogPath: () => ipcRenderer.invoke('app:getConfigLogPath'),
    readConfigTail: (maxBytes) => ipcRenderer.invoke('app:readConfigTail', maxBytes),
  },

  plugins: {
    list: () => ipcRenderer.invoke('plugins:list'),
    rescan: () => ipcRenderer.invoke('plugins:rescan'),
    reseedBundled: () => ipcRenderer.invoke('plugins:reseedBundled'),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins:setEnabled', id, enabled),
    openDir: () => ipcRenderer.invoke('plugins:openDir'),
    installFromDialog: () => ipcRenderer.invoke('plugins:installFromDialog'),
    install: (payload) => ipcRenderer.invoke('plugins:install', payload),
    uninstall: (id) => ipcRenderer.invoke('plugins:uninstall', id),
    invokeCommand: (id, commandId, args) =>
      ipcRenderer.invoke('plugins:invokeCommand', id, commandId, args),
    sendToMain: (id, payload) => ipcRenderer.invoke('plugins:sendToMain', id, payload),
  },

  // Events from main process
  on: (channel, callback) => {
    const validChannels = [
      'peer:connected',
      'peer:disconnected',
      'peer:message',
      'peer:file-offered',
      'peer:file-received',
      'peer:discovered',
      'peers:list-sync',
      'updater:state',
      'app:data-cleared',
      'plugins:event',
      'plugins:changed',
      'plugins:message',
      'plugins:contacts-updated',
    ];
    if (validChannels.includes(channel)) {
      const listener = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
});
