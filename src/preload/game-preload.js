const { contextBridge, ipcRenderer } = require('electron');

const GAME_CONFIG = {
  poker: { bridge: 'poker', channel: 'poker' },
  uno: { bridge: 'uno', channel: 'uno' },
  'connect-four': { bridge: 'connectFour', channel: 'connect-four' },
  chess: { bridge: 'chess', channel: 'chess' },
  'tic-tac-toe': { bridge: 'ticTacToe', channel: 'ticTacToe' },
  // Editor-Fenster darf zusätzlich Dateien speichern (docx-Export).
  'live-docs': { bridge: 'docs', channel: 'docs', allowSaveAs: true },
};

const gameId = process.argv
  .find((arg) => arg.startsWith('--bluetalk-game='))
  ?.slice('--bluetalk-game='.length);
const config = GAME_CONFIG[gameId];

if (config) {
  const { bridge, channel } = config;
  const gameApi = {
    closeGameWindow: () => ipcRenderer.invoke(`${channel}:closeGameWindow`),
    minimizeWindow: () => ipcRenderer.invoke(`${channel}:minimizeWindow`),
    maximizeWindow: () => ipcRenderer.invoke(`${channel}:maximizeWindow`),
    isWindowMaximized: () => ipcRenderer.invoke(`${channel}:isWindowMaximized`),
    onWindowMaximizedChange: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, maximized) => callback(maximized);
      ipcRenderer.on(`${channel}:windowMaximized`, listener);
      return () => ipcRenderer.removeListener(`${channel}:windowMaximized`, listener);
    },
    sendAction: (payload) => ipcRenderer.send(`${channel}:fromChild`, payload),
    onState: (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on(`${channel}:state`, listener);
      return () => ipcRenderer.removeListener(`${channel}:state`, listener);
    },
  };
  if (config.allowSaveAs) {
    gameApi.saveAs = (payload) => ipcRenderer.invoke('file:saveAs', payload);
  }
  if (gameId === 'live-docs') {
    // Fremd-Cursor/-Auswahl der Mit-Bearbeiter (leichtgewichtiger Kanal).
    gameApi.onPeerPresence = (callback) => {
      if (typeof callback !== 'function') return () => undefined;
      const listener = (_, data) => callback(data);
      ipcRenderer.on(`${channel}:peerPresence`, listener);
      return () => ipcRenderer.removeListener(`${channel}:peerPresence`, listener);
    };
  }

  contextBridge.exposeInMainWorld('bluetalk', {
    peer: {
      getInfo: () => ipcRenderer.invoke('peer:getInfo'),
    },
    [bridge]: gameApi,
  });
}
