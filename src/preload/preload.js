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
    connect: async (address) => {
      const result = await ipcRenderer.invoke('peer:connect', address);
      if (result?.ok === false) {
        throw new Error(result.error || 'Connection failed');
      }
      if (result?.ok === true) {
        return result.peer;
      }
      return result;
    },
    normalizeAddress: (raw) => ipcRenderer.invoke('peer:normalizeAddress', raw),
    reconnectContacts: () => ipcRenderer.invoke('peer:reconnectContacts'),
    resetAllConnections: () => ipcRenderer.invoke('peer:resetAllConnections'),
    disconnect: (peerId) => ipcRenderer.invoke('peer:disconnect', peerId),
    send: (peerId, data) => ipcRenderer.invoke('peer:send', peerId, data),
    sendMany: (peerIds, data) => ipcRenderer.invoke('peer:sendMany', peerIds, data),
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

  /** Lokaler KI-Chat über Ollama (Runtime + Modell-Downloads) */
  ollama: {
    getState: () => ipcRenderer.invoke('ollama:getState'),
    getModelCatalog: () => ipcRenderer.invoke('ollama:getModelCatalog'),
    downloadRuntime: () => ipcRenderer.invoke('ollama:downloadRuntime'),
    selectRuntimeMode: (mode) => ipcRenderer.invoke('ollama:selectRuntimeMode', mode),
    selectModelTier: (tierId) => ipcRenderer.invoke('ollama:selectModelTier', tierId),
    selectCloudModel: (cloudModelId) => ipcRenderer.invoke('ollama:selectCloudModel', cloudModelId),
    downloadModel: (tierId) => ipcRenderer.invoke('ollama:downloadModel', tierId),
    deleteModel: (tierId) => ipcRenderer.invoke('ollama:deleteModel', tierId),
    openModelsDir: () => ipcRenderer.invoke('ollama:openModelsDir'),
    getStoragePaths: () => ipcRenderer.invoke('ollama:getStoragePaths'),
    chat: (payload = {}, onProgress) => {
      const requestId = payload.requestId || (typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const listener = (_, data) => {
        if (data?.requestId !== requestId) return;
        onProgress?.(data);
      };
      if (typeof onProgress === 'function') {
        ipcRenderer.on('ollama:chat-progress', listener);
      }
      return ipcRenderer
        .invoke('ollama:chat', { ...payload, requestId })
        .finally(() => {
          if (typeof onProgress === 'function') {
            ipcRenderer.removeListener('ollama:chat-progress', listener);
          }
        });
    },
    abortChat: (requestId) => ipcRenderer.invoke('ollama:abortChat', requestId),
    clearAgentContext: (peerId) => ipcRenderer.invoke('ollama:clearAgentContext', peerId),
    onAskUser: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('ollama:ask-user', listener);
      return () => ipcRenderer.removeListener('ollama:ask-user', listener);
    },
    replyAskUser: (requestId, answer) =>
      ipcRenderer.send(`ollama:ask-user-reply:${requestId}`, { requestId, answer }),
    startCloudSignIn: () => ipcRenderer.invoke('ollama:startCloudSignIn'),
    confirmCloudAuth: () => ipcRenderer.invoke('ollama:confirmCloudAuth'),
    resetAndDelete: () => ipcRenderer.invoke('ollama:resetAndDelete'),
  },

  /** Agent-Modus: Ordnerauswahl für das Arbeitsverzeichnis eines KI-Agenten. */
  agent: {
    pickFolder: async () => {
      const result = await ipcRenderer.invoke('agent:pickFolder');
      if (result?.ok) return result.path;
      return null;
    },
    sendMessageReply: ({ requestId, result }) => {
      if (!requestId) return;
      ipcRenderer.send(`agent:send-message-reply:${requestId}`, { requestId, result });
    },
    connectPeerReply: ({ requestId, result }) => {
      if (!requestId) return;
      ipcRenderer.send(`agent:connect-peer-reply:${requestId}`, { requestId, result });
    },
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

  /** Vier-gewinnt-Spiel-Fenster: Zustand vom Hauptfenster, Aktionen zurück zum Plugin */
  connectFour: {
    openGameWindow: () => ipcRenderer.invoke('connect-four:openGameWindow'),
    closeGameWindow: () => ipcRenderer.invoke('connect-four:closeGameWindow'),
    minimizeWindow: () => ipcRenderer.invoke('connect-four:minimizeWindow'),
    maximizeWindow: () => ipcRenderer.invoke('connect-four:maximizeWindow'),
    isWindowMaximized: () => ipcRenderer.invoke('connect-four:isWindowMaximized'),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('connect-four:windowMaximized', listener);
      return () => ipcRenderer.removeListener('connect-four:windowMaximized', listener);
    },
    pushState: (payload) => ipcRenderer.send('connect-four:pumpState', payload),
    sendAction: (payload) => ipcRenderer.send('connect-four:fromChild', payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('connect-four:state', listener);
      return () => ipcRenderer.removeListener('connect-four:state', listener);
    },
    onFromChild: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('connect-four:fromChild', listener);
      return () => ipcRenderer.removeListener('connect-four:fromChild', listener);
    },
  },

  /** Schach-Spiel-Fenster: Zustand vom Hauptfenster, Aktionen zurück zum Plugin */
  chess: {
    openGameWindow: () => ipcRenderer.invoke('chess:openGameWindow'),
    closeGameWindow: () => ipcRenderer.invoke('chess:closeGameWindow'),
    minimizeWindow: () => ipcRenderer.invoke('chess:minimizeWindow'),
    maximizeWindow: () => ipcRenderer.invoke('chess:maximizeWindow'),
    isWindowMaximized: () => ipcRenderer.invoke('chess:isWindowMaximized'),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('chess:windowMaximized', listener);
      return () => ipcRenderer.removeListener('chess:windowMaximized', listener);
    },
    pushState: (payload) => ipcRenderer.send('chess:pumpState', payload),
    sendAction: (payload) => ipcRenderer.send('chess:fromChild', payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('chess:state', listener);
      return () => ipcRenderer.removeListener('chess:state', listener);
    },
    onFromChild: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('chess:fromChild', listener);
      return () => ipcRenderer.removeListener('chess:fromChild', listener);
    },
  },

  /** Tic-Tac-Toe-Spiel-Fenster: Zustand vom Hauptfenster, Aktionen zurück zum Plugin */
  ticTacToe: {
    openGameWindow: () => ipcRenderer.invoke('ticTacToe:openGameWindow'),
    closeGameWindow: () => ipcRenderer.invoke('ticTacToe:closeGameWindow'),
    minimizeWindow: () => ipcRenderer.invoke('ticTacToe:minimizeWindow'),
    maximizeWindow: () => ipcRenderer.invoke('ticTacToe:maximizeWindow'),
    isWindowMaximized: () => ipcRenderer.invoke('ticTacToe:isWindowMaximized'),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on('ticTacToe:windowMaximized', listener);
      return () => ipcRenderer.removeListener('ticTacToe:windowMaximized', listener);
    },
    pushState: (payload) => ipcRenderer.send('ticTacToe:pumpState', payload),
    sendAction: (payload) => ipcRenderer.send('ticTacToe:fromChild', payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('ticTacToe:state', listener);
      return () => ipcRenderer.removeListener('ticTacToe:state', listener);
    },
    onFromChild: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on('ticTacToe:fromChild', listener);
      return () => ipcRenderer.removeListener('ticTacToe:fromChild', listener);
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
      'ollama:state',
      'app:data-cleared',
      'plugins:event',
      'plugins:changed',
      'plugins:message',
      'plugins:contacts-updated',
      'agent:send-message',
      'agent:connect-peer',
    ];
    if (validChannels.includes(channel)) {
      const listener = (_, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
});
