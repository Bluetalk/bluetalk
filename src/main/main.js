const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, dialog, session, shell } = require('electron');
const fs = require('fs/promises');
const { autoUpdater } = require('electron-updater');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const { PeerServer, normalizeConnectAddress } = require(path.join(__dirname, '..', 'shared', 'peer-server.js'));
const { APIServer } = require(path.join(__dirname, '..', 'shared', 'api-server.js'));
const Store = require(path.join(__dirname, '..', 'shared', 'store.js'));
const { isPeerNotificationMuted } = require(path.join(__dirname, '..', 'shared', 'contactNotificationMute.js'));
const { getEffectiveFlag } = require(path.join(__dirname, '..', 'shared', 'featureFlags.js'));
const { PluginHost } = require(path.join(__dirname, 'plugin-host.js'));

let mainWindow = null;
/** Separates Fenster für das Poker-Plugin (Spieltisch). */
let pokerGameWindow = null;
/** Separates Fenster für das UNO-Plugin. */
let unoGameWindow = null;
let tray = null;
let peerServer = null;
let apiServer = null;
let pluginHost = null;
let store = null;
/** Last port the REST API successfully bound to; used to avoid unnecessary restarts. */
let lastApiServerPort = null;
let isQuitting = false;
let updateCheckTimer = null;
let updaterReady = false;

const isDev = !app.isPackaged;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

app.setName('BlueTalk');
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.bluetalk.app' : 'BlueTalk');
}

const NETWORK_TEST_HOST = 'portquiz.net';
const NETWORK_TEST_PORTS = [443, 8443, 8080, 3000, 5000, 9090, 8888, 4443, 80];
const PORT_TEST_TIMEOUT_MS = 1800;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APP_ICON_PATH = path.join(__dirname, '..', '..', 'assets', 'icon.png');
const CHAT_MESSAGE_BATCH_SIZE = 24;
const MAX_SAVE_BASE64_CHARS = 12 * 1024 * 1024;

/** GitHub release exists but `latest.yml` / blockmap not uploaded yet (electron-updater 404). */
const UPDATE_RELEASE_PENDING_MESSAGE =
  'The latest release does not include Windows update files yet—they may still be building or uploading. Try again in a few minutes.';

function isReleaseAssetsPendingError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = error.code;
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true;
  const status = error.statusCode ?? error.status;
  if (status === 404) return true;
  const msg = String(error.message || '').toLowerCase();
  if (msg.includes('status code 404')) return true;
  if (msg.includes('404')) {
    if (msg.includes('latest.yml') || msg.includes('releases/download') || msg.includes('not found')) {
      return true;
    }
  }
  return false;
}

let updateState = {
  supported: false,
  status: 'idle',
  message: '',
  errorMessage: '',
  currentVersion: app.getVersion(),
  availableVersion: '',
  downloadedVersion: '',
  releaseName: '',
  releaseDate: 0,
  autoUpdateEnabled: true,
  autoDownloadUpdates: true,
  percent: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  bytesPerSecond: 0,
  lastCheckedAt: 0,
};

let appIcon = null;

function getStoredMessages() {
  return store?.get('messages', {}) || {};
}

function getStoredChatMessages(peerId) {
  const list = store?.get(`messages.${peerId}`, []);
  return Array.isArray(list) ? list : [];
}

function toMessageSummary(message) {
  if (!message || typeof message !== 'object') return message || null;
  const { fileData, localPreviewUrl, ...summary } = message;
  return summary;
}

function setStoredChatMessages(peerId, list) {
  if (!store || !peerId) return [];
  store.set(`messages.${peerId}`, list);
  return list;
}

function appendStoredChatMessage(peerId, message) {
  const current = getStoredChatMessages(peerId);
  if (message?.messageId && current.some((item) => item?.messageId === message.messageId)) {
    return { messages: current, appended: false };
  }
  const updated = [...current, message];
  setStoredChatMessages(peerId, updated);
  return { messages: updated, appended: true };
}

function patchStoredChatMessage(peerId, messageId, patch) {
  if (!peerId || !messageId || !patch || typeof patch !== 'object') return false;
  const list = getStoredChatMessages(peerId);
  const idx = list.findIndex((m) => m && m.messageId === messageId);
  if (idx < 0) return false;
  list[idx] = { ...list[idx], ...patch };
  setStoredChatMessages(peerId, list);
  return true;
}

function deleteStoredChatMessage(peerId, messageId) {
  if (!peerId || !messageId) return false;
  const list = getStoredChatMessages(peerId);
  const idx = list.findIndex((m) => m && m.messageId === messageId);
  if (idx < 0) return false;
  list.splice(idx, 1);
  setStoredChatMessages(peerId, list);
  return true;
}

function getChatMessageMeta() {
  const storedMessages = getStoredMessages();
  const meta = {};

  for (const [peerId, rawMessages] of Object.entries(storedMessages)) {
    if (peerId === 'self') continue;
    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    if (messages.length === 0) continue;

    meta[peerId] = {
      count: messages.length,
      lastMessage: toMessageSummary(messages[messages.length - 1]),
    };
  }

  return meta;
}

function getChatMessageBatch(peerId, options = {}) {
  const messages = getStoredChatMessages(peerId);
  const skip = Math.max(0, Number(options.skip) || 0);
  const limit = Math.min(100, Math.max(1, Number(options.limit) || CHAT_MESSAGE_BATCH_SIZE));
  const total = messages.length;
  const end = Math.max(0, total - skip);
  const start = Math.max(0, end - limit);

  return {
    messages: messages.slice(start, end),
    total,
    remaining: start,
    hasMore: start > 0,
    batchSize: end - start,
  };
}

function getFileCategoryForLibrary(mime, fileName) {
  const m = String(mime || '').toLowerCase();
  const ext = String(fileName || '').split('.').pop()?.toLowerCase() || '';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  return 'other';
}

