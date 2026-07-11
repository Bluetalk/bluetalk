import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const ALLOWED_EVENTS = new Set([
  'peer:connected',
  'peer:disconnected',
  'peer:message',
  'peer:file-offered',
  'peer:file-received',
  'peer:discovered',
  'peers:list-sync',
  'updater:state',
  'ollama:state',
  'ollama:ask-user',
  'ollama:chat-progress',
  'app:data-cleared',
  'plugins:event',
  'plugins:changed',
  'plugins:message',
  'plugins:contacts-updated',
  'agent:send-message',
  'agent:connect-peer',
  'window:maximized',
  'poker:windowMaximized',
  'poker:state',
  'poker:fromChild',
  'uno:windowMaximized',
  'uno:state',
  'uno:fromChild',
  'connect-four:windowMaximized',
  'connect-four:state',
  'connect-four:fromChild',
  'chess:windowMaximized',
  'chess:state',
  'chess:fromChild',
  'ticTacToe:windowMaximized',
  'ticTacToe:state',
  'ticTacToe:fromChild',
  'docs:windowMaximized',
  'docs:state',
  'docs:fromChild',
  'docs:presence',
]);

function subscribe(channel, callback) {
  if (!ALLOWED_EVENTS.has(channel) || typeof callback !== 'function') {
    return () => undefined;
  }

  let disposed = false;
  let removeListener = null;
  void listen(channel, (event) => callback(event.payload)).then((unlisten) => {
    if (disposed) unlisten();
    else removeListener = unlisten;
  }).catch((error) => {
    console.error(`[BlueTalk bridge] Could not subscribe to ${channel}:`, error);
  });

  return () => {
    disposed = true;
    removeListener?.();
    removeListener = null;
  };
}

async function call(command, args = {}) {
  try {
    return await invoke(command, args);
  } catch (error) {
    if (error instanceof Error) throw error;
    if (typeof error === 'string') throw new Error(error);
    throw new Error(error?.message || `Command ${command} failed`);
  }
}

function gameBridge(game, route) {
  const eventPrefix = game;
  return {
    openGameWindow: () => call('game_window_open', { game, route }),
    closeGameWindow: () => call('game_window_close', { game }),
    minimizeWindow: () => call('game_window_minimize', { game }),
    maximizeWindow: () => call('game_window_maximize', { game }),
    isWindowMaximized: () => call('game_window_is_maximized', { game }),
    onWindowMaximizedChange: (callback) => subscribe(`${eventPrefix}:windowMaximized`, callback),
    pushState: (payload) => call('game_window_push_state', { game, payload }),
    sendAction: (payload) => call('game_window_send_action', { game, payload }),
    onState: (callback) => subscribe(`${eventPrefix}:state`, callback),
    onFromChild: (callback) => subscribe(`${eventPrefix}:fromChild`, callback),
  };
}

const docsBridge = {
  ...gameBridge('docs', '/docs-editor'),
  pushPresence: (payload) => call('game_window_push_presence', { game: 'docs', payload }),
  // The docs editor window exports documents through the native save dialog.
  saveAs: (payload) => call('file_save_as', { payload }),
  onPeerPresence: (callback) => subscribe('docs:presence', callback),
};

