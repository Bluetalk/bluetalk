// Reine Konstanten und Default-Settings für die App-Komponente.
// Ausgelagert aus App.jsx (keine Abhängigkeit von React-State/Hooks).

export const CHAT_MESSAGE_BATCH_SIZE = 24;
export const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_TEXT_CHARS = 128 * 1024;

export const DEFAULT_APP_SETTINGS = {
  displayName: 'Anonymous',
  onboardingUsernameDone: false,
  bio: '',
  profilePicture: '',
  peerPort: 0,
  peerPorts: [],
  apiPort: 19876,
  autoUpdateEnabled: true,
  autoDownloadUpdates: true,
  minimizeToTray: true,
  launchAtLogin: false,
  theme: 'dark',
  debugMode: false,
  windowsNotifications: true,
  doNotDisturb: false,
  sendReadReceipts: true,
  /** Gespeicherte Panel-Breiten (Pixel). */
  uiResize: {},
  /** Eingeklappte Panels (Standard: alles sichtbar). */
  uiCollapse: {
    sidebar: false,
    chatList: false,
    aiAgents: false,
  },
};