function listLibraryMedia() {
  const storedMessages = getStoredMessages();
  const items = [];

  for (const [peerId, rawMessages] of Object.entries(storedMessages)) {
    if (peerId === 'self') continue;
    const messages = Array.isArray(rawMessages) ? rawMessages : [];
    for (const m of messages) {
      if (!m || (m.kind !== 'file' && m.kind !== 'sticker')) continue;
      if (m.from === 'self') continue;
      items.push({
        messageId: m.messageId,
        peerId,
        from: m.from,
        sender: m.sender,
        timestamp: m.timestamp || 0,
        kind: m.kind,
        fileName: m.fileName,
        fileType: m.fileType,
        fileSize: m.fileSize || 0,
        stickerId: m.stickerId,
        packId: m.packId,
        category: m.kind === 'sticker' ? 'sticker' : getFileCategoryForLibrary(m.fileType, m.fileName),
        hasData: Boolean(m.fileData),
      });
    }
  }

  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return items;
}

function getLibraryMediaData(peerId, messageId) {
  if (!peerId || !messageId) return null;
  const list = getStoredChatMessages(peerId);
  const m = list.find((item) => item?.messageId === messageId);
  if (!m || (m.kind !== 'file' && m.kind !== 'sticker')) return null;
  return {
    fileData: m.fileData,
    fileName: m.fileName,
    fileType: m.fileType,
    fileSize: m.fileSize,
    kind: m.kind,
  };
}

function createAppIcon(size) {
  if (!appIcon || appIcon.isEmpty()) {
    appIcon = nativeImage.createFromPath(APP_ICON_PATH);
  }

  if (!appIcon || appIcon.isEmpty()) {
    return nativeImage.createEmpty();
  }

  if (!size) {
    return appIcon;
  }

  return appIcon.resize({ width: size, height: size, quality: 'best' });
}

function getUpdaterSupport() {
  if (isDev) {
    return {
      supported: false,
      reason: 'Auto updates are only available in packaged builds.',
    };
  }

  if (process.platform === 'win32' && (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR)) {
    return {
      supported: false,
      reason: 'Portable builds cannot self-update. Install the NSIS release to use auto updates.',
    };
  }

  return { supported: true, reason: '' };
}

function getUpdaterPreferences() {
  return {
    autoUpdateEnabled: store?.get('settings.autoUpdateEnabled', true) ?? true,
    autoDownloadUpdates: store?.get('settings.autoDownloadUpdates', true) ?? true,
  };
}

function serializeUpdateInfo(info = {}) {
  return {
    availableVersion: info.version || '',
    releaseName: info.releaseName || info.version || '',
    releaseDate: info.releaseDate ? new Date(info.releaseDate).getTime() : 0,
  };
}

function broadcastUpdateState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('updater:state', updateState);
}

function patchUpdateState(patch = {}) {
  const support = getUpdaterSupport();
  const prefs = getUpdaterPreferences();

  updateState = {
    ...updateState,
    currentVersion: app.getVersion(),
    supported: support.supported,
    autoUpdateEnabled: prefs.autoUpdateEnabled,
    autoDownloadUpdates: prefs.autoDownloadUpdates,
    ...patch,
  };

  if (!support.supported) {
    updateState = {
      ...updateState,
      status: 'unsupported',
      message: support.reason,
      errorMessage: '',
      availableVersion: '',
      downloadedVersion: '',
      releaseName: '',
      releaseDate: 0,
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    };
  }

  broadcastUpdateState();
  return updateState;
}

function configureAutoUpdater() {
  const support = getUpdaterSupport();
  if (!support.supported) {
    patchUpdateState();
    return false;
  }

  const prefs = getUpdaterPreferences();
  autoUpdater.autoDownload = prefs.autoDownloadUpdates;
  // On Windows we use a custom quit handler; don't let electron-updater auto-install
  autoUpdater.autoInstallOnAppQuit = process.platform !== 'win32';
  autoUpdater.disableWebInstaller = true;
  patchUpdateState();
  return true;
}

function scheduleAutoUpdateChecks() {
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }

  const support = getUpdaterSupport();
  const prefs = getUpdaterPreferences();
  if (!support.supported || !prefs.autoUpdateEnabled) {
    patchUpdateState();
    return;
  }

  updateCheckTimer = setInterval(() => {
    void checkForAppUpdates('background');
  }, UPDATE_CHECK_INTERVAL_MS);
}

async function checkForAppUpdates(source = 'manual') {
  const support = getUpdaterSupport();
  if (!support.supported) {
    return patchUpdateState();
  }

  const prefs = getUpdaterPreferences();
  if (source !== 'manual' && !prefs.autoUpdateEnabled) {
    return patchUpdateState();
  }

  configureAutoUpdater();

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    if (isReleaseAssetsPendingError(error)) {
      patchUpdateState({
        status: 'pending_build',
        message: UPDATE_RELEASE_PENDING_MESSAGE,
        errorMessage: '',
        availableVersion: '',
        downloadedVersion: '',
        releaseName: '',
        releaseDate: 0,
        lastCheckedAt: Date.now(),
      });
    } else {
      patchUpdateState({
        status: 'error',
        message: 'Update check failed.',
        errorMessage: error?.message || 'Unknown update error.',
        lastCheckedAt: Date.now(),
      });
    }
  }

  return updateState;
}

async function downloadAppUpdate() {
  const support = getUpdaterSupport();
  if (!support.supported) {
    return patchUpdateState();
  }

  if (updateState.status === 'downloaded' || updateState.status === 'downloading') {
    return updateState;
  }

  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    if (isReleaseAssetsPendingError(error)) {
      patchUpdateState({
        status: 'pending_build',
        message: UPDATE_RELEASE_PENDING_MESSAGE,
        errorMessage: '',
        /* keep availableVersion / release info from update-available if present */
      });
    } else {
      patchUpdateState({
        status: 'error',
        message: 'Update download failed.',
        errorMessage: error?.message || 'Unknown download error.',
      });
    }
  }

  return updateState;
}

function installDownloadedUpdate() {
  const support = getUpdaterSupport();
  if (!support.supported || updateState.status !== 'downloaded') {
    return false;
  }

  isQuitting = true;
  peerServer?.stop();
  apiServer?.stop();
  pluginHost?.stop().catch(() => {});
  // Silent NSIS (/S) + --force-run: no setup wizard; app restarts after install (Windows).
  autoUpdater.quitAndInstall(true, true);
  return true;
}