const api = Object.freeze({
  window: Object.freeze({
    minimize: () => call('window_minimize'),
    maximize: () => call('window_toggle_maximize'),
    close: () => call('window_close'),
    getMaximized: () => call('window_is_maximized'),
    onMaximizedChange: (callback) => subscribe('window:maximized', callback),
  }),

  store: Object.freeze({
    get: (key, defaultValue) => call('store_get', { key, defaultValue }),
    set: (key, value) => call('store_set', { key, value }),
    delete: (key) => call('store_delete', { key }),
  }),

  messages: Object.freeze({
    getMeta: () => call('messages_get_meta'),
    getBatch: (peerId, options = {}) => call('messages_get_batch', { peerId, options }),
    append: (peerId, message) => call('messages_append', { peerId, message }),
    patch: (peerId, messageId, patch) => call('messages_patch', { peerId, messageId, patch }),
    deleteMessage: (peerId, messageId) => call('messages_delete_message', { peerId, messageId }),
    deleteChat: (peerId) => call('messages_delete_chat', { peerId }),
  }),

  peer: Object.freeze({
    getInfo: () => call('peer_get_info'),
    connect: async (address) => {
      const result = await call('peer_connect', { address });
      if (result?.ok === false) throw new Error(result.error || 'Connection failed');
      return result?.ok === true ? result.peer : result;
    },
    normalizeAddress: (raw) => call('peer_normalize_address', { raw }),
    reconnectContacts: () => call('peer_reconnect_contacts'),
    resetAllConnections: () => call('peer_reset_all_connections'),
    disconnect: (peerId) => call('peer_disconnect', { peerId }),
    send: (peerId, data) => call('peer_send', { peerId, data }),
    sendMany: (peerIds, data) => call('peer_send_many', { peerIds, data }),
    broadcast: (data) => call('peer_broadcast', { data }),
    getPeers: () => call('peer_get_peers'),
    refreshDiscovery: () => call('peer_refresh_discovery'),
  }),

  file: Object.freeze({
    host: (fileMeta) => call('file_host', { fileMeta }),
    getHosted: () => call('file_get_hosted'),
    request: (peerId, fileId) => call('file_request', { peerId, fileId }),
    saveAs: (payload) => call('file_save_as', { payload }),
  }),

  library: Object.freeze({
    listMedia: () => call('library_list_media'),
    getMediaData: (peerId, messageId) => call('library_get_media_data', { peerId, messageId }),
  }),

  notify: Object.freeze({
    show: (payload) => call('notify_show', { payload }),
  }),

  network: Object.freeze({
    testPorts: () => call('network_test_ports'),
    doctor: () => call('network_doctor'),
    getApiAccess: () => call('network_get_api_access'),
  }),

  updater: Object.freeze({
    getState: () => call('updater_get_state'),
    check: () => call('updater_check'),
    download: () => call('updater_download'),
    install: () => call('updater_install'),
  }),

  ollama: Object.freeze({
    getState: () => call('ollama_get_state'),
    getModelCatalog: () => call('ollama_get_model_catalog'),
    downloadRuntime: () => call('ollama_download_runtime'),
    selectRuntimeMode: (mode) => call('ollama_select_runtime_mode', { mode }),
    selectModelTier: (tierId) => call('ollama_select_model_tier', { tierId }),
    selectCloudModel: (cloudModelId) => call('ollama_select_cloud_model', { cloudModelId }),
    downloadModel: (tierId) => call('ollama_download_model', { tierId }),
    deleteModel: (tierId) => call('ollama_delete_model', { tierId }),
    openModelsDir: () => call('ollama_open_models_dir'),
    getStoragePaths: () => call('ollama_get_storage_paths'),
    chat: (payload = {}, onProgress) => {
      const requestId = payload.requestId || crypto.randomUUID();
      const off = typeof onProgress === 'function'
        ? subscribe('ollama:chat-progress', (data) => {
            if (data?.requestId === requestId) onProgress(data);
          })
        : null;
      return call('ollama_chat', { payload: { ...payload, requestId } }).finally(() => off?.());
    },
    abortChat: (requestId) => call('ollama_abort_chat', { requestId }),
    clearAgentContext: (peerId) => call('ollama_clear_agent_context', { peerId }),
    onAskUser: (callback) => subscribe('ollama:ask-user', callback),
    replyAskUser: (requestId, answer) => call('ollama_reply_ask_user', { requestId, answer }),
    startCloudSignIn: () => call('ollama_start_cloud_sign_in'),
    confirmCloudAuth: () => call('ollama_confirm_cloud_auth'),
    resetAndDelete: () => call('ollama_reset_and_delete'),
  }),

  agent: Object.freeze({
    pickFolder: async () => {
      const result = await call('agent_pick_folder');
      return result?.ok ? result.path : null;
    },
    sendMessageReply: ({ requestId, result }) => call('agent_send_message_reply', { requestId, result }),
    connectPeerReply: ({ requestId, result }) => call('agent_connect_peer_reply', { requestId, result }),
  }),

  poker: Object.freeze(gameBridge('poker', '/poker-game')),
  uno: Object.freeze(gameBridge('uno', '/uno-game')),
  connectFour: Object.freeze(gameBridge('connect-four', '/connect-four-game')),
  chess: Object.freeze(gameBridge('chess', '/chess-game')),
  ticTacToe: Object.freeze(gameBridge('ticTacToe', '/tic-tac-toe-game')),
  docs: Object.freeze(docsBridge),

  app: Object.freeze({
    clearCache: () => call('app_clear_cache'),
    clearMessages: () => call('app_clear_messages'),
    wipeAllData: () => call('app_wipe_all_data'),
    getConfigLogPath: () => call('app_get_config_log_path'),
    readConfigTail: (maxBytes) => call('app_read_config_tail', { maxBytes }),
  }),

  plugins: Object.freeze({
    list: () => call('plugins_list'),
    rescan: () => call('plugins_rescan'),
    reseedBundled: () => call('plugins_reseed_bundled'),
    setEnabled: (id, enabled) => call('plugins_set_enabled', { id, enabled }),
    openDir: () => call('plugins_open_dir'),
    installFromDialog: () => call('plugins_install_from_dialog'),
    install: (payload) => call('plugins_install', { payload }),
    uninstall: (id) => call('plugins_uninstall', { id }),
    invokeCommand: (id, commandId, args) => call('plugins_invoke_command', { id, commandId, args }),
    sendToMain: (id, payload) => call('plugins_send_to_main', { id, payload }),
  }),

  on: subscribe,
});

Object.defineProperty(window, 'bluetalk', {
  value: api,
  configurable: false,
  enumerable: true,
  writable: false,
});

export default api;