function installPendingUpdateOnQuit(_event, exitCode) {
  if (process.platform !== 'win32' || exitCode !== 0) return;
  const support = getUpdaterSupport();
  if (!support.supported) return;
  const prefs = getUpdaterPreferences();
  if (!prefs.autoUpdateEnabled) return;
  if (updateState.status !== 'downloaded') return;

  try {
    // Use quitAndInstall for proper update installation on quit
    autoUpdater.quitAndInstall(true, true);
  } catch (err) {
    console.error('Failed to install update on quit:', err);
  }
}

function setupAutoUpdater() {
  if (updaterReady) return;
  updaterReady = true;

  if (process.platform === 'win32') {
    autoUpdater.autoInstallOnAppQuit = false;
    app.on('quit', installPendingUpdateOnQuit);
  }

  autoUpdater.on('checking-for-update', () => {
    patchUpdateState({
      status: 'checking',
      message: 'Checking for updates...',
      errorMessage: '',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
    });
  });

  autoUpdater.on('update-available', (info) => {
    patchUpdateState({
      ...serializeUpdateInfo(info),
      status: 'available',
      message: autoUpdater.autoDownload
        ? 'Update found. Downloading now...'
        : 'Update found. Ready to download.',
      errorMessage: '',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on('update-not-available', () => {
    patchUpdateState({
      status: 'idle',
      message: 'BlueTalk is up to date.',
      errorMessage: '',
      availableVersion: '',
      downloadedVersion: '',
      releaseName: '',
      releaseDate: 0,
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    patchUpdateState({
      status: 'downloading',
      message: `Downloading update... ${Math.round(progress.percent || 0)}%`,
      percent: Number((progress.percent || 0).toFixed(1)),
      downloadedBytes: progress.transferred || 0,
      totalBytes: progress.total || 0,
      bytesPerSecond: progress.bytesPerSecond || 0,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    patchUpdateState({
      ...serializeUpdateInfo(info),
      status: 'downloaded',
      message: 'Update downloaded. Restart BlueTalk to install it.',
      downloadedVersion: info.version || updateState.availableVersion || '',
      percent: 100,
      downloadedBytes: updateState.totalBytes || updateState.downloadedBytes,
      lastCheckedAt: Date.now(),
    });
  });

  autoUpdater.on('error', (error) => {
    if (isReleaseAssetsPendingError(error)) {
      patchUpdateState({
        status: 'pending_build',
        message: UPDATE_RELEASE_PENDING_MESSAGE,
        errorMessage: '',
        lastCheckedAt: Date.now(),
      });
    } else {
      patchUpdateState({
        status: 'error',
        message: 'Auto update error.',
        errorMessage: error?.message || 'Unknown update error.',
        lastCheckedAt: Date.now(),
      });
    }
  });

  configureAutoUpdater();
  scheduleAutoUpdateChecks();

  if (getUpdaterSupport().supported && getUpdaterPreferences().autoUpdateEnabled) {
    setTimeout(() => {
      void checkForAppUpdates('startup');
    }, 5000);
  }
}

function compareVersionParts(left, right) {
  const a = String(left || '0').split('.').map((part) => Number(part) || 0);
  const b = String(right || '0').split('.').map((part) => Number(part) || 0);
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return 0;
}

async function readPluginManifest(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function seedBundledPlugins(host) {
  if (!host) return;
  const bundledDir = path.join(__dirname, '..', '..', 'assets', 'bundled-plugins');
  let entries = [];
  try {
    entries = await fs.readdir(bundledDir, { withFileTypes: true });
  } catch {
    return;
  }
  await fs.mkdir(host.getPluginsDir(), { recursive: true }).catch(() => {});
  const pluginsDir = host.getPluginsDir();
  const userRemoved = store?.get('plugins.userRemoved', {}) || {};
  for (const entry of entries) {
    if (typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
    if (userRemoved[entry.name]) continue;
    const srcDir = path.join(bundledDir, entry.name);
    const destDir = path.join(pluginsDir, entry.name);
    let destExists = true;
    try {
      await fs.access(destDir);
    } catch {
      destExists = false;
    }
    if (destExists) {
      const [sourceManifest, installedManifest] = await Promise.all([
        readPluginManifest(srcDir),
        readPluginManifest(destDir),
      ]);
      if (
        sourceManifest?.id !== entry.name
        || compareVersionParts(sourceManifest?.version, installedManifest?.version) <= 0
      ) {
        continue;
      }
    }
    try {
      await host.installFromDirectory(srcDir);
    } catch (e) {
      console.error(`[PluginHost] seed ${entry.name}:`, e);
    }
  }
}

function applyLaunchAtLoginSetting() {
  if (!store) return;
  const wantsLaunch = Boolean(store.get('settings.launchAtLogin', false) ?? false);
  const openAtLogin = app.isPackaged && wantsLaunch;
  try {
    app.setLoginItemSettings({
      openAtLogin,
      path: process.execPath,
    });
  } catch (err) {
    console.error('Launch at login:', err);
  }
}

function restartApiServerIfPortChanged() {
  if (!apiServer || !store) return;
  const nextPort = store.get('settings.apiPort', 19876);
  if (lastApiServerPort !== null && nextPort === lastApiServerPort) {
    return;
  }
  apiServer.stop((err) => {
    if (err) {
      console.error('API server stop error:', err);
    }
    try {
      apiServer.start(nextPort);
      lastApiServerPort = nextPort;
    } catch (e) {
      console.error('API server restart error:', e);
      lastApiServerPort = null;
    }
  });
}

function handleSettingsMutation() {
  configureAutoUpdater();
  scheduleAutoUpdateChecks();
  applyLaunchAtLoginSetting();
  restartApiServerIfPortChanged();
  // Only reconnect if peer server is fully started
  if (peerServer?.port > 0) {
    peerServer.reconnectContactsFromStore();
  }
}

async function readTailOfFile(filePath, maxBytes = 120_000) {
  try {
    const stat = await fs.stat(filePath);
    const size = stat.size;
    const start = size > maxBytes ? size - maxBytes : 0;
    const length = size - start;
    const fh = await fs.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, start);
      let text = buf.toString('utf-8');
      if (start === 0) {
        try {
          const parsed = JSON.parse(text);
          const redact = (value) => {
            if (!value || typeof value !== 'object') return;
            for (const [key, child] of Object.entries(value)) {
              if (['privateJwk', 'aesKeyB64', 'apiToken', 'fileData', 'profilePicture'].includes(key)) {
                value[key] = '[redacted]';
              } else {
                redact(child);
              }
            }
          };
          redact(parsed);
          text = JSON.stringify(parsed, null, 2);
        } catch {
          /* display a safely redacted raw tail below */
        }
      }
      text = text.replace(/("(?:apiToken|aesKeyB64|fileData|profilePicture)"\s*:\s*")[^"]*(")/g, '$1[redacted]$2');
      return { ok: true, path: filePath, truncated: start > 0, text };
    } finally {
      await fh.close();
    }
  } catch (e) {
    return { ok: false, path: filePath, error: e?.message || 'read_failed' };
  }
}

async function runNetworkDoctor() {
  const portProbe = await runPortDiagnostics();
  const peerInfo = peerServer?.getInfo?.() || null;
  const apiPort = store?.get('settings.apiPort', 19876) ?? 19876;
  const issues = [];
  const fixes = [];

  if (!peerInfo?.ports?.length) {
    issues.push({ code: 'no_listen_ports', severity: 'error', message: 'No peer listen ports are active.' });
  }

  if (portProbe?.summary?.openCount === 0) {
    issues.push({
      code: 'outbound_probe_blocked',
      severity: 'warn',
      message: 'Outbound TCP probes to common ports did not succeed (strict firewall or offline).',
    });
  }

  if (peerInfo?.addresses?.length === 0) {
    issues.push({
      code: 'no_lan_ipv4',
      severity: 'warn',
      message: 'No non-loopback IPv4 interfaces found; LAN discovery may be limited.',
    });
  }

  return {
    checkedAt: Date.now(),
    portProbe,
    peerInfo: peerInfo
      ? {
          id: peerInfo.id,
          port: peerInfo.port,
          ports: peerInfo.ports,
          addresses: peerInfo.addresses,
          endpoints: peerInfo.endpoints,
          peerCount: peerInfo.peers?.length ?? 0,
        }
      : null,
    apiPort,
    issues,
    fixes,
  };
}

function testSinglePort(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (status, code = null) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ port, status, code });
    };

    socket.setTimeout(PORT_TEST_TIMEOUT_MS);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('blocked', 'TIMEOUT'));
    socket.once('error', (err) => {
      const blockedCodes = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EACCES']);
      finish(blockedCodes.has(err.code) ? 'blocked' : 'error', err.code || 'UNKNOWN');
    });

    socket.connect(port, host);
  });
}

async function runPortDiagnostics() {
  const checks = await Promise.all(NETWORK_TEST_PORTS.map((port) => testSinglePort(NETWORK_TEST_HOST, port)));
  const openPorts = checks.filter((item) => item.status === 'open').map((item) => item.port);

  return {
    host: NETWORK_TEST_HOST,
    testedAt: Date.now(),
    checks,
    recommendedPort: openPorts[0] || 0,
    summary: {
      openCount: openPorts.length,
      blockedCount: checks.length - openPorts.length,
    },
  };
}

function isAppInForeground() {
  const focused = BrowserWindow.getFocusedWindow();
  if (!focused || focused.isDestroyed()) return false;
  return (
    (mainWindow && !mainWindow.isDestroyed() && focused === mainWindow)
    || (pokerGameWindow && !pokerGameWindow.isDestroyed() && focused === pokerGameWindow)
    || (unoGameWindow && !unoGameWindow.isDestroyed() && focused === unoGameWindow)
  );
}

function showWindowsNotification(title, body = '', options = {}) {
  if (process.platform !== 'win32') return false;
  if (!Notification.isSupported()) return false;
  if (store && store.get('settings.windowsNotifications', true) === false) {
    return false;
  }
  if (!options.allowInForeground && isAppInForeground()) {
    return false;
  }

  const notification = new Notification({
    title: title || 'BlueTalk',
    body,
    icon: createAppIcon(),
    silent: false,
  });

  notification.on('click', () => showMainWindow());
  notification.show();
  return true;
}

const INCOMING_NOTIF_GROUP_MS = 2200;
let incomingNotifBatch = {
  senderLabel: '',
  previews: [],
  timer: null,
};

function flushIncomingNotificationBatch() {
  if (incomingNotifBatch.timer) {
    clearTimeout(incomingNotifBatch.timer);
    incomingNotifBatch.timer = null;
  }
  const { senderLabel, previews } = incomingNotifBatch;
  incomingNotifBatch.previews = [];
  incomingNotifBatch.senderLabel = '';
  if (!previews.length) return;
  if (isAppInForeground()) return;

  if (previews.length === 1) {
    showWindowsNotification(senderLabel || 'BlueTalk', previews[0]);
    return;
  }

  showWindowsNotification(
    'BlueTalk',
    `You have ${previews.length} notifications from ${senderLabel || 'a contact'}`
  );
}

function isContactBlockedInStore(peerId) {
  if (!store || !peerId) return false;
  const contacts = store.get('contacts', []);
  return contacts.some((c) => c && c.id === peerId && c.blocked === true);
}

function isContactNotificationMutedInStore(peerId) {
  if (!store || !peerId) return false;
  const settings = store.get('settings', {});
  if (!getEffectiveFlag(settings, 'contactNotificationMute')) return false;
  return isPeerNotificationMuted(store.get('contacts', []), peerId);
}

function queueIncomingChatNotification(data) {
  if (store && store.get('settings.windowsNotifications', true) === false) {
    return;
  }
  if (isAppInForeground()) {
    return;
  }
  const senderLabel = data.sender || data.from || 'BlueTalk';
  const preview =
    data.kind === 'encrypted-chat-e2ee'
      ? 'New encrypted message'
      : data.kind === 'file'
        ? `File: ${data.fileName || data.content || 'Attachment'}`
        : data.kind === 'poker-invite'
          ? `Poker: ${data.tableName || 'Einladung'}`
          : data.kind === 'uno-invite'
            ? `UNO: ${data.tableName || 'Einladung'}`
            : data.kind === 'contact-share'
            ? `Kontakt: ${data.sharedContact?.displayName || data.sharedContact?.name || 'geteilt'}`
            : (data.content || 'New message');

  if (incomingNotifBatch.senderLabel !== senderLabel) {
    flushIncomingNotificationBatch();
    incomingNotifBatch.senderLabel = senderLabel;
  }

  incomingNotifBatch.previews.push(preview);
  if (incomingNotifBatch.timer) {
    clearTimeout(incomingNotifBatch.timer);
  }
  incomingNotifBatch.timer = setTimeout(() => {
    flushIncomingNotificationBatch();
  }, INCOMING_NOTIF_GROUP_MS);
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  if (app.isReady()) {
    createWindow();
  }
}

function windowFromIpcEvent(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function bindWindowMaximizeEvents(win, channel = 'window:maximized') {
  if (!win) return;
  const notify = () => {
    if (win.isDestroyed()) return;
    try {
      win.webContents.send(channel, win.isMaximized());
    } catch {
      /* webContents unavailable during teardown */
    }
  };
  win.on('maximize', notify);
  win.on('unmaximize', notify);
  win.webContents.on('did-finish-load', notify);
}

function isPokerGameSender(event) {
  return Boolean(
    pokerGameWindow
    && !pokerGameWindow.isDestroyed()
    && event.sender === pokerGameWindow.webContents,
  );
}

function isUnoGameSender(event) {
  return Boolean(
    unoGameWindow
    && !unoGameWindow.isDestroyed()
    && event.sender === unoGameWindow.webContents,
  );
}

function isTrustedRendererUrl(value) {
  try {
    const url = new URL(value);
    if (isDev) return url.protocol === 'http:' && url.hostname === 'localhost' && url.port === '5173';
    if (url.protocol !== 'file:') return false;
    const expected = path.normalize(path.join(__dirname, '..', '..', 'dist', 'index.html'));
    return path.normalize(decodeURIComponent(url.pathname).replace(/^\/(?:([A-Za-z]:))/, '$1')) === expected;
  } catch {
    return false;
  }
}

function hardenWindow(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function configureSessionSecurity() {
  const trusted = (webContents) => isTrustedRendererUrl(webContents?.getURL?.() || '');
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => (
    trusted(webContents) && permission === 'clipboard-sanitized-write'
  ));
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(trusted(webContents) && permission === 'clipboard-sanitized-write');
  });
}

/** Peers can connect before the renderer registers IPC listeners; push authoritative state after each load. */
function syncPeersToRenderer() {
  if (!mainWindow || mainWindow.isDestroyed() || !peerServer) return;
  try {
    mainWindow.webContents.send('peers:list-sync', peerServer.getPeers());
  } catch {
    /* webContents unavailable during teardown */
  }
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 520,
    minHeight: 400,
    frame: false,
    transparent: false,
    backgroundColor: '#0a0a0f',
    icon: createAppIcon(256),
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    show: false,
  });
  hardenWindow(mainWindow);

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    broadcastUpdateState();
    if (!mainWindow.isDestroyed()) {
      try {
        mainWindow.webContents.send('window:maximized', mainWindow.isMaximized());
      } catch {
        /* ignore */
      }
    }
    syncPeersToRenderer();
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (e) => {
    const minimizeToTray = store?.get('settings.minimizeToTray', true);
    if (!isQuitting && minimizeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  bindWindowMaximizeEvents(mainWindow);

  return mainWindow;
}

function createPokerGameWindow() {
  if (pokerGameWindow && !pokerGameWindow.isDestroyed()) {
    try {
      pokerGameWindow.focus();
    } catch {
      /* ignore */
    }
    return pokerGameWindow;
  }

  pokerGameWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    transparent: false,
    backgroundColor: '#071018',
    icon: createAppIcon(256),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    show: false,
  });
  hardenWindow(pokerGameWindow);

  if (isDev) {
    pokerGameWindow.loadURL('http://localhost:5173/#/poker-game');
  } else {
    const indexHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');
    pokerGameWindow.loadURL(`${pathToFileURL(indexHtml).href}#/poker-game`);
  }

  pokerGameWindow.once('ready-to-show', () => {
    try {
      pokerGameWindow?.show();
    } catch {
      /* ignore */
    }
  });

  pokerGameWindow.on('closed', () => {
    pokerGameWindow = null;
  });

  bindWindowMaximizeEvents(pokerGameWindow, 'poker:windowMaximized');

  return pokerGameWindow;
}

function createUnoGameWindow() {
  if (unoGameWindow && !unoGameWindow.isDestroyed()) {
    try {
      unoGameWindow.focus();
    } catch {
      /* ignore */
    }
    return unoGameWindow;
  }

  unoGameWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    frame: false,
    transparent: false,
    backgroundColor: '#0a1020',
    icon: createAppIcon(256),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
    show: false,
  });
  hardenWindow(unoGameWindow);

  if (isDev) {
    unoGameWindow.loadURL('http://localhost:5173/#/uno-game');
  } else {
    const indexHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');
    unoGameWindow.loadURL(`${pathToFileURL(indexHtml).href}#/uno-game`);
  }

  unoGameWindow.once('ready-to-show', () => {
    try {
      unoGameWindow?.show();
    } catch {
      /* ignore */
    }
  });

  unoGameWindow.on('closed', () => {
    unoGameWindow = null;
  });

  bindWindowMaximizeEvents(unoGameWindow, 'uno:windowMaximized');

  return unoGameWindow;
}

function createTray() {
  tray = new Tray(createAppIcon(32));
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open BlueTalk', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Status: Online', enabled: false },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('BlueTalk - P2P Chat');
  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => showMainWindow());
}

async function clearRendererSessionCaches() {
  const targets = [session.defaultSession];
  if (mainWindow && !mainWindow.isDestroyed()) {
    const s = mainWindow.webContents.session;
    if (s && !targets.includes(s)) targets.push(s);
  }
  for (const s of targets) {
    try {
      await s.clearCache();
    } catch (e) {
      console.error('clearCache error:', e);
    }
    try {
      await s.clearStorageData();
    } catch (e) {
      console.error('clearStorageData error:', e);
    }
  }
}

async function wipeAllLocalAppData() {
  if (!store || !peerServer || !apiServer) {
    return { ok: false, error: 'not_ready' };
  }
  try {
    await new Promise((resolve) => apiServer.stop(() => resolve()));
    peerServer.stop();
    // Wait for sockets to fully close before restarting
    await new Promise((resolve) => setTimeout(resolve, 500));
    await store.clearAll();
    peerServer.reloadIdentityFromStore();
    await peerServer.start();
    const restoredPort = store.get('settings.apiPort', 19876);
    apiServer.start(restoredPort);
    lastApiServerPort = restoredPort;
    handleSettingsMutation();
    mainWindow?.webContents?.send('peers:list-sync', []);
    mainWindow?.webContents?.send('app:data-cleared', { kind: 'all' });
    return { ok: true };
  } catch (e) {
    console.error('wipeAllLocalAppData error:', e);
    return { ok: false, error: e?.message || 'wipe_failed' };
  }
}

async function clearStoredChatMessagesOnly() {
  if (!store) return { ok: false, error: 'not_ready' };
  try {
    store.delete('messages');
    mainWindow?.webContents?.send('app:data-cleared', { kind: 'messages' });
    return { ok: true };
  } catch (e) {
    console.error('clearStoredChatMessagesOnly error:', e);
    return { ok: false, error: e?.message || 'clear_messages_failed' };
  }
}

function setupIPC() {
  ipcMain.handle('window:minimize', (event) => windowFromIpcEvent(event)?.minimize());
  ipcMain.handle('window:maximize', (event) => {
    const win = windowFromIpcEvent(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle('window:isMaximized', (event) => windowFromIpcEvent(event)?.isMaximized() ?? false);
  ipcMain.handle('window:close', (event) => windowFromIpcEvent(event)?.close());

  ipcMain.handle('poker:openGameWindow', () => {
    try {
      createPokerGameWindow();
      return { ok: true };
    } catch (e) {
      console.error('[Poker] open window:', e);
      return { ok: false, error: e?.message || 'open_failed' };
    }
  });

  ipcMain.handle('poker:closeGameWindow', () => {
    try {
      if (pokerGameWindow && !pokerGameWindow.isDestroyed()) {
        pokerGameWindow.close();
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'close_failed' };
    }
  });

  ipcMain.handle('poker:minimizeWindow', (event) => {
    if (!isPokerGameSender(event)) return { ok: false };
    try {
      pokerGameWindow?.minimize();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'minimize_failed' };
    }
  });

  ipcMain.handle('poker:maximizeWindow', (event) => {
    if (!isPokerGameSender(event)) return { ok: false };
    try {
      if (pokerGameWindow?.isMaximized()) pokerGameWindow.unmaximize();
      else pokerGameWindow?.maximize();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'maximize_failed' };
    }
  });

  ipcMain.handle('poker:isWindowMaximized', (event) => {
    if (!isPokerGameSender(event)) return false;
    return pokerGameWindow?.isMaximized() ?? false;
  });

  ipcMain.on('poker:pumpState', (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== mainWindow.webContents) return;
    if (!pokerGameWindow || pokerGameWindow.isDestroyed()) return;
    try {
      pokerGameWindow.webContents.send('poker:state', payload);
    } catch {
      /* ignore */
    }
  });

  ipcMain.on('poker:fromChild', (event, payload) => {
    if (!pokerGameWindow || pokerGameWindow.isDestroyed()) return;
    if (event.sender !== pokerGameWindow.webContents) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('poker:fromChild', payload);
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle('uno:openGameWindow', () => {
    try {
      createUnoGameWindow();
      return { ok: true };
    } catch (e) {
      console.error('uno:openGameWindow error:', e);
      return { ok: false, error: e?.message || 'open_failed' };
    }
  });

  ipcMain.handle('uno:closeGameWindow', () => {
    try {
      if (unoGameWindow && !unoGameWindow.isDestroyed()) {
        unoGameWindow.close();
      }
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('uno:minimizeWindow', (event) => {
    if (!isUnoGameSender(event)) return { ok: false };
    try {
      unoGameWindow?.minimize();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('uno:maximizeWindow', (event) => {
    if (!isUnoGameSender(event)) return { ok: false };
    try {
      if (unoGameWindow?.isMaximized()) unoGameWindow.unmaximize();
      else unoGameWindow?.maximize();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('uno:isWindowMaximized', (event) => {
    if (!isUnoGameSender(event)) return false;
    return unoGameWindow?.isMaximized() ?? false;
  });

  ipcMain.on('uno:pumpState', (event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (event.sender !== mainWindow.webContents) return;
    if (!unoGameWindow || unoGameWindow.isDestroyed()) return;
    try {
      unoGameWindow.webContents.send('uno:state', payload);
    } catch {
      /* ignore */
    }
  });

  ipcMain.on('uno:fromChild', (event, payload) => {
    if (!unoGameWindow || unoGameWindow.isDestroyed()) return;
    if (event.sender !== unoGameWindow.webContents) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('uno:fromChild', payload);
    } catch {
      /* ignore */
    }
  });

  ipcMain.handle('store:get', (_, key, defaultVal) => store.get(key, defaultVal));
  ipcMain.handle('store:set', (_, key, value) => {
    store.set(key, value);
    if (key === 'settings' || key.startsWith('settings.')) {
      handleSettingsMutation();
    }
    return true;
  });
  ipcMain.handle('store:delete', (_, key) => {
    store.delete(key);
    if (key === 'settings' || key.startsWith('settings.')) {
      handleSettingsMutation();
    }
    return true;
  });

  ipcMain.handle('messages:getMeta', () => getChatMessageMeta());
  ipcMain.handle('messages:getBatch', (_, peerId, options = {}) => getChatMessageBatch(peerId, options));
  ipcMain.handle('messages:append', (_, peerId, message) => {
    const result = appendStoredChatMessage(peerId, message);
    const meta = getChatMessageMeta()[peerId] || { count: 0, lastMessage: null };
    return { ...meta, appended: result.appended };
  });
  ipcMain.handle('messages:patch', (_, peerId, messageId, patch) =>
    patchStoredChatMessage(peerId, messageId, patch)
  );
  ipcMain.handle('messages:deleteMessage', (_, peerId, messageId) =>
    deleteStoredChatMessage(peerId, messageId)
  );
  ipcMain.handle('messages:deleteChat', (_, peerId) => {
    store.delete(`messages.${peerId}`);
    return true;
  });

  ipcMain.handle('library:listMedia', () => listLibraryMedia());
  ipcMain.handle('library:getMediaData', (_, peerId, messageId) => getLibraryMediaData(peerId, messageId));

  ipcMain.handle('peer:getInfo', () => peerServer?.getInfo() ?? { id: '', name: '', port: 0, ports: [], addresses: [], endpoints: [], peers: [], hostedFiles: [] });
  ipcMain.handle('peer:connect', (_, address) => {
    if (!peerServer) throw new Error('Peer server not ready');
    return peerServer.connectTo(address);
  });
  ipcMain.handle('peer:disconnect', (_, peerId) => {
    if (!peerServer) throw new Error('Peer server not ready');
    return peerServer.disconnectPeer(peerId);
  });
  ipcMain.handle('peer:send', (_, peerId, data) => {
    if (!peerServer) return false;
    return peerServer.sendTo(peerId, data);
  });
  ipcMain.handle('peer:broadcast', (_, data) => {
    if (!peerServer) return [];
    return peerServer.broadcast(data);
  });
  ipcMain.handle('peer:getPeers', () => peerServer?.getPeers() ?? []);
  ipcMain.handle('peer:refreshDiscovery', () => {
    peerServer?.refreshDiscovery();
  });

  ipcMain.handle('file:host', (_, fileMeta) => {
    if (!peerServer) throw new Error('Peer server not ready');
    return peerServer.hostFile(fileMeta);
  });
  ipcMain.handle('file:getHosted', () => peerServer?.getHostedFiles() ?? []);
  ipcMain.handle('file:request', (_, peerId, fileId) => {
    if (!peerServer) throw new Error('Peer server not ready');
    return peerServer.requestFile(peerId, fileId);
  });
  try {
    ipcMain.removeHandler('file:saveAs');
  } catch {
    /* ignore if not registered */
  }
  ipcMain.handle('file:saveAs', async (_, { defaultFilename, base64 } = {}) => {
    if (
      typeof base64 !== 'string'
      || !base64.length
      || base64.length > MAX_SAVE_BASE64_CHARS
      || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
    ) {
      return { ok: false, error: 'invalid_payload' };
    }
    const requestedName = typeof defaultFilename === 'string' ? defaultFilename.trim() : '';
    const name = path.basename(requestedName || 'download').replace(/[\r\n]/g, '_').slice(0, 180) || 'download';
    const { canceled, filePath } = await dialog.showSaveDialog(windowFromIpcEvent(_) || mainWindow, {
      defaultPath: name,
      filters: [{ name: 'All Files', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      await fs.writeFile(filePath, Buffer.from(base64, 'base64'));
      return { ok: true, filePath };
    } catch (e) {
      return { ok: false, error: e?.message || 'write_failed' };
    }
  });

  ipcMain.handle('notify:show', (_, payload = {}) => {
    if (store && store.get('settings.windowsNotifications', true) === false) {
      return false;
    }
    return showWindowsNotification(payload.title || 'BlueTalk', payload.body || '', {
      allowInForeground: payload.allowInForeground === true,
    });
  });

  ipcMain.handle('network:testPorts', async () => runPortDiagnostics());
  ipcMain.handle('network:doctor', async () => runNetworkDoctor());
  ipcMain.handle('network:getApiAccess', () => ({
    host: '127.0.0.1',
    port: lastApiServerPort || store?.get('settings.apiPort', 19876) || 19876,
    token: apiServer?.token || '',
  }));

  ipcMain.handle('app:getConfigLogPath', () => ({
    ok: Boolean(store),
    path: store ? path.join(app.getPath('userData'), 'bluetalk-config.json') : null,
  }));

  ipcMain.handle('app:readConfigTail', async (_, maxBytes) => {
    if (!store) return { ok: false, error: 'not_ready' };
    const configPath = path.join(app.getPath('userData'), 'bluetalk-config.json');
    return readTailOfFile(configPath, typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : 120_000);
  });

  ipcMain.handle('peer:normalizeAddress', (_, raw) => {
    try {
      return { ok: true, normalized: normalizeConnectAddress(raw) };
    } catch (e) {
      return { ok: false, error: e?.message || 'invalid_address' };
    }
  });

  ipcMain.handle('peer:reconnectContacts', () => {
    peerServer?.reconnectContactsFromStore();
    return { ok: true };
  });

  ipcMain.handle('peer:resetAllConnections', () => {
    peerServer?.resetAllConnectionsAndReconnect();
    return { ok: true };
  });

  ipcMain.handle('updater:getState', () => patchUpdateState());
  ipcMain.handle('updater:check', async () => checkForAppUpdates('manual'));
  ipcMain.handle('updater:download', async () => downloadAppUpdate());
  ipcMain.handle('updater:install', () => installDownloadedUpdate());

  ipcMain.handle('app:clearCache', async () => {
    try {
      await clearRendererSessionCaches();
      return { ok: true };
    } catch (e) {
      console.error('app:clearCache error:', e);
      return { ok: false, error: e?.message || 'clear_cache_failed' };
    }
  });

  ipcMain.handle('app:clearMessages', () => clearStoredChatMessagesOnly());

  ipcMain.handle('app:wipeAllData', () => wipeAllLocalAppData());

  ipcMain.handle('plugins:list', () => pluginHost?.listPlugins() || []);
  ipcMain.handle('plugins:setEnabled', async (_, id, enabled) => {
    if (!pluginHost) return false;
    return pluginHost.setPluginEnabled(id, Boolean(enabled));
  });
  ipcMain.handle('plugins:rescan', async () => {
    if (!pluginHost) return [];
    return pluginHost.scan();
  });
  ipcMain.handle('plugins:openDir', async () => {
    if (!pluginHost) return { ok: false, error: 'not_ready' };
    const dir = pluginHost.getPluginsDir();
    try {
      const { shell } = require('electron');
      await shell.openPath(dir);
      return { ok: true, path: dir };
    } catch (e) {
      return { ok: false, error: e?.message || 'open_failed' };
    }
  });
  ipcMain.handle('plugins:install', async (_, payload) => {
    if (!pluginHost) return { ok: false, error: 'not_ready' };
    try {
      let result;
      if (payload?.dir) {
        result = await pluginHost.installFromDirectory(payload.dir, { initialEnabled: false });
      } else if (payload?.id && payload?.files) {
        result = await pluginHost.installFromPayload(payload, { initialEnabled: false });
      } else {
        return { ok: false, error: 'invalid_payload' };
      }
      return { ok: true, plugin: result };
    } catch (e) {
      return { ok: false, error: e?.message || 'install_failed' };
    }
  });
  ipcMain.handle('plugins:installFromDialog', async () => {
    if (!pluginHost) return { ok: false, error: 'not_ready' };
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Select a plugin folder',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths?.[0]) return { ok: false, canceled: true };
    try {
      const result = await pluginHost.installFromDirectory(filePaths[0], { initialEnabled: false });
      return { ok: true, plugin: result };
    } catch (e) {
      return { ok: false, error: e?.message || 'install_failed' };
    }
  });
  ipcMain.handle('plugins:uninstall', async (_, id) => {
    if (!pluginHost) return false;
    const result = await pluginHost.uninstall(id);
    try {
      const bundledDir = path.join(__dirname, '..', '..', 'assets', 'bundled-plugins', id);
      await fs.access(bundledDir);
      const userRemoved = store?.get('plugins.userRemoved', {}) || {};
      userRemoved[id] = true;
      store?.set('plugins.userRemoved', userRemoved);
    } catch {
      /* not a bundled plugin — ignore */
    }
    return result;
  });
  ipcMain.handle('plugins:reseedBundled', async () => {
    if (!pluginHost) return false;
    if (store) store.set('plugins.userRemoved', {});
    await seedBundledPlugins(pluginHost);
    await pluginHost.scan();
    return true;
  });
  ipcMain.handle('plugins:invokeCommand', async (_, id, commandId, args) => {
    if (!pluginHost) return { ok: false, error: 'not_ready' };
    return pluginHost.invokeCommand(id, commandId, args);
  });
  ipcMain.handle('plugins:sendToMain', async (_, id, payload) => {
    if (!pluginHost) return false;
    await pluginHost.onUiMessage(id, payload);
    return true;
  });

  const forwardEvents = [
    'peer:connected',
    'peer:disconnected',
    'peer:message',
    'peer:file-offered',
    'peer:file-received',
    'peer:discovered',
  ];

  for (const event of forwardEvents) {
    peerServer.on(event, (data) => {
      if (event === 'peer:message' && data?.from !== 'self' && data?.kind !== 'profile') {
        if (
          data.kind !== 'delivery-receipt'
          && data.kind !== 'read-receipt'
          && data.kind !== 'messaging-blocked'
          && data.kind !== 'contact-blocked'
          && data.kind !== 'chat-deleted'
          && data.kind !== 'e2ee-key-handshake'
          && data.kind !== 'poker'
          && data.kind !== 'uno'
        ) {
          if (!isContactBlockedInStore(data.from) && !isContactNotificationMutedInStore(data.from)) {
            queueIncomingChatNotification(data);
          }
        }
      }
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(event, data);
        }
      } catch (e) {
        console.warn(`[Main] Failed to forward event ${event}:`, e.message);
      }
    });
  }
}

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    store = new Store({ configName: 'bluetalk-config' });
    peerServer = new PeerServer(store);
    apiServer = new APIServer(peerServer, store);

    configureSessionSecurity();
    createWindow();
    createTray();
    setupIPC();
    setupAutoUpdater();
    applyLaunchAtLoginSetting();

    peerServer.start().then(() => {
      // Wait for discovery to be ready before reconnecting
      setTimeout(() => {
        // Proactively reconnect to all known contacts on startup
        const contacts = store.get('contacts', []);
        if (Array.isArray(contacts)) {
          for (const contact of contacts) {
            if (!contact?.id || !contact.address) continue;
            // Skip if already connected (e.g. via discovery)
            if (peerServer._getActivePeer(contact.id)) continue;
            peerServer.connectTo({ id: contact.id, address: contact.address }).catch((err) => {
              console.warn(`[Startup] Reconnect to ${contact.address} failed:`, err.message);
              peerServer._scheduleReconnect(contact.id);
            });
          }
        }
      }, 1000);
    }).catch((err) => {
      console.error('[Startup] Peer server start failed:', err);
    });
    const initialApiPort = store.get('settings.apiPort', 19876);
    apiServer.start(initialApiPort);
    lastApiServerPort = initialApiPort;

    pluginHost = new PluginHost({
      peerServer,
      store,
      mainWindowRef: () => mainWindow,
      isAppInForegroundRef: isAppInForeground,
    });
    (async () => {
      try {
        await seedBundledPlugins(pluginHost);
      } catch (e) {
        console.error('[PluginHost] seed bundled plugins:', e);
      }
      await pluginHost.init().catch((e) => console.error('[PluginHost] init failed:', e));
    })();
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
    updateCheckTimer = null;
  }
  try {
    if (pokerGameWindow && !pokerGameWindow.isDestroyed()) {
      pokerGameWindow.destroy();
      pokerGameWindow = null;
    }
    if (unoGameWindow && !unoGameWindow.isDestroyed()) {
      unoGameWindow.destroy();
      unoGameWindow = null;
    }
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;

  const keepInTray = store?.get('settings.minimizeToTray', true) && !isQuitting;
  if (keepInTray) return;

  peerServer?.stop();
  apiServer?.stop();
  pluginHost?.stop().catch(() => {});
  app.quit();
});

app.on('activate', () => {
  showMainWindow();
});
