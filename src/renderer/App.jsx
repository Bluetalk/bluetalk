import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, startTransition, createContext, useContext, lazy, Suspense } from 'react';
import ReactDOM from 'react-dom';
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import { MessageCircle, Settings as SettingsIcon, UserPlus, Minus, Maximize2, SquareStack, X, Blocks, Plug, FolderOpen, FileText, Palette, Sparkles, Spade, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import ChatsPage from './pages/Chats';
import RuntimeUnavailablePage from './pages/RuntimeUnavailable';
import NotificationCenter from './components/NotificationCenter';
import ProfileMenu from './components/ProfileMenu';
import { ToastProvider, useToast } from './components/ToastProvider';
import PluginScreenHost from './plugins/PluginScreenHost';
import { pluginRuntime } from './plugins/pluginRuntime';
import ErrorBoundary from './components/ErrorBoundary';
import VersionWelcomeModal from './components/VersionWelcomeModal';
import UsernameOnboardingModal from './components/UsernameOnboardingModal';
import AgentAskUserModal from './components/AgentAskUserModal';
import { APP_VERSION } from './appVersion';
import { getReleaseNotesForVersion } from './releaseNotes';
import {
  generateEcdhKeyPair,
  exportSpkiPublic,
  importPeerPublicFromSpki,
  deriveSharedAesKey,
  encryptChatPayload,
  decryptChatPayload,
  exportAesKeyToB64,
  importAesKeyFromRawB64,
  computeE2eeKeyId,
} from './chatCrypto';
import VerticalResizeHandle from './components/VerticalResizeHandle';
import { base64ByteLength, validateStickerData } from './stickers/stickerStore';
import { isAiChatPeerId } from './aiChatConstants';
import { normalizeAttachmentFileType } from './utils/attachmentImage';
import { toolEventsFromSegments } from './utils/agentSegments.js';
import { isContactNotificationMuted } from './contactNotificationMute';
import { buildMessageNotificationPreview } from './utils/messageNotificationPreview';
import {
  GAME_PRESENCE_CLEAR_KIND,
  GAME_PRESENCE_KIND,
  canJoinGameViaPresence,
  gameInviteKey,
  isPresenceStale,
} from '../shared/game-presence.js';
import {
  USER_PRESENCE_KIND,
  buildUserPresencePayload,
} from '../shared/user-presence.js';
import { REALTIME_KIND } from '../shared/plugin-realtime.mjs';
import PresenceStatusToggle from './components/PresenceStatusToggle';
import groupChat from '../shared/group-chat.js';

const {
  GROUP_EVENT_KIND,
  GROUP_MESSAGE_KIND,
  GROUP_PROTOCOL_VERSION,
  GROUP_RECEIPT_KIND,
  applyGroupEvent,
  buildTargetedGroupRoute,
  createGroup: createGroupModel,
  createGroupAcceptEvent,
  createGroupInviteEvent,
  createGroupLeaveEvent,
  createGroupUpdateEvent,
  deriveGroupDeliveryStatus,
  getGroupMember,
  groupPeerIds,
  isActiveGroupMember,
  isGroupAdmin,
  isGroupChatId,
  normalizeGroup,
  rememberGroupEventId,
  summarizeGroupDelivery,
  validateIncomingGroupMessage,
} = groupChat;

const SettingsPage = lazy(() => import('./pages/Settings'));
const AccountSettingsPage = lazy(() => import('./pages/settings/AccountSettings'));
const ConnectionSettingsPage = lazy(() => import('./pages/settings/ConnectionSettings'));
const UpdatesSettingsPage = lazy(() => import('./pages/settings/UpdatesSettings'));
const ApplicationSettingsPage = lazy(() => import('./pages/settings/ApplicationSettings'));
const StickersSettingsPage = lazy(() => import('./pages/settings/StickersSettings'));
const AiSettingsPage = lazy(() => import('./pages/settings/AiSettings'));
const NewConnectionsPage = lazy(() => import('./pages/NewConnections'));
const CloudSyncPage = lazy(() => import('./pages/CloudSync'));
const LibraryPage = lazy(() => import('./pages/Library'));
const GamesPage = lazy(() => import('./pages/Games'));
const DocumentsLauncherPage = lazy(() => import('./pages/DocumentsLauncher'));
const NotFoundPage = lazy(() => import('./pages/NotFound'));
const PluginsPage = lazy(() => import('./pages/Plugins'));
const PluginTabView = lazy(() => import('./plugins/PluginTabView'));
const DocsPage = lazy(() => import('./docs/DocsPage'));

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
const CHAT_MESSAGE_BATCH_SIZE = 24;
const MAX_CHAT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_TEXT_CHARS = 128 * 1024;

const DEFAULT_APP_SETTINGS = {
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

function newChatMessageId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `bt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

let e2eePersistQueue = Promise.resolve();

function persistE2eeSessionsMap(sessionsRef) {
  if (!window.bluetalk) return Promise.resolve();
  const snapshot = Object.entries(sessionsRef.current || {});
  e2eePersistQueue = e2eePersistQueue.catch(() => {}).then(async () => {
    const out = {};
    for (const [peerId, row] of snapshot) {
      if (!row?.aesKey) continue;
      if (row.peerPublicSpkiB64) {
        out[peerId] = {
          peerPublicSpkiB64: row.peerPublicSpkiB64,
          keyId: row.keyId || '',
          pendingPeerPublicSpkiB64: row.pendingPeerPublicSpkiB64 || '',
          keyChanged: row.keyChanged === true,
        };
      } else {
        // Legacy migration: keep the old raw key only until the next completed key exchange.
        out[peerId] = { aesKeyB64: await exportAesKeyToB64(row.aesKey) };
      }
    }
    await window.bluetalk.store.set('e2eeSessions', out);
  });
  return e2eePersistQueue;
}

async function waitForE2eeIdentity(publicKeyRef, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!publicKeyRef.current && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return publicKeyRef.current || '';
}

async function waitForE2eeSession(sessionsRef, readyPeersRef, peerId, expectedKeyId = '', timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessionsRef.current[peerId];
    const keyMatches = !expectedKeyId || session?.keyId === expectedKeyId;
    if (session?.aesKey && keyMatches && readyPeersRef.current.has(peerId) && session.keyChanged !== true) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

/** Ausgehende E2EE, sofern der Kontakt nicht explizit `e2eeEnabled: false` hat. */
function contactWantsOutgoingE2ee(contactsRef, peerId) {
  if (!peerId) return true;
  const c = contactsRef.current.find((x) => x?.id === peerId);
  if (c?.e2eeEnabled === false) return false;
  return true;
}

function PluginRuntimeToastBridge() {
  const { toast } = useToast();
  useEffect(() => {
    const current = pluginRuntime._host || {};
    pluginRuntime.setHost({ ...current, toast });
    return () => {
      const latest = pluginRuntime._host || {};
      if (latest.toast === toast) {
        pluginRuntime.setHost({ ...latest, toast: null });
      }
    };
  }, [toast]);
  return null;
}

/** Ref wird gesetzt, damit `peer:message`-Handler in `App` Toasts anzeigen kann (liegt außerhalb von `ToastProvider`). */
function InboundToastBridge({ toastRef }) {
  const { toast } = useToast();
  useEffect(() => {
    toastRef.current = toast;
    return () => {
      toastRef.current = null;
    };
  }, [toast, toastRef]);
  return null;
}

function TitleBar() {
  const { peerCount, settings, updateSettings } = useApp();
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const [isMaximized, setIsMaximized] = useState(false);

  const toggleSidebarCollapse = useCallback(() => {
    updateSettings({ uiCollapse: { sidebar: !sidebarCollapsed } });
  }, [sidebarCollapsed, updateSettings]);

  useEffect(() => {
    const api = window.bluetalk?.window;
    if (!api?.getMaximized || !api?.onMaximizedChange) return undefined;
    let cancelled = false;
    api.getMaximized().then((m) => {
      if (!cancelled) setIsMaximized(m);
    });
    const unsub = api.onMaximizedChange((m) => {
      if (!cancelled) setIsMaximized(m);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <button
          type="button"
          className="tb-btn titlebar-sidebar-toggle"
          onClick={toggleSidebarCollapse}
          title={sidebarCollapsed ? 'Seitenleiste einblenden' : 'Seitenleiste einklappen'}
          aria-label={sidebarCollapsed ? 'Seitenleiste einblenden' : 'Seitenleiste einklappen'}
          aria-expanded={!sidebarCollapsed}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={15} strokeWidth={2} aria-hidden />
          ) : (
            <PanelLeftClose size={15} strokeWidth={2} aria-hidden />
          )}
        </button>
        <div className="titlebar-brand">
          <span>BlueTalk</span>
        </div>
      </div>
      <div className="titlebar-status">
        <span className={peerCount > 0 ? 'online-dot' : 'offline-dot'} />
        <span>{peerCount} peer{peerCount !== 1 ? 's' : ''}</span>
      </div>
      <div className="titlebar-controls">
        <button type="button" onClick={() => window.bluetalk?.window.minimize()} className="tb-btn" title="Minimize" aria-label="Minimize">
          <Minus size={14} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => window.bluetalk?.window.maximize()}
          className="tb-btn"
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <SquareStack size={14} strokeWidth={2} aria-hidden /> : <Maximize2 size={14} strokeWidth={2} aria-hidden />}
        </button>
        <button type="button" onClick={() => window.bluetalk?.window.close()} className="tb-btn tb-close" title="Close" aria-label="Close">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function resolveLucideIcon(name) {
  if (!name || typeof name !== 'string') return Plug;
  return { Plug, Palette, Sparkles, Spade, Blocks, MessageCircle, FolderOpen }[name] || Plug;
}

const SIDEBAR_WIDTH_DEFAULT = 56;
const SIDEBAR_WIDTH_MIN = 56;
const SIDEBAR_WIDTH_MAX = 280;

function Sidebar() {
  const { settings, updateSettings } = useApp();
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const storedSidebar = settings.uiResize?.sidebar;
  const sidebarCommitted =
    typeof storedSidebar === 'number'
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, storedSidebar))
      : SIDEBAR_WIDTH_DEFAULT;
  const [sidebarPreview, setSidebarPreview] = useState(null);
  const sidebarDragRef = useRef(sidebarCommitted);

  useEffect(() => {
    sidebarDragRef.current = sidebarCommitted;
  }, [sidebarCommitted]);

  const [pluginTabs, setPluginTabs] = useState(() => pluginRuntime.listTabs());

  useEffect(() => {
    const off = pluginRuntime.onTabsChanged((tabs) => setPluginTabs(tabs));
    setPluginTabs(pluginRuntime.listTabs());
    return off;
  }, []);

  const sidebarDisplayWidth = sidebarPreview ?? sidebarCommitted;

  const onSidebarResizeBegin = useCallback(() => {
    sidebarDragRef.current = sidebarPreview ?? sidebarCommitted;
  }, [sidebarPreview, sidebarCommitted]);

  const onSidebarResizeDelta = useCallback((dx) => {
    sidebarDragRef.current = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, sidebarDragRef.current + dx)
    );
    setSidebarPreview(sidebarDragRef.current);
  }, []);

  const commitSidebarWidth = useCallback(() => {
    const w = sidebarDragRef.current;
    if (w !== sidebarCommitted) {
      updateSettings({ uiResize: { sidebar: w } });
    }
    setSidebarPreview(null);
  }, [sidebarCommitted, updateSettings]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarPreview(null);
    updateSettings({ uiResize: { sidebar: SIDEBAR_WIDTH_DEFAULT } });
  }, [updateSettings]);

  const links = [
    { to: '/', label: 'Chats', icon: MessageCircle },
    { to: '/new', label: 'New', icon: UserPlus },
    { to: '/library', label: 'Bibliothek', icon: FolderOpen },
    { to: '/documents', label: 'Dokumente', icon: FileText },
    { to: '/games', label: 'Spiele', icon: Sparkles },
    { to: '/plugins', label: 'Erweiterungen', icon: Blocks },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];

  if (sidebarCollapsed) {
    return null;
  }

  return (
    <>
      <nav
        className="sidebar sidebar--resizable"
        style={{ width: sidebarDisplayWidth }}
      >
        <div className="sidebar-nav">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              title={label}
            >
              <Icon size={15} strokeWidth={2} />
              <span>{label}</span>
            </NavLink>
          ))}
          {pluginTabs.length > 0 ? <div className="sidebar-nav-divider" role="separator" aria-hidden="true" /> : null}
          {pluginTabs.map((tab) => {
            const Icon = resolveLucideIcon(tab.icon);
            return (
              <NavLink
                key={tab.tabId}
                to={tab.path}
                className={({ isActive }) => `sidebar-link sidebar-link-plugin ${isActive ? 'active' : ''}`}
                title={tab.label}
              >
                <Icon size={15} strokeWidth={2} />
                <span className="sidebar-link-label">
                  <span>{tab.label}</span>
                  {tab.tag ? <span className="plugin-tag-badge">{tab.tag}</span> : null}
                </span>
              </NavLink>
            );
          })}
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-notif">
            <NotificationCenter />
          </div>
          <div className="sidebar-presence">
            <PresenceStatusToggle />
          </div>
          <div className="sidebar-profile">
            <ProfileMenu variant="sidebar" />
          </div>
        </div>
      </nav>
      <VerticalResizeHandle
        onBegin={onSidebarResizeBegin}
        onDelta={onSidebarResizeDelta}
        onCommit={commitSidebarWidth}
        onDoubleClick={resetSidebarWidth}
      />
    </>
  );
}

export default function App() {
  const [peers, setPeers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [groups, setGroups] = useState([]);
  const [ownPeerId, setOwnPeerId] = useState('');
  const [chatMeta, setChatMeta] = useState({});
  const [loadedChats, setLoadedChats] = useState({});
  const [messages, setMessages] = useState({});
  const [aiChatProgress, setAiChatProgress] = useState(null);
  const [aiChatPendingPeerId, setAiChatPendingPeerId] = useState(null);
  const [agentAskUser, setAgentAskUser] = useState(null);
  const [peerGamePresence, setPeerGamePresence] = useState({});
  const [peerUserPresence, setPeerUserPresence] = useState({});
  const [gameInviteKeys, setGameInviteKeys] = useState(() => new Set());
  const [theme, setTheme] = useState('dark');
  const [settings, setSettings] = useState({ ...DEFAULT_APP_SETTINGS });
  const messageCacheRef = useRef({});
  const deliveryTimersRef = useRef(new Map());
  const activeAiChatRequestRef = useRef(null);
  const settingsRef = useRef(settings);
  const contactsRef = useRef([]);
  const groupsRef = useRef([]);
  const ownPeerIdRef = useRef('');
  const groupOutboxRef = useRef([]);
  const groupEventIdsRef = useRef([]);
  const sendGroupPacketRef = useRef(null);
  const flushGroupOutboxRef = useRef(null);
  const ownEcdhPrivateRef = useRef(null);
  const ownEcdhPublicSpkiRef = useRef('');
  const e2eeSessionsRef = useRef({});
  const e2eeReadyPeersRef = useRef(new Set());
  const e2eeHandshakeSentRef = useRef(new Set());
  const e2eeHandshakePromisesRef = useRef(new Map());
  const sendMessageRef = useRef(null);
  const [peerReadReceipts, setPeerReadReceipts] = useState({});
  /** Höchster Zeitstempel einer Peer-Nachricht, die der Nutzer im Chat „gesehen“ hat (lokale UI, nicht E2EE-Read-Receipt). */
  const [chatLastViewedPeerTs, setChatLastViewedPeerTs] = useState({});
  const [loadError, setLoadError] = useState('');
  const [showVersionWelcome, setShowVersionWelcome] = useState(false);
  const [e2eeBootNonce, setE2eeBootNonce] = useState(0);
  const [showUsernameOnboarding, setShowUsernameOnboarding] = useState(false);
  const [usernameOnboardingGateReady, setUsernameOnboardingGateReady] = useState(false);
  const inboundToastRef = useRef(null);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  const sendE2eeHandshake = useCallback(async (peerId, options = {}) => {
    if (!window.bluetalk?.peer || !peerId || !ownEcdhPublicSpkiRef.current) return false;
    if (!options.force && e2eeHandshakeSentRef.current.has(peerId)) return true;
    const pending = e2eeHandshakePromisesRef.current.get(peerId);
    if (pending) {
      if (!options.force) return pending;
      await pending;
      return sendE2eeHandshake(peerId, options);
    }

    e2eeHandshakeSentRef.current.add(peerId);
    const promise = (async () => {
      try {
        const sent = await window.bluetalk.peer.send(peerId, {
          kind: 'e2ee-key-handshake',
          publicSpkiB64: ownEcdhPublicSpkiRef.current,
          e2eeVersions: [1, 2],
          requestReply: options.requestReply !== false,
          sender: settingsRef.current.displayName,
        });
        if (!sent) e2eeHandshakeSentRef.current.delete(peerId);
        return Boolean(sent);
      } catch {
        e2eeHandshakeSentRef.current.delete(peerId);
        return false;
      } finally {
        e2eeHandshakePromisesRef.current.delete(peerId);
      }
    })();
    e2eeHandshakePromisesRef.current.set(peerId, promise);
    return promise;
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.store) return undefined;
    let cancelled = false;

    (async () => {
      try {
        let identity = await window.bluetalk.store.get('e2eeIdentity', null);
        if (!identity?.privateJwk || !identity?.publicSpkiB64) {
          const pair = await generateEcdhKeyPair();
          const jwkPrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
          const publicSpkiB64 = await exportSpkiPublic(pair.publicKey);
          identity = { privateJwk: jwkPrivate, publicSpkiB64 };
          await window.bluetalk.store.set('e2eeIdentity', identity);
        }
        const storedContactsForE2ee = await window.bluetalk.store.get('contacts', []);
        if (cancelled) return;
        if (Array.isArray(storedContactsForE2ee)) {
          contactsRef.current = storedContactsForE2ee;
        }
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          identity.privateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveBits']
        );
        ownEcdhPrivateRef.current = privateKey;
        ownEcdhPublicSpkiRef.current = identity.publicSpkiB64;

        const storedSessions = await window.bluetalk.store.get('e2eeSessions', {});
        const next = {};
        if (storedSessions && typeof storedSessions === 'object') {
          for (const [pid, row] of Object.entries(storedSessions)) {
            if (row?.peerPublicSpkiB64) {
              try {
                const peerPublic = await importPeerPublicFromSpki(row.peerPublicSpkiB64);
                const aesKey = await deriveSharedAesKey(privateKey, peerPublic);
                const keyId = row.keyId || await computeE2eeKeyId(identity.publicSpkiB64, row.peerPublicSpkiB64);
                next[pid] = {
                  aesKey,
                  keyId,
                  peerPublicSpkiB64: row.peerPublicSpkiB64,
                  pendingPeerPublicSpkiB64: row.pendingPeerPublicSpkiB64 || '',
                  keyChanged: row.keyChanged === true,
                };
              } catch {
                /* skip corrupt row */
              }
            } else if (row?.aesKeyB64) {
              try {
                next[pid] = { aesKey: await importAesKeyFromRawB64(row.aesKeyB64) };
              } catch {
                /* skip corrupt row */
              }
            }
          }
        }
        if (!cancelled) {
          // A live handshake may finish while sessions are loading; never overwrite that fresher key.
          e2eeSessionsRef.current = { ...next, ...e2eeSessionsRef.current };
        }

        if (!cancelled && window.bluetalk?.peer?.getPeers && ownEcdhPublicSpkiRef.current) {
          try {
            const peerList = await window.bluetalk.peer.getPeers();
            for (const p of peerList || []) {
              if (!p?.id) continue;
              if (!contactWantsOutgoingE2ee(contactsRef, p.id)) continue;
              if (contactsRef.current.some((c) => c?.id === p.id && c.blocked === true)) continue;
              void sendE2eeHandshake(p.id);
            }
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        console.error('E2EE bootstrap failed:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [e2eeBootNonce, sendE2eeHandshake]);

  useEffect(() => () => {
    for (const t of deliveryTimersRef.current.values()) {
      clearTimeout(t);
    }
    deliveryTimersRef.current.clear();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setPeerGamePresence((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [peerId, presence] of Object.entries(prev)) {
          if (isPresenceStale(presence)) {
            delete next[peerId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const applyContactPatch = useCallback((prev, patch) => {
    if (!patch?.id) return prev;
    const idx = prev.findIndex((c) => c.id === patch.id);
    const base = idx >= 0 ? prev[idx] : { id: patch.id, addedAt: Date.now() };
    const merged = { ...base, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedUntil') && patch.notifyMutedUntil === undefined) {
      delete merged.notifyMutedUntil;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedManual') && patch.notifyMutedManual === false) {
      delete merged.notifyMutedManual;
    }
    return idx >= 0
      ? prev.map((contact, i) => (i === idx ? merged : contact))
      : [...prev, merged];
  }, []);

  const upsertContact = useCallback((patch) => {
    if (!patch?.id) return;
    setContacts((prev) => {
      const updated = applyContactPatch(prev, patch);
      if (window.bluetalk) void window.bluetalk.store.set('contacts', updated);
      return updated;
    });
  }, [applyContactPatch]);

  const replaceGroup = useCallback((nextGroup) => {
    let normalized;
    try {
      normalized = normalizeGroup(nextGroup);
    } catch {
      return false;
    }
    const current = groupsRef.current;
    const idx = current.findIndex((group) => group.id === normalized.id);
    const updated = idx >= 0
      ? current.map((group, index) => (index === idx ? normalized : group))
      : [...current, normalized];
    groupsRef.current = updated;
    setGroups(updated);
    void window.bluetalk?.store?.set?.('groups', updated);
    return true;
  }, []);

  const removeGroup = useCallback((groupId) => {
    if (!groupId) return false;
    const updated = groupsRef.current.filter((group) => group.id !== groupId);
    if (updated.length === groupsRef.current.length) return false;
    groupsRef.current = updated;
    setGroups(updated);
    void window.bluetalk?.store?.set?.('groups', updated);
    return true;
  }, []);

  const persistGroupOutbox = useCallback((next) => {
    const bounded = (Array.isArray(next) ? next : []).slice(-1000);
    groupOutboxRef.current = bounded;
    void window.bluetalk?.store?.set?.('groupOutbox', bounded);
    return bounded;
  }, []);

  const rememberIncomingGroupEvent = useCallback((eventId) => {
    const remembered = rememberGroupEventId(groupEventIdsRef.current, eventId);
    groupEventIdsRef.current = remembered.eventIds;
    if (!remembered.duplicate) {
      void window.bluetalk?.store?.set?.('groupEventIds', remembered.eventIds);
    }
    return remembered.duplicate;
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    messageCacheRef.current = messages;
  }, [messages]);

  const loadChatMessages = useCallback(async (peerId, options = {}) => {
    if (!window.bluetalk || !peerId) {
      return { messages: [], total: 0, hasMore: false };
    }

    const reset = Boolean(options.reset);
    const currentMessages = reset ? [] : (messageCacheRef.current[peerId] || []);
    const batch = await window.bluetalk.messages.getBatch(peerId, {
      skip: reset ? 0 : currentMessages.length,
      limit: options.limit || CHAT_MESSAGE_BATCH_SIZE,
    });

    setMessages((prev) => ({
      ...prev,
      [peerId]: reset ? (batch.messages || []) : [...(batch.messages || []), ...(prev[peerId] || [])],
    }));
    setLoadedChats((prev) => ({ ...prev, [peerId]: true }));

    return batch;
  }, []);

  const applyMessagePatch = useCallback(async (peerId, messageId, patch) => {
    if (!window.bluetalk || !peerId || !messageId || !patch) return;
    await window.bluetalk.messages.patch(peerId, messageId, patch);
    setMessages((prev) => {
      const list = prev[peerId] || [];
      const idx = list.findIndex((m) => m.messageId === messageId);
      if (idx < 0) return prev;
      const next = [...list];
      next[idx] = { ...next[idx], ...patch };
      return { ...prev, [peerId]: next };
    });
  }, []);

  useLayoutEffect(() => {
    if (!window.bluetalk) return undefined;
    const unsubs = [];

    unsubs.push(
      window.bluetalk.on('peer:connected', (peer) => {
        e2eeReadyPeersRef.current.delete(peer.id);
        e2eeHandshakeSentRef.current.delete(peer.id);
        setPeers((prev) => {
          const idx = prev.findIndex((p) => p.id === peer.id);
          if (idx >= 0) {
            return prev.map((p, i) => (i === idx ? { ...p, ...peer } : p));
          }
          return [...prev, peer];
        });

        upsertContact({
          id: peer.id,
          name: peer.name || peer.id,
          address: peer.address && peer.port ? `${peer.address}:${peer.port}` : undefined,
          bio: peer.bio,
          profilePicture: peer.profilePicture,
        });

        const blocked = contactsRef.current.some((c) => c?.id === peer.id && c.blocked === true);
        if (!blocked) {
          void window.bluetalk.peer.send(peer.id, buildUserPresencePayload(settingsRef.current));
        }
        if (!blocked && ownEcdhPublicSpkiRef.current && contactWantsOutgoingE2ee(contactsRef, peer.id)) {
          void sendE2eeHandshake(peer.id);
        }
        window.setTimeout(() => {
          void flushGroupOutboxRef.current?.(peer.id);
        }, 250);
      })
    );

    unsubs.push(
      window.bluetalk.on('peer:disconnected', (peerId) => {
        e2eeReadyPeersRef.current.delete(peerId);
        e2eeHandshakeSentRef.current.delete(peerId);
        e2eeHandshakePromisesRef.current.delete(peerId);
        setPeers((prev) => prev.filter((p) => p.id !== peerId));
        setPeerGamePresence((prev) => {
          if (!prev[peerId]) return prev;
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
        setPeerUserPresence((prev) => {
          if (!prev[peerId]) return prev;
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      })
    );

    unsubs.push(
      window.bluetalk.on('peers:list-sync', (list) => {
        setPeers(Array.isArray(list) ? list : []);
      })
    );

    unsubs.push(
      window.bluetalk.on('peer:message', async (msg) => {
        const fromId = msg.from;
        const isBlocked = fromId && contactsRef.current.some((c) => c?.id === fromId && c.blocked === true);

        if (msg.kind === 'contact-blocked' && fromId) {
          // Von uns blockierte Kontakte dürfen keine Status-Frames mehr auslösen
          if (isBlocked) return;
          const blocked = msg.blocked === true;
          upsertContact({ id: fromId, blockedByPeer: blocked });
          inboundToastRef.current?.({
            variant: blocked ? 'warning' : 'success',
            title: blocked ? 'Du wurdest blockiert' : 'Blockierung aufgehoben',
            message: blocked
              ? `${msg.sender || fromId} hat dich blockiert. Du kannst keine Nachrichten senden, bis du entblockt wirst.`
              : `${msg.sender || fromId} hat die Blockierung aufgehoben. Du kannst wieder Nachrichten senden.`,
          });
          return;
        }

        if (msg.kind === 'chat-deleted' && fromId) {
          if (isBlocked) return;
          upsertContact({ id: fromId, chatDeletedByPeer: true });
          inboundToastRef.current?.({
            variant: 'info',
            title: 'Chat gelöscht',
            message: `${msg.sender || fromId} hat den Chat gelöscht. Du kannst den Verlauf exportieren oder lokal entfernen.`,
          });
          return;
        }

        if (msg.kind === 'messaging-blocked' && msg.refMessageId && fromId) {
          if (isBlocked) return;
          const tid = deliveryTimersRef.current.get(msg.refMessageId);
          if (tid) clearTimeout(tid);
          deliveryTimersRef.current.delete(msg.refMessageId);
          await applyMessagePatch(fromId, msg.refMessageId, { deliveryStatus: 'blocked' });
          upsertContact({ id: fromId, blockedByPeer: true });
          inboundToastRef.current?.({
            variant: 'warning',
            title: 'Nachricht nicht zugestellt',
            message: 'Dieser Kontakt hat dich blockiert.',
          });
          return;
        }

        if (msg.kind === 'profile' && fromId) {
          if (isBlocked) return;
          upsertContact({
            id: fromId,
            name: msg.displayName || msg.sender || fromId,
            bio: msg.bio,
            profilePicture: msg.profilePicture,
          });
          return;
        }

        if (msg.kind === 'e2ee-key-handshake' && fromId && msg.publicSpkiB64 && ownEcdhPrivateRef.current) {
          if (isBlocked) return;
          try {
            const previous = e2eeSessionsRef.current[fromId];
            if (previous?.peerPublicSpkiB64 && previous.peerPublicSpkiB64 !== msg.publicSpkiB64) {
              e2eeReadyPeersRef.current.delete(fromId);
              e2eeSessionsRef.current = {
                ...e2eeSessionsRef.current,
                [fromId]: {
                  ...previous,
                  pendingPeerPublicSpkiB64: msg.publicSpkiB64,
                  keyChanged: true,
                },
              };
              await persistE2eeSessionsMap(e2eeSessionsRef);
              inboundToastRef.current?.({
                variant: 'warning',
                title: 'E2EE-Sicherheitsschlüssel geändert',
                message: 'Die verschlüsselte Sitzung wurde angehalten. Deaktiviere und aktiviere E2EE für den Kontakt erneut, wenn die Änderung erwartet war.',
              });
              return;
            }

            const peerPub = await importPeerPublicFromSpki(msg.publicSpkiB64);
            const aesKey = await deriveSharedAesKey(ownEcdhPrivateRef.current, peerPub);
            const keyId = await computeE2eeKeyId(ownEcdhPublicSpkiRef.current, msg.publicSpkiB64);
            e2eeSessionsRef.current = {
              ...e2eeSessionsRef.current,
              [fromId]: {
                aesKey,
                keyId,
                peerPublicSpkiB64: msg.publicSpkiB64,
                pendingPeerPublicSpkiB64: '',
                keyChanged: false,
                e2eeVersion: Array.isArray(msg.e2eeVersions) && msg.e2eeVersions.includes(2) ? 2 : 1,
              },
            };
            e2eeReadyPeersRef.current.add(fromId);
            await persistE2eeSessionsMap(e2eeSessionsRef);
            if (msg.requestReply === true || !e2eeHandshakeSentRef.current.has(fromId)) {
              void sendE2eeHandshake(fromId, { force: msg.requestReply === true, requestReply: false });
            }
          } catch (e) {
            console.error('E2EE handshake failed:', e);
          }
          return;
        }

        if (msg.kind === 'delivery-receipt' && msg.refMessageId && fromId) {
          if (isBlocked) return;
          const tid = deliveryTimersRef.current.get(msg.refMessageId);
          if (tid) clearTimeout(tid);
          deliveryTimersRef.current.delete(msg.refMessageId);
          await applyMessagePatch(fromId, msg.refMessageId, {
            deliveryStatus: 'delivered',
            deliveredAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : Date.now(),
          });
          upsertContact({ id: fromId, blockedByPeer: false });
          return;
        }

        if (msg.kind === 'read-receipt' && msg.lastReadMessageId && fromId) {
          if (isBlocked) return;
          setPeerReadReceipts((prev) => {
            const next = { ...prev, [fromId]: msg.lastReadMessageId };
            if (window.bluetalk) window.bluetalk.store.set('chatReadReceipts', next);
            return next;
          });
          return;
        }

        // Poker-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
        if (msg.kind === 'poker' && fromId) {
          if (isBlocked) return;
          return;
        }

        // UNO-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
        if (msg.kind === 'uno' && fromId) {
          if (isBlocked) return;
          return;
        }

        // Vier-gewinnt-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
        if (msg.kind === 'connect-four' && fromId) {
          if (isBlocked) return;
          return;
        }

        // Schach-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
        if (msg.kind === 'chess' && fromId) {
          if (isBlocked) return;
          return;
        }

        // Tic-Tac-Toe-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
        if (msg.kind === 'tic-tac-toe' && fromId) {
          if (isBlocked) return;
          return;
        }

        // Plugin-Realtime-Protokoll — nicht im Chatverlauf speichern
        if (msg.kind === REALTIME_KIND && fromId) {
          if (isBlocked) return;
          return;
        }

        if (msg.kind === USER_PRESENCE_KIND && fromId) {
          if (isBlocked) return;
          setPeerUserPresence((prev) => ({
            ...prev,
            [fromId]: {
              status: msg.status === 'dnd' ? 'dnd' : 'online',
              updatedAt: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
            },
          }));
          return;
        }

        if (msg.kind === GAME_PRESENCE_KIND && fromId) {
          if (isBlocked) return;
          setPeerGamePresence((prev) => ({
            ...prev,
            [fromId]: {
              ...msg,
              peerId: fromId,
              updatedAt: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
            },
          }));
          return;
        }

        if (msg.kind === GAME_PRESENCE_CLEAR_KIND && fromId) {
          setPeerGamePresence((prev) => {
            const current = prev[fromId];
            if (!current) return prev;
            if (msg.sessionId && current.sessionId !== msg.sessionId) return prev;
            const next = { ...prev };
            delete next[fromId];
            return next;
          });
          return;
        }

        if (isBlocked) {
          const k = msg.kind;
          const blockable =
            k === 'chat' || k === 'file' || k === 'sticker' || k === 'encrypted-chat-e2ee' || k === 'poker-invite' || k === 'uno-invite' || k === 'connect-four-invite' || k === 'chess-invite' || k === 'tic-tac-toe-invite' || k === 'contact-share';
          if (blockable && fromId && msg.messageId) {
            void window.bluetalk.peer.send(fromId, {
              kind: 'messaging-blocked',
              refMessageId: msg.messageId,
              sender: settingsRef.current.displayName,
            });
          }
          return;
        }

        let normalized = {
          ...msg,
          messageId: msg.messageId || newChatMessageId(),
          timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        };
        let wasPairwiseEncrypted = false;

        if (msg.kind === 'encrypted-chat-e2ee' && fromId) {
          const expectedKeyId = Number(msg.e2eeV || 1) === 2 ? String(msg.keyId || '') : '';
          let session = e2eeSessionsRef.current[fromId];
          const ready = e2eeReadyPeersRef.current.has(fromId);
          if (!session?.aesKey || !ready || (expectedKeyId && session.keyId !== expectedKeyId)) {
            await sendE2eeHandshake(fromId, { force: true, requestReply: true });
            session = await waitForE2eeSession(
              e2eeSessionsRef,
              e2eeReadyPeersRef,
              fromId,
              expectedKeyId,
              5000
            );
          }
          if (!session?.aesKey) {
            console.warn('E2EE message held because no current session is available:', fromId);
            return;
          }
          try {
            const inner = await decryptChatPayload(session.aesKey, msg, { keyId: session.keyId || '' });
            normalized = {
              ...inner,
              messageId: inner.messageId || normalized.messageId,
              timestamp: typeof inner.timestamp === 'number' ? inner.timestamp : normalized.timestamp,
              from: fromId,
            };
            wasPairwiseEncrypted = true;
            const contact = contactsRef.current.find((entry) => entry?.id === fromId);
            if (
              !settingsRef.current.doNotDisturb
              && !isContactNotificationMuted(contact)
              && ![GROUP_EVENT_KIND, GROUP_MESSAGE_KIND, GROUP_RECEIPT_KIND].includes(inner.kind)
            ) {
              void window.bluetalk?.notify?.show?.({
                title: contact?.nickname || contact?.name || normalized.sender || fromId,
                body: buildMessageNotificationPreview(normalized),
              });
            }
          } catch (e) {
            console.error('E2EE decrypt failed:', e);
            return;
          }
        }

        if ([GROUP_EVENT_KIND, GROUP_MESSAGE_KIND, GROUP_RECEIPT_KIND].includes(normalized.kind) && !wasPairwiseEncrypted) {
          console.warn('Rejected unencrypted group protocol frame from peer:', fromId);
          return;
        }

        if (normalized.kind === GROUP_EVENT_KIND) {
          if (!fromId || normalized.actorId !== fromId) return;
          const sendEventReceipt = () => {
            const receipt = {
              kind: GROUP_RECEIPT_KIND,
              protocolVersion: GROUP_PROTOCOL_VERSION,
              groupId: normalized.groupId,
              refEventId: normalized.eventId,
              senderPeerId: ownPeerIdRef.current,
              status: 'delivered',
              receivedAt: Date.now(),
            };
            void sendGroupPacketRef.current?.(fromId, receipt, {
              packetId: `event-receipt:${normalized.eventId}`,
              groupId: normalized.groupId,
              type: 'receipt',
              queue: false,
            });
          };
          if (groupEventIdsRef.current.includes(normalized.eventId)) {
            sendEventReceipt();
            return;
          }
          const current = groupsRef.current.find((group) => group.id === normalized.groupId) || null;
          const applied = applyGroupEvent(current, normalized, ownPeerIdRef.current);
          if (!applied.ok) {
            console.warn('Rejected group event:', applied.error, normalized.groupId, fromId);
            return;
          }
          rememberIncomingGroupEvent(normalized.eventId);
          replaceGroup(applied.group);
          sendEventReceipt();

          if (applied.shouldAccept) {
            try {
              const accept = createGroupAcceptEvent(applied.group, ownPeerIdRef.current);
              void sendGroupPacketRef.current?.(fromId, accept, {
                packetId: accept.eventId,
                groupId: applied.group.id,
                type: 'control',
              });
            } catch (error) {
              console.warn('Could not acknowledge group invitation:', error?.message);
            }
            inboundToastRef.current?.({
              variant: 'success',
              title: 'Neue Gruppe',
              message: `Du wurdest zu „${applied.group.name}“ hinzugefügt.`,
            });
          }

          if (applied.shouldBroadcast && current && isGroupAdmin(applied.group, ownPeerIdRef.current)) {
            try {
              const update = createGroupUpdateEvent(
                current,
                applied.group,
                ownPeerIdRef.current,
                normalized.action === 'accept' ? 'member-accepted' : 'member-left'
              );
              const route = buildTargetedGroupRoute(applied.group, ownPeerIdRef.current, { includeInvited: true });
              for (const recipientId of route.recipients) {
                void sendGroupPacketRef.current?.(recipientId, update, {
                  packetId: update.eventId,
                  groupId: applied.group.id,
                  type: 'control',
                });
              }
            } catch (error) {
              console.warn('Could not publish group membership update:', error?.message);
            }
          }
          return;
        }

        if (normalized.kind === GROUP_RECEIPT_KIND) {
          const group = groupsRef.current.find((entry) => entry.id === normalized.groupId);
          if (group && normalized.senderPeerId === fromId && normalized.refEventId) {
            persistGroupOutbox(groupOutboxRef.current.filter((entry) => !(
              entry.peerId === fromId && entry.packetId === normalized.refEventId
            )));
            return;
          }
          if (
            !group
            || normalized.senderPeerId !== fromId
            || !normalized.refMessageId
          ) return;
          const existingMessage = (messageCacheRef.current[group.id] || [])
            .find((item) => item.messageId === normalized.refMessageId && item.from === 'self');
          if (!existingMessage) return;
          const recipients = existingMessage.groupRecipientIds || [];
          if (!recipients.includes(fromId)) return;
          const delivery = {
            ...(existingMessage.groupDelivery || {}),
            [fromId]: {
              status: normalized.status === 'seen' ? 'seen' : 'delivered',
              at: Number.isFinite(normalized.receivedAt) ? normalized.receivedAt : Date.now(),
            },
          };
          await applyMessagePatch(group.id, normalized.refMessageId, {
            groupDelivery: delivery,
            deliveryStatus: deriveGroupDeliveryStatus(delivery, recipients),
            groupDeliverySummary: summarizeGroupDelivery(delivery, recipients),
          });
          persistGroupOutbox(groupOutboxRef.current.filter((entry) => !(
            entry.type === 'message'
            && entry.peerId === fromId
            && entry.messageId === normalized.refMessageId
          )));
          return;
        }

        if (normalized.kind === GROUP_MESSAGE_KIND) {
          const group = groupsRef.current.find((entry) => entry.id === normalized.groupId);
          const validation = validateIncomingGroupMessage(group, normalized, fromId, ownPeerIdRef.current);
          if (!validation.ok) {
            console.warn('Rejected group message:', validation.error, normalized.groupId, fromId);
            return;
          }
          let groupMessage = {
            ...normalized.payload,
            messageId: normalized.messageId,
            timestamp: normalized.timestamp,
            sender: getGroupMember(group, fromId)?.displayName || fromId,
            senderPeerId: fromId,
            groupId: group.id,
            groupRevision: normalized.groupRevision,
            from: fromId,
          };
          if (groupMessage.kind === 'sticker') {
            try {
              groupMessage = { ...groupMessage, ...validateStickerData(groupMessage) };
            } catch {
              return;
            }
          } else if (groupMessage.kind === 'file' && groupMessage.fileData) {
            const actualSize = base64ByteLength(groupMessage.fileData);
            if (actualSize < 0 || actualSize > MAX_CHAT_FILE_BYTES) return;
            groupMessage.fileSize = actualSize;
          } else if (groupMessage.kind === 'chat' && String(groupMessage.content || '').length > MAX_CHAT_TEXT_CHARS) {
            return;
          }

          const receipt = {
            kind: GROUP_RECEIPT_KIND,
            protocolVersion: GROUP_PROTOCOL_VERSION,
            groupId: group.id,
            refMessageId: groupMessage.messageId,
            senderPeerId: ownPeerIdRef.current,
            status: 'delivered',
            receivedAt: Date.now(),
          };
          void sendGroupPacketRef.current?.(fromId, receipt, {
            packetId: `receipt:${groupMessage.messageId}`,
            groupId: group.id,
            type: 'receipt',
            queue: false,
          });

          const meta = await window.bluetalk.messages.append(group.id, groupMessage);
          if (meta?.appended === false) return;
          setChatMeta((prev) => ({
            ...prev,
            [group.id]: meta?.count ? meta : {
              count: (prev[group.id]?.count || 0) + 1,
              lastMessage: groupMessage,
            },
          }));
          startTransition(() => {
            setMessages((prev) => ({
              ...prev,
              [group.id]: [...(prev[group.id] || []), groupMessage],
            }));
          });
          if (!settingsRef.current.doNotDisturb) {
            void window.bluetalk?.notify?.show?.({
              title: group.name,
              body: `${groupMessage.sender}: ${buildMessageNotificationPreview(groupMessage)}`,
            });
          }
          return;
        }

        if (normalized.kind === 'sticker') {
          try {
            normalized = { ...normalized, ...validateStickerData(normalized) };
          } catch {
            console.warn('Rejected invalid sticker payload from peer:', fromId);
            return;
          }
        } else if (normalized.kind === 'file' && normalized.fileData) {
          const actualSize = base64ByteLength(normalized.fileData);
          if (actualSize < 0 || actualSize > MAX_CHAT_FILE_BYTES) {
            console.warn('Rejected oversized or invalid file payload from peer:', fromId);
            return;
          }
          normalized = { ...normalized, fileSize: actualSize };
        } else if (normalized.kind === 'chat' && String(normalized.content || '').length > MAX_CHAT_TEXT_CHARS) {
          console.warn('Rejected oversized chat message from peer:', fromId);
          return;
        }

        if ((normalized.kind === 'chat' || normalized.kind === 'file' || normalized.kind === 'sticker' || normalized.kind === 'contact-share') && normalized.messageId && fromId) {
          void window.bluetalk.peer.send(fromId, {
            kind: 'delivery-receipt',
            refMessageId: normalized.messageId,
            receivedAt: Date.now(),
            sender: settingsRef.current.displayName,
          });
        }

        const meta = await window.bluetalk.messages.append(fromId, normalized);
        if (meta?.appended === false) return;

        if ((normalized.kind === 'poker-invite' || normalized.kind === 'uno-invite' || normalized.kind === 'connect-four-invite' || normalized.kind === 'chess-invite' || normalized.kind === 'tic-tac-toe-invite') && fromId) {
          const game = normalized.kind === 'poker-invite'
            ? 'poker'
            : normalized.kind === 'uno-invite'
              ? 'uno'
              : normalized.kind === 'chess-invite'
                ? 'chess'
                : normalized.kind === 'tic-tac-toe-invite'
                  ? 'tic-tac-toe'
                  : 'connect-four';
          const sessionId = game === 'poker' ? normalized.tableId : normalized.gameId;
          const hostPeerId = normalized.hostPeerId || fromId;
          if (sessionId && hostPeerId) {
            const key = gameInviteKey(game, hostPeerId, sessionId);
            setGameInviteKeys((prev) => {
              if (prev.has(key)) return prev;
              const next = new Set(prev);
              next.add(key);
              void window.bluetalk?.store?.set?.('gameInviteKeys', [...next]);
              return next;
            });
          }
        }

        if (normalized.kind === 'contact-share' && normalized.sharedContact?.id) {
          const shared = normalized.sharedContact;
          upsertContact({
            id: shared.id,
            name: shared.displayName || shared.name || shared.id,
            bio: shared.bio,
            profilePicture: shared.profilePicture,
            address: shared.address,
          });
        }

        setChatMeta((prev) => ({
          ...prev,
          [fromId]: meta?.count ? meta : {
            count: (prev[fromId]?.count || 0) + 1,
            lastMessage: normalized,
          },
        }));

        startTransition(() => {
          setMessages((prev) => ({
            ...prev,
            [fromId]: [...(prev[fromId] || []), normalized],
          }));
        });

        if (fromId) {
          setContacts((prev) => {
            const existing = prev.find((c) => c?.id === fromId) || null;
            const hasOutgoing = existing?.hasOutgoing === true;
            const requestCleared = existing?.pendingMessageRequest === false;
            const updated = applyContactPatch(prev, {
              id: fromId,
              blockedByPeer: false,
              chatDeletedByPeer: false,
              name: normalized.sender || existing?.name || fromId,
              pendingMessageRequest: hasOutgoing || requestCleared ? false : true,
            });
            if (window.bluetalk) void window.bluetalk.store.set('contacts', updated);
            return updated;
          });
        }
      })
    );

    let cancelled = false;
    (async () => {
      try {
        const [
          storedContacts,
          storedChatMeta,
          storedSettings,
          storedReadReceipts,
          currentPeers,
          storedInviteKeys,
          storedGroups,
          peerInfo,
          storedGroupOutbox,
          storedGroupEventIds,
        ] = await Promise.all([
          window.bluetalk.store.get('contacts', []),
          window.bluetalk.messages.getMeta(),
          window.bluetalk.store.get('settings', {}),
          window.bluetalk.store.get('chatReadReceipts', {}),
          window.bluetalk.peer.getPeers(),
          window.bluetalk.store.get('gameInviteKeys', []),
          window.bluetalk.store.get('groups', []),
          window.bluetalk.peer.getInfo(),
          window.bluetalk.store.get('groupOutbox', []),
          window.bluetalk.store.get('groupEventIds', []),
        ]);

        if (cancelled) return;

        const meta = storedChatMeta || {};
        let migrated = false;
        const normalized = (storedContacts || []).map((c) => {
          if (!c?.id) return c;
          const count = meta[c.id]?.count || 0;
          if (count > 0 && c.hasOutgoing !== true && c.pendingMessageRequest !== true) {
            migrated = true;
            return { ...c, hasOutgoing: true };
          }
          return c;
        });
        if (migrated) {
          window.bluetalk.store.set('contacts', normalized);
        }

        setContacts(normalized);
        setChatMeta(meta);
        const normalizedGroups = [];
        for (const rawGroup of Array.isArray(storedGroups) ? storedGroups : []) {
          try {
            normalizedGroups.push(normalizeGroup(rawGroup));
          } catch {
            /* skip invalid persisted group */
          }
        }
        groupsRef.current = normalizedGroups;
        setGroups(normalizedGroups);
        ownPeerIdRef.current = peerInfo?.id || '';
        setOwnPeerId(peerInfo?.id || '');
        groupOutboxRef.current = Array.isArray(storedGroupOutbox) ? storedGroupOutbox : [];
        groupEventIdsRef.current = Array.isArray(storedGroupEventIds) ? storedGroupEventIds : [];

        const storedViewed = await window.bluetalk.store.get('chatLastViewedPeerTs', {});
        const viewedRaw = storedViewed && typeof storedViewed === 'object' ? storedViewed : {};
        const viewed = {};
        for (const [k, v] of Object.entries(viewedRaw)) {
          if (typeof v === 'number' && !Number.isNaN(v)) viewed[k] = v;
        }
        let viewedDirty = false;
        for (const [peerId, row] of Object.entries(meta || {})) {
          if (peerId === 'self') continue;
          if (viewed[peerId] != null) continue;
          const lm = row?.lastMessage;
          if (!lm || typeof lm.timestamp !== 'number') continue;
          if (lm.from === 'self') {
            viewed[peerId] = lm.timestamp;
            viewedDirty = true;
          }
        }
        if (viewedDirty) window.bluetalk.store.set('chatLastViewedPeerTs', viewed);
        setChatLastViewedPeerTs(viewed);

        setPeerReadReceipts(storedReadReceipts && typeof storedReadReceipts === 'object' ? storedReadReceipts : {});

        if (Array.isArray(storedInviteKeys) && storedInviteKeys.length) {
          setGameInviteKeys(new Set(storedInviteKeys.filter((key) => typeof key === 'string' && key.length)));
        }

        const stored = storedSettings && typeof storedSettings === 'object' ? storedSettings : {};
        let mergedSettings = { ...DEFAULT_APP_SETTINGS, ...stored };
        mergedSettings.uiResize = {
          ...(DEFAULT_APP_SETTINGS.uiResize || {}),
          ...(stored.uiResize && typeof stored.uiResize === 'object' ? stored.uiResize : {}),
        };
        mergedSettings.uiCollapse = {
          ...(DEFAULT_APP_SETTINGS.uiCollapse || {}),
          ...(stored.uiCollapse && typeof stored.uiCollapse === 'object' ? stored.uiCollapse : {}),
        };
        const displayNameTrim = (mergedSettings.displayName || '').trim();
        if (mergedSettings.onboardingUsernameDone !== true && displayNameTrim && displayNameTrim !== 'Anonymous') {
          mergedSettings = { ...mergedSettings, onboardingUsernameDone: true };
          window.bluetalk.store.set('settings', mergedSettings);
        }
        setSettings(mergedSettings);
        if (mergedSettings.theme) setTheme(mergedSettings.theme);
        void window.bluetalk.peer.broadcast(buildUserPresencePayload(mergedSettings));

        const needsUsernameOnboarding = mergedSettings.onboardingUsernameDone !== true
          && (displayNameTrim === '' || displayNameTrim === 'Anonymous');
        setShowUsernameOnboarding(needsUsernameOnboarding);
        setUsernameOnboardingGateReady(true);

        setPeers(currentPeers || []);
        setLoadError('');
      } catch (e) {
        if (!cancelled) {
          setLoadError(e?.message || 'Could not load your local data.');
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((unsub) => unsub?.());
      // Clear all delivery timers on unmount
      deliveryTimersRef.current.forEach((tid) => clearTimeout(tid));
      deliveryTimersRef.current.clear();
    };
  }, [
    upsertContact,
    applyContactPatch,
    applyMessagePatch,
    sendE2eeHandshake,
    replaceGroup,
    rememberIncomingGroupEvent,
    persistGroupOutbox,
  ]);

  useEffect(() => {
    if (!window.bluetalk?.on) return undefined;
    return window.bluetalk.on('app:data-cleared', (payload) => {
      const kind = payload?.kind;
      if (kind === 'all') {
        setContacts([]);
        setChatMeta({});
        setMessages({});
        setLoadedChats({});
        setPeerReadReceipts({});
        setChatLastViewedPeerTs({});
        setPeers([]);
        setSettings({ ...DEFAULT_APP_SETTINGS });
        setTheme('dark');
        setLoadError('');
        setShowVersionWelcome(false);
        ownPeerIdRef.current = '';
        setOwnPeerId('');
        ownEcdhPrivateRef.current = null;
        ownEcdhPublicSpkiRef.current = '';
        e2eeSessionsRef.current = {};
        e2eeReadyPeersRef.current.clear();
        e2eeHandshakeSentRef.current.clear();
        e2eeHandshakePromisesRef.current.clear();
        setE2eeBootNonce((n) => n + 1);
        setUsernameOnboardingGateReady(true);
        setShowUsernameOnboarding(true);
        void window.bluetalk.peer.getInfo().then((info) => {
          ownPeerIdRef.current = info?.id || '';
          setOwnPeerId(info?.id || '');
        }).catch(() => {});
        window.location.hash = '#/';
        return;
      }
      if (kind === 'messages') {
        setChatMeta({});
        setMessages({});
        setLoadedChats({});
        setPeerReadReceipts({});
        setChatLastViewedPeerTs({});
        if (window.bluetalk) window.bluetalk.store.set('chatLastViewedPeerTs', {});
        window.location.hash = '#/';
        return;
      }
      if (kind === 'ai-chat') {
        void window.bluetalk.messages.getMeta().then((meta) => {
          setChatMeta(meta || {});
          setMessages((prev) => {
            const next = { ...prev };
            for (const peerId of Object.keys(next)) {
              if (isAiChatPeerId(peerId)) delete next[peerId];
            }
            return next;
          });
          setLoadedChats((prev) => {
            const next = { ...prev };
            for (const peerId of Object.keys(next)) {
              if (isAiChatPeerId(peerId)) delete next[peerId];
            }
            return next;
          });
        });
      }
    });
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.ollama?.onAskUser) return undefined;
    return window.bluetalk.ollama.onAskUser((data) => {
      if (!data || !data.requestId) return;
      setAgentAskUser(data);
    });
  }, []);

  useEffect(() => {
    if (!window.bluetalk || loadError || !usernameOnboardingGateReady || showUsernameOnboarding) return undefined;
    let cancelled = false;
    const notes = getReleaseNotesForVersion(APP_VERSION);
    if (!notes) return undefined;

    (async () => {
      try {
        const lastSeen = await window.bluetalk.store.get('lastSeenReleaseNotesVersion', '');
        if (!cancelled && lastSeen !== APP_VERSION) {
          setShowVersionWelcome(true);
        }
      } catch {
        /* ignore */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadError, usernameOnboardingGateReady, showUsernameOnboarding]);

  const dismissVersionWelcome = useCallback(() => {
    setShowVersionWelcome(false);
    if (window.bluetalk) {
      window.bluetalk.store.set('lastSeenReleaseNotesVersion', APP_VERSION);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Auch den settings-State mitziehen, sonst überschreibt ein späteres
    // updateSettings (persistiert das ganze Objekt) das Theme mit dem alten Wert.
    setSettings((prev) => ({ ...prev, theme: next }));
    if (window.bluetalk) window.bluetalk.store.set('settings.theme', next);
  }, [theme]);

  const sendPairwiseEncrypted = useCallback(async (peerId, innerPayload) => {
    if (!window.bluetalk?.peer || !peerId || !innerPayload) return false;
    await waitForE2eeIdentity(ownEcdhPublicSpkiRef);
    let session = e2eeSessionsRef.current[peerId];
    const ready = e2eeReadyPeersRef.current.has(peerId);
    if (!session?.aesKey || !session.keyId || !ready || session.keyChanged === true) {
      await sendE2eeHandshake(peerId, { force: true, requestReply: true });
      session = await waitForE2eeSession(e2eeSessionsRef, e2eeReadyPeersRef, peerId, '', 8000);
    }
    if (!session?.aesKey || !session.keyId || session.keyChanged === true) return false;
    try {
      const encrypted = await encryptChatPayload(session.aesKey, innerPayload, {
        keyId: session.keyId,
        version: session.e2eeVersion === 2 ? 2 : 1,
      });
      return Boolean(await window.bluetalk.peer.send(peerId, {
        ...encrypted,
        sender: settingsRef.current.displayName,
        messageId: innerPayload.messageId || innerPayload.eventId || innerPayload.refMessageId || newChatMessageId(),
        timestamp: Number.isFinite(innerPayload.timestamp) ? innerPayload.timestamp : Date.now(),
      }));
    } catch (error) {
      console.warn('Pairwise encrypted send failed:', peerId, error?.message);
      return false;
    }
  }, [sendE2eeHandshake]);

  const sendGroupPacket = useCallback(async (peerId, packet, options = {}) => {
    const packetId = options.packetId || packet?.messageId || packet?.eventId || packet?.refMessageId;
    const queue = options.queue !== false;
    let entry = null;
    if (queue && packetId) {
      entry = {
        id: `${options.type || 'control'}:${packetId}:${peerId}`,
        type: options.type || 'control',
        packetId,
        messageId: options.messageId || packet?.messageId || '',
        groupId: options.groupId || packet?.groupId || '',
        peerId,
        packet,
        status: 'queued',
        attempts: 0,
        createdAt: Date.now(),
      };
      const next = groupOutboxRef.current.filter((item) => item.id !== entry.id);
      persistGroupOutbox([...next, entry]);
    }

    const sent = await sendPairwiseEncrypted(peerId, packet);
    if (!entry) return sent;
    persistGroupOutbox(groupOutboxRef.current.map((item) => item.id === entry.id
      ? { ...item, status: sent ? 'sent' : 'offline', attempts: (item.attempts || 0) + 1, lastAttemptAt: Date.now() }
      : item));
    return sent;
  }, [persistGroupOutbox, sendPairwiseEncrypted]);

  sendGroupPacketRef.current = sendGroupPacket;

  const flushGroupOutbox = useCallback(async (peerId) => {
    if (!peerId) return;
    const pending = groupOutboxRef.current.filter((entry) => entry.peerId === peerId);
    for (const entry of pending) {
      const sent = await sendPairwiseEncrypted(peerId, entry.packet);
      if (!sent) continue;
      persistGroupOutbox(groupOutboxRef.current.map((item) => item.id === entry.id
        ? { ...item, status: 'sent', attempts: (item.attempts || 0) + 1, lastAttemptAt: Date.now() }
        : item));
      if (entry.type === 'message') {
        const stored = (messageCacheRef.current[entry.groupId] || [])
          .find((message) => message.messageId === entry.messageId);
        if (stored) {
          const delivery = {
            ...(stored.groupDelivery || {}),
            [peerId]: { status: 'sent', at: Date.now() },
          };
          const recipients = stored.groupRecipientIds || [];
          await applyMessagePatch(entry.groupId, entry.messageId, {
            groupDelivery: delivery,
            deliveryStatus: deriveGroupDeliveryStatus(delivery, recipients),
            groupDeliverySummary: summarizeGroupDelivery(delivery, recipients),
          });
        }
      }
    }
  }, [applyMessagePatch, persistGroupOutbox, sendPairwiseEncrypted]);

  flushGroupOutboxRef.current = flushGroupOutbox;

  useEffect(() => {
    for (const peer of peers) {
      if (peer?.id && groupOutboxRef.current.some((entry) => entry.peerId === peer.id)) {
        void flushGroupOutbox(peer.id);
      }
    }
  }, [peers, flushGroupOutbox]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const online = new Set(peers.map((peer) => peer.id));
      const pendingPeerIds = [...new Set(groupOutboxRef.current
        .map((entry) => entry.peerId)
        .filter((peerId) => online.has(peerId)))];
      for (const peerId of pendingPeerIds) void flushGroupOutbox(peerId);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [peers, flushGroupOutbox]);

  const sendMessage = useCallback((peerId, payload) => {
    if (!window.bluetalk || !peerId) return Promise.resolve(false);

    if (isGroupChatId(peerId)) {
      const group = groupsRef.current.find((entry) => entry.id === peerId);
      const selfPeerId = ownPeerIdRef.current;
      if (!group || !selfPeerId || !isActiveGroupMember(group, selfPeerId)) {
        return Promise.resolve({ ok: false, error: 'not_group_member' });
      }
      const outgoing = typeof payload === 'string'
        ? { kind: 'chat', content: payload }
        : { kind: 'chat', ...payload };
      if (!['chat', 'file', 'sticker', 'contact-share'].includes(outgoing.kind)) {
        return Promise.resolve({ ok: false, error: 'unsupported_group_payload' });
      }
      const localPreviewUrl = ['file', 'sticker'].includes(outgoing.kind) ? outgoing.localPreviewUrl : undefined;
      const wireContent = { ...outgoing };
      delete wireContent.localPreviewUrl;
      const messageId = newChatMessageId();
      const createdAt = Date.now();
      const route = buildTargetedGroupRoute(group, selfPeerId, { includeInvited: false });
      const initialDelivery = Object.fromEntries(route.recipients.map((recipientId) => [
        recipientId,
        { status: 'offline' },
      ]));
      const inner = {
        kind: GROUP_MESSAGE_KIND,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        groupId: group.id,
        groupRevision: group.revision,
        messageId,
        senderPeerId: selfPeerId,
        sender: settings.displayName,
        timestamp: createdAt,
        payload: wireContent,
      };
      const selfMessage = {
        ...wireContent,
        localPreviewUrl,
        sender: settings.displayName,
        senderPeerId: selfPeerId,
        messageId,
        timestamp: createdAt,
        groupId: group.id,
        groupRevision: group.revision,
        groupRecipientIds: route.recipients,
        groupDelivery: initialDelivery,
        groupDeliverySummary: summarizeGroupDelivery(initialDelivery, route.recipients),
        from: 'self',
        deliveryStatus: deriveGroupDeliveryStatus(initialDelivery, route.recipients),
      };

      const nextCached = [...(messageCacheRef.current[group.id] || []), selfMessage];
      messageCacheRef.current = { ...messageCacheRef.current, [group.id]: nextCached };
      startTransition(() => {
        setMessages((prev) => ({ ...prev, [group.id]: [...(prev[group.id] || []), selfMessage] }));
        setChatMeta((prev) => ({
          ...prev,
          [group.id]: { count: (prev[group.id]?.count || 0) + 1, lastMessage: selfMessage },
        }));
      });

      return (async () => {
        const meta = await window.bluetalk.messages.append(group.id, selfMessage);
        const pairs = await Promise.all(route.recipients.map(async (recipientId) => {
          const sent = await sendGroupPacket(recipientId, inner, {
            packetId: messageId,
            messageId,
            groupId: group.id,
            type: 'message',
          });
          return [recipientId, sent];
        }));
        const delivery = { ...initialDelivery };
        for (const [recipientId, sent] of pairs) {
          delivery[recipientId] = { status: sent ? 'sent' : 'offline', at: Date.now() };
        }
        const patch = {
          groupDelivery: delivery,
          groupDeliverySummary: summarizeGroupDelivery(delivery, route.recipients),
          deliveryStatus: deriveGroupDeliveryStatus(delivery, route.recipients),
          localPreviewUrl: undefined,
        };
        await applyMessagePatch(group.id, messageId, patch);
        if (meta?.count) setChatMeta((prev) => ({ ...prev, [group.id]: meta }));
        return { ok: true, queued: pairs.some(([, sent]) => !sent), delivery: patch.groupDeliverySummary };
      })().catch((error) => ({ ok: false, error: error?.message || 'group_send_failed' }));
    }

    if (isAiChatPeerId(peerId)) {
      const outgoing = typeof payload === 'string'
        ? { kind: 'chat', content: payload }
        : { ...payload };

      if (outgoing.kind !== 'chat' && outgoing.kind !== 'file') {
        return Promise.resolve(false);
      }

      const fileAttachment = outgoing.kind === 'file'
        ? {
            fileName: outgoing.fileName || outgoing.content,
            fileSize: outgoing.fileSize,
            fileType: outgoing.fileType,
            fileData: outgoing.fileData,
            localPreviewUrl: outgoing.localPreviewUrl,
          }
        : outgoing.fileAttachment;

      const text = outgoing.kind === 'chat' ? String(outgoing.content || '').trim() : '';
      const hasFile = Boolean(fileAttachment?.fileData);
      if (!text && !hasFile) {
        return Promise.resolve(false);
      }

      const normalizedFileAttachment = hasFile
        ? {
            ...fileAttachment,
            fileType: normalizeAttachmentFileType(
              fileAttachment.fileName,
              fileAttachment.fileType,
              fileAttachment.fileData
            ),
          }
        : null;

      const createdAt = Date.now();
      const messagesToPersist = [];

      if (hasFile) {
        // localPreviewUrl (blob:) bewusst nicht persistieren — nach einem
        // Neustart rendert das Bild aus fileData (wie im Direkt- und Gruppen-Pfad).
        messagesToPersist.push({
          kind: 'file',
          content: normalizedFileAttachment.fileName || 'Anhang',
          fileName: normalizedFileAttachment.fileName,
          fileSize: normalizedFileAttachment.fileSize,
          fileType: normalizedFileAttachment.fileType,
          fileData: normalizedFileAttachment.fileData,
          sender: settings.displayName,
          messageId: newChatMessageId(),
          timestamp: createdAt,
          from: 'self',
          deliveryStatus: 'pending',
        });
      }

      let triggerMessageId = null;
      if (text) {
        triggerMessageId = newChatMessageId();
        const chatMsg = {
          kind: 'chat',
          content: text,
          sender: settings.displayName,
          messageId: triggerMessageId,
          timestamp: createdAt + (hasFile ? 1 : 0),
          from: 'self',
          deliveryStatus: 'pending',
        };
        if (outgoing.replyTo) chatMsg.replyTo = outgoing.replyTo;
        messagesToPersist.push(chatMsg);
      } else if (hasFile) {
        triggerMessageId = messagesToPersist[0].messageId;
      }

      const prompt = text
        || `Analysiere die angehängte Datei „${normalizedFileAttachment?.fileName || 'Anhang'}".`;
      const attachments = hasFile ? [normalizedFileAttachment] : [];

      // Busy-Check VOR dem optimistischen UI-Update, sonst bleiben
      // Phantom-Nachrichten hängen, die nie persistiert werden.
      if (activeAiChatRequestRef.current) {
        return Promise.resolve({ ok: false, error: 'chat_busy' });
      }

      // Die Blob-Vorschau nur in der In-Memory-/UI-Kopie behalten.
      const messagesForUi = hasFile && normalizedFileAttachment.localPreviewUrl
        ? messagesToPersist.map((msg) => (msg.kind === 'file'
          ? { ...msg, localPreviewUrl: normalizedFileAttachment.localPreviewUrl }
          : msg))
        : messagesToPersist;

      startTransition(() => {
        setMessages((prev) => ({
          ...prev,
          [peerId]: [...(prev[peerId] || []), ...messagesForUi],
        }));
        setChatMeta((prev) => {
          const last = messagesForUi[messagesForUi.length - 1];
          return {
            ...prev,
            [peerId]: {
              count: (prev[peerId]?.count || 0) + messagesForUi.length,
              lastMessage: last,
            },
          };
        });
      });

      return (async () => {
        try {
          for (const msg of messagesToPersist) {
            const meta = await window.bluetalk.messages.append(peerId, msg);
            if (meta?.count) {
              setChatMeta((prev) => ({ ...prev, [peerId]: meta }));
            }
          }
          await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'delivered' });
          setMessages((prev) => {
            const list = prev[peerId] || [];
            return {
              ...prev,
              [peerId]: list.map((item) =>
                item?.messageId === triggerMessageId ? { ...item, deliveryStatus: 'delivered' } : item
              ),
            };
          });

          const requestId =
            typeof crypto?.randomUUID === 'function'
              ? crypto.randomUUID()
              : `ai-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          activeAiChatRequestRef.current = requestId;
          setAiChatPendingPeerId(peerId);
          setAiChatProgress({ peerId, requestId, thinking: '', content: '', toolEvents: [], tps: 0, genTimeMs: 0 });
          let result;
          let lastAiUpdate = { thinking: '', content: '', tps: 0, genTimeMs: 0, toolEvents: [], segments: [] };
          let progressRafId = null;
          const flushAiProgress = () => {
            progressRafId = null;
            setAiChatProgress({ peerId, requestId, ...lastAiUpdate });
          };
          const scheduleAiProgress = (update) => {
            const toolEvents = Array.isArray(update.segments)
              ? toolEventsFromSegments(update.segments)
              : (Array.isArray(update.toolResults) && update.toolResults?.length
                ? [...(lastAiUpdate.toolEvents || []), ...update.toolResults]
                : (lastAiUpdate.toolEvents || []));
            lastAiUpdate = {
              thinking: update.thinking || '',
              content: update.content || '',
              tps: typeof update.tps === 'number' ? update.tps : 0,
              genTimeMs: typeof update.genTimeMs === 'number' ? update.genTimeMs : 0,
              toolEvents,
              segments: Array.isArray(update.segments) ? update.segments : (lastAiUpdate.segments || []),
            };
            const hasRunningSubagent = Array.isArray(update.segments)
              && update.segments.some((s) => s.type === 'subagent' && s.status === 'running');
            const immediate = Boolean(update.done)
              || (Array.isArray(update.toolResults) && update.toolResults.length > 0)
              || hasRunningSubagent;
            if (immediate) {
              if (progressRafId != null) {
                cancelAnimationFrame(progressRafId);
                progressRafId = null;
              }
              flushAiProgress();
              return;
            }
            if (progressRafId == null) {
              progressRafId = requestAnimationFrame(flushAiProgress);
            }
          };
          try {
            result = await window.bluetalk.ollama.chat(
              { peerId, prompt, requestId, attachments },
              scheduleAiProgress
            );
          } finally {
            if (progressRafId != null) {
              cancelAnimationFrame(progressRafId);
              progressRafId = null;
            }
            if (activeAiChatRequestRef.current === requestId) {
              activeAiChatRequestRef.current = null;
            }
            setAiChatPendingPeerId((current) => (current === peerId ? null : current));
            setAiChatProgress((current) => (current?.requestId === requestId ? null : current));
          }
          if (result?.error === 'chat_aborted') {
            const thinking = String(lastAiUpdate.thinking || '').trim();
            const content = String(lastAiUpdate.content || '').trim();
            const assistantMessage = {
              kind: 'chat',
              content,
              thinking: thinking || undefined,
              toolEvents: lastAiUpdate.toolEvents?.length ? lastAiUpdate.toolEvents : undefined,
              segments: lastAiUpdate.segments?.length ? lastAiUpdate.segments : undefined,
              aiStats:
                lastAiUpdate.tps > 0 || lastAiUpdate.genTimeMs > 0
                  ? { tps: lastAiUpdate.tps, genTimeMs: lastAiUpdate.genTimeMs }
                  : undefined,
              aiStopped: true,
              sender: 'KI-Assistent',
              messageId: newChatMessageId(),
              timestamp: Date.now(),
              from: 'peer',
            };
            const replyMeta = await window.bluetalk.messages.append(peerId, assistantMessage);
            setMessages((prev) => ({
              ...prev,
              [peerId]: [...(prev[peerId] || []), assistantMessage],
            }));
            if (replyMeta?.count) {
              setChatMeta((prev) => ({ ...prev, [peerId]: replyMeta }));
            }
            return { ok: false, error: 'chat_aborted' };
          }
          // Akzeptiere Ergebnis, wenn entweder Text vorhanden ist ODER Segmente
          // (Thinking/Tools) — kleine Modelle beenden oft ohne finale Textantwort.
          const resultSegments = Array.isArray(result?.message?.segments) ? result.message.segments : null;
          const hasResultContent = Boolean(result?.ok)
            && (result?.message?.content?.trim() || (resultSegments && resultSegments.length));
          if (!hasResultContent) {
            await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'scheduled' });
            return { ok: false, error: result?.error || 'chat_failed' };
          }

          const assistantMessage = {
            kind: 'chat',
            content: result.message.content || '',
            thinking: result.message.thinking || undefined,
            toolEvents: result.message.toolEvents || undefined,
            segments: resultSegments || undefined,
            aiStats: result.message.stats || undefined,
            sender: result.message.sender || 'KI-Assistent',
            model: result.message.model || '',
            messageId: newChatMessageId(),
            timestamp: Date.now(),
            from: 'peer',
          };
          const replyMeta = await window.bluetalk.messages.append(peerId, assistantMessage);
          setMessages((prev) => ({
            ...prev,
            [peerId]: [...(prev[peerId] || []), assistantMessage],
          }));
          if (replyMeta?.count) {
            setChatMeta((prev) => ({ ...prev, [peerId]: replyMeta }));
          }
          return { ok: true };
        } catch (error) {
          console.error('AI chat failed:', error);
          const message = error?.message || 'chat_failed';
          if (message !== 'chat_aborted') {
            await applyMessagePatch(peerId, triggerMessageId, { deliveryStatus: 'scheduled' });
          }
          return {
            ok: false,
            error: /No handler registered for 'ollama:chat'|ERR_HANDLER_NOT_REGISTERED/i.test(message)
              ? 'ollama_handler_missing'
              : message,
          };
        }
      })();
    }

    if (contactsRef.current.some((c) => {
      if (c?.id !== peerId) return false;
      return c.blocked === true || c.blockedByPeer === true || c.chatDeletedByPeer === true;
    })) {
      return Promise.resolve(false);
    }

    const outgoing = typeof payload === 'string'
      ? { kind: 'chat', content: payload }
      : { kind: 'chat', ...payload };

    const localPreviewUrl =
      outgoing.kind === 'file' || outgoing.kind === 'sticker' ? outgoing.localPreviewUrl : undefined;
    const fileDataB64 =
      outgoing.kind === 'file' || outgoing.kind === 'sticker' ? outgoing.fileData : undefined;

    const payloadForCrypto = { ...outgoing };
    delete payloadForCrypto.localPreviewUrl;

    const messageId = newChatMessageId();
    const createdAt = Date.now();

    const innerPlain = {
      ...payloadForCrypto,
      sender: settings.displayName,
      messageId,
      timestamp: createdAt,
    };

    const selfMessageLight =
      innerPlain.kind === 'file' || innerPlain.kind === 'sticker'
        ? {
            ...innerPlain,
            fileData: undefined,
            localPreviewUrl,
            from: 'self',
            deliveryStatus: 'pending',
          }
        : {
            ...innerPlain,
            from: 'self',
            deliveryStatus: 'pending',
          };

    const selfMessageFull = {
      ...innerPlain,
      from: 'self',
      deliveryStatus: 'pending',
    };

    const flushOptimistic = () => {
      setMessages((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] || []), selfMessageLight],
      }));

      setChatMeta((prev) => ({
        ...prev,
        [peerId]: {
          count: (prev[peerId]?.count || 0) + 1,
          lastMessage: selfMessageLight,
        },
      }));

      upsertContact({ id: peerId, hasOutgoing: true, pendingMessageRequest: false });
    };

    startTransition(flushOptimistic);

    const sendPromise = (async () => {
      const revokePreview = () => {
        if (localPreviewUrl) {
          try {
            URL.revokeObjectURL(localPreviewUrl);
          } catch {
            /* ignore */
          }
        }
      };

      const failScheduled = () => {
        revokePreview();
        void applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled', localPreviewUrl: undefined });
      };

      let wirePayload = innerPlain;
      if (
        contactWantsOutgoingE2ee(contactsRef, peerId)
        && (innerPlain.kind === 'chat' || innerPlain.kind === 'file' || innerPlain.kind === 'contact-share' || innerPlain.kind === 'sticker')
      ) {
        await waitForE2eeIdentity(ownEcdhPublicSpkiRef);
        let session = e2eeSessionsRef.current[peerId];
        const ready = e2eeReadyPeersRef.current.has(peerId);
        if (!session?.aesKey || !session.keyId || !ready || session.keyChanged === true) {
          await sendE2eeHandshake(peerId, { force: true, requestReply: true });
          session = await waitForE2eeSession(
            e2eeSessionsRef,
            e2eeReadyPeersRef,
            peerId,
            '',
            8000
          );
        }

        if (!session?.aesKey || !session.keyId || session.keyChanged === true) {
          inboundToastRef.current?.({
            variant: 'error',
            title: 'E2EE nicht bereit',
            message: 'Die Nachricht wurde nicht als Klartext gesendet. Prüfe die Verbindung oder bestätige einen erwarteten Schlüsselwechsel, indem du E2EE aus- und wieder einschaltest.',
          });
          failScheduled();
          return false;
        }

        try {
          wirePayload = await encryptChatPayload(session.aesKey, innerPlain, {
            keyId: session.keyId,
            version: session.e2eeVersion === 2 ? 2 : 1,
          });
        } catch (e) {
          console.error('E2EE encrypt failed:', e);
          failScheduled();
          return false;
        }
      }

      const wire = {
        ...wirePayload,
        sender: settingsRef.current.displayName,
        messageId,
        timestamp: createdAt,
      };

      const isFile = innerPlain.kind === 'file' || innerPlain.kind === 'sticker';
      const deferDisk = isFile;

      try {
        let sent;
        let meta;

        if (isFile && deferDisk) {
          sent = await window.bluetalk.peer.send(peerId, wire);
          if (!sent) {
            failScheduled();
            return false;
          }
          meta = await window.bluetalk.messages.append(peerId, selfMessageFull);
        } else {
          const pair = await Promise.all([
            window.bluetalk.peer.send(peerId, wire),
            window.bluetalk.messages.append(peerId, selfMessageFull),
          ]);
          sent = pair[0];
          meta = pair[1];
          if (!sent) {
            failScheduled();
            return false;
          }
        }

        if (isFile && fileDataB64) {
          await applyMessagePatch(peerId, messageId, { fileData: fileDataB64, localPreviewUrl: undefined });
          revokePreview();
        }

        if (meta?.count) {
          setChatMeta((prev) => ({ ...prev, [peerId]: meta }));
        }

        const t = setTimeout(() => {
          deliveryTimersRef.current.delete(messageId);
          void applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled' });
        }, 8000);
        deliveryTimersRef.current.set(messageId, t);

        return true;
      } catch {
        failScheduled();
        return false;
      }
    })();

    return sendPromise;
  }, [settings.displayName, upsertContact, applyMessagePatch, sendE2eeHandshake, sendGroupPacket]);

  sendMessageRef.current = sendMessage;

  const markPeerChatViewed = useCallback((peerId, upToPeerMessageTimestamp) => {
    if (!peerId || typeof upToPeerMessageTimestamp !== 'number' || upToPeerMessageTimestamp <= 0) return;
    setChatLastViewedPeerTs((prev) => {
      const cur = typeof prev[peerId] === 'number' ? prev[peerId] : 0;
      if (upToPeerMessageTimestamp <= cur) return prev;
      const next = { ...prev, [peerId]: upToPeerMessageTimestamp };
      if (window.bluetalk) window.bluetalk.store.set('chatLastViewedPeerTs', next);
      return next;
    });
  }, []);

  const sendReadReceipt = useCallback(async (peerId, lastReadMessageId) => {
    if (!window.bluetalk || !peerId || !lastReadMessageId) return;
    if (isGroupChatId(peerId)) {
      if (!settings.sendReadReceipts) return;
      const group = groupsRef.current.find((entry) => entry.id === peerId);
      const message = (messageCacheRef.current[peerId] || []).find((entry) => entry.messageId === lastReadMessageId);
      if (!group || !message?.senderPeerId || message.from === 'self') return;
      const receipt = {
        kind: GROUP_RECEIPT_KIND,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        groupId: peerId,
        refMessageId: lastReadMessageId,
        senderPeerId: ownPeerIdRef.current,
        status: 'seen',
        receivedAt: Date.now(),
      };
      await sendGroupPacket(message.senderPeerId, receipt, {
        packetId: `seen:${lastReadMessageId}`,
        groupId: peerId,
        type: 'receipt',
        queue: false,
      });
      return;
    }
    if (contactsRef.current.some((c) => c?.id === peerId && c.blocked === true)) return;
    if (!settings.sendReadReceipts) return;
    try {
      const sent = await window.bluetalk.peer.send(peerId, {
        kind: 'read-receipt',
        lastReadMessageId,
        sender: settings.displayName,
      });
      if (!sent) {
        console.warn('[App] Read receipt failed to send to', peerId);
      }
    } catch (err) {
      console.warn('[App] Read receipt error:', err.message);
    }
  }, [settings.displayName, settings.sendReadReceipts, sendGroupPacket]);

  const connectToAddress = useCallback(async (address) => {
    if (!window.bluetalk || !address?.trim()) {
      throw new Error('Address is required');
    }

    const peerInfo = await window.bluetalk.peer.connect(address.trim());
    upsertContact({
      id: peerInfo.id,
      name: peerInfo.name || peerInfo.id,
      address: address.trim(),
      hasOutgoing: true,
      bio: peerInfo.bio,
      profilePicture: peerInfo.profilePicture,
    });

    return peerInfo;
  }, [upsertContact]);

  useEffect(() => {
    if (!window.bluetalk?.on || !window.bluetalk?.agent?.sendMessageReply) return undefined;
    const unsubSend = window.bluetalk.on('agent:send-message', async (payload) => {
      const { requestId, peerId, content, replyTo } = payload || {};
      let result = { ok: false, error: 'invalid_request' };
      try {
        const outgoing = { kind: 'chat', content: String(content || '') };
        if (replyTo && typeof replyTo === 'object') {
          outgoing.replyTo = replyTo;
        }
        const sent = await sendMessageRef.current?.(peerId, outgoing);
        if (sent && typeof sent === 'object') {
          result = sent.ok === false ? sent : { ok: true, ...sent };
        } else {
          result = { ok: sent === true };
        }
      } catch (e) {
        result = { ok: false, error: e?.message || 'send_failed' };
      }
      window.bluetalk.agent.sendMessageReply({ requestId, result });
    });
    const unsubConnect = window.bluetalk?.agent?.connectPeerReply
      ? window.bluetalk.on('agent:connect-peer', async (payload) => {
        const { requestId, address } = payload || {};
        let result = { ok: false, error: 'invalid_request' };
        try {
          const peerInfo = await connectToAddress(address);
          result = {
            ok: true,
            peer: {
              id: peerInfo?.id,
              name: peerInfo?.name || peerInfo?.id,
              address: String(address || '').trim(),
            },
          };
        } catch (e) {
          result = { ok: false, error: e?.message || 'connect_failed' };
        }
        window.bluetalk.agent.connectPeerReply({ requestId, result });
      })
      : () => {};
    return () => {
      unsubSend?.();
      unsubConnect?.();
    };
  }, [connectToAddress]);

  const refreshDiscovery = useCallback(async () => {
    if (!window.bluetalk) return;
    await window.bluetalk.peer.refreshDiscovery();
    const list = await window.bluetalk.peer.getPeers();
    setPeers(list || []);
  }, []);

  const acceptMessageRequest = useCallback((peerId) => {
    if (!peerId) return;
    upsertContact({ id: peerId, pendingMessageRequest: false });
  }, [upsertContact]);

  const createGroupChat = useCallback(async ({ name, image = '', memberIds = [] }) => {
    const selfPeerId = ownPeerIdRef.current;
    if (!selfPeerId) throw new Error('identity_not_ready');
    const selected = [...new Set(memberIds.filter((id) => id && id !== selfPeerId))]
      .map((peerId) => {
        const contact = contactsRef.current.find((entry) => entry.id === peerId);
        return contact ? {
          peerId,
          displayName: contact.nickname || contact.name || peerId,
        } : null;
      })
      .filter(Boolean);
    const group = createGroupModel({
      name,
      image,
      creator: { peerId: selfPeerId, displayName: settingsRef.current.displayName },
      members: selected,
    });
    replaceGroup(group);
    for (const member of selected) {
      const invite = createGroupInviteEvent(group, selfPeerId, member.peerId);
      void sendGroupPacket(member.peerId, invite, {
        packetId: invite.eventId,
        groupId: group.id,
        type: 'control',
      });
    }
    return group;
  }, [replaceGroup, sendGroupPacket]);

  const updateGroupChat = useCallback(async (groupId, patch = {}) => {
    const selfPeerId = ownPeerIdRef.current;
    const current = groupsRef.current.find((group) => group.id === groupId);
    if (!current) throw new Error('unknown_group');
    if (!isGroupAdmin(current, selfPeerId)) throw new Error('admin_required');
    const addIds = [...new Set((patch.addMemberIds || []).filter(Boolean))];
    const removeIds = new Set((patch.removeMemberIds || []).filter((id) => (
      id && id !== selfPeerId && Boolean(getGroupMember(current, id))
    )));
    const existingIds = new Set(current.members.map((member) => member.peerId));
    const readdedIds = new Set(addIds.filter((peerId) => {
      const member = getGroupMember(current, peerId);
      return member && (member.state === 'left' || member.state === 'removed');
    }));
    const addedMembers = addIds
      .filter((peerId) => !existingIds.has(peerId))
      .map((peerId) => {
        const contact = contactsRef.current.find((entry) => entry.id === peerId);
        return contact ? {
          peerId,
          displayName: contact.nickname || contact.name || peerId,
          role: 'member',
          state: 'invited',
          addedAt: Date.now(),
        } : null;
      })
      .filter(Boolean);
    const now = Date.now();
    const next = normalizeGroup({
      ...current,
      name: Object.prototype.hasOwnProperty.call(patch, 'name') ? patch.name : current.name,
      image: Object.prototype.hasOwnProperty.call(patch, 'image') ? patch.image : current.image,
      revision: current.revision + 1,
      updatedAt: now,
      members: [
        ...current.members.map((member) => {
          if (removeIds.has(member.peerId)) return { ...member, state: 'removed', removedAt: now };
          if (readdedIds.has(member.peerId)) {
            const contact = contactsRef.current.find((entry) => entry.id === member.peerId);
            return {
              ...member,
              displayName: contact?.nickname || contact?.name || member.displayName,
              role: 'member',
              state: 'invited',
              addedAt: now,
              joinedAt: undefined,
              removedAt: undefined,
            };
          }
          return member;
        }),
        ...addedMembers,
      ],
    });
    const update = createGroupUpdateEvent(current, next, selfPeerId, patch.reason || 'group-info');
    replaceGroup(next);

    const newIds = new Set([...addedMembers.map((member) => member.peerId), ...readdedIds]);
    const existingRecipients = [...new Set([
      ...groupPeerIds(current, { excludePeerId: selfPeerId, includeInvited: true }),
      ...removeIds,
    ])].filter((peerId) => !newIds.has(peerId));
    for (const recipientId of existingRecipients) {
      void sendGroupPacket(recipientId, update, {
        packetId: update.eventId,
        groupId: next.id,
        type: 'control',
      });
    }
    for (const recipientId of newIds) {
      const invite = createGroupInviteEvent(next, selfPeerId, recipientId);
      void sendGroupPacket(recipientId, invite, {
        packetId: invite.eventId,
        groupId: next.id,
        type: 'control',
      });
    }
    return next;
  }, [replaceGroup, sendGroupPacket]);

  const leaveGroupChat = useCallback(async (groupId) => {
    const selfPeerId = ownPeerIdRef.current;
    const current = groupsRef.current.find((group) => group.id === groupId);
    if (!current || !isActiveGroupMember(current, selfPeerId)) throw new Error('active_member_required');
    const leave = createGroupLeaveEvent(current, selfPeerId);
    const otherActive = current.members.filter((member) => member.peerId !== selfPeerId && member.state === 'active');
    const wasAdmin = isGroupAdmin(current, selfPeerId);
    const hasOtherAdmin = otherActive.some((member) => member.role === 'admin');
    const now = Date.now();
    let members = current.members.map((member) => member.peerId === selfPeerId
      ? { ...member, state: 'left', removedAt: now }
      : member);
    if (wasAdmin && !hasOtherAdmin && otherActive[0]) {
      members = members.map((member) => member.peerId === otherActive[0].peerId
        ? { ...member, role: 'admin' }
        : member);
    }
    const next = normalizeGroup({ ...current, revision: current.revision + 1, updatedAt: now, members });
    replaceGroup(next);

    if (wasAdmin) {
      const update = createGroupUpdateEvent(current, next, selfPeerId, 'member-left');
      for (const recipientId of otherActive.map((member) => member.peerId)) {
        void sendGroupPacket(recipientId, update, {
          packetId: update.eventId,
          groupId,
          type: 'control',
        });
      }
    } else {
      const admins = current.members.filter((member) => member.state === 'active' && member.role === 'admin');
      for (const admin of admins) {
        void sendGroupPacket(admin.peerId, leave, {
          packetId: leave.eventId,
          groupId,
          type: 'control',
        });
      }
    }
    return next;
  }, [replaceGroup, sendGroupPacket]);

  const setContactNickname = useCallback((contactId, nickname) => {
    if (!contactId) return;
    upsertContact({ id: contactId, nickname: (nickname || '').trim() });
  }, [upsertContact]);

  const setChatPinned = useCallback((contactId, pinned) => {
    if (!contactId) return;
    upsertContact({ id: contactId, pinned: Boolean(pinned) });
  }, [upsertContact]);

  const setContactE2eeEnabled = useCallback((contactId, enabled) => {
    if (!contactId) return;
    const nextEnabled = Boolean(enabled);
    upsertContact({ id: contactId, e2eeEnabled: nextEnabled });
    if (nextEnabled) {
      const next = { ...e2eeSessionsRef.current };
      delete next[contactId];
      e2eeSessionsRef.current = next;
      e2eeReadyPeersRef.current.delete(contactId);
      e2eeHandshakeSentRef.current.delete(contactId);
      void persistE2eeSessionsMap(e2eeSessionsRef);
      void sendE2eeHandshake(contactId, { force: true });
    }
  }, [upsertContact, sendE2eeHandshake]);

  /**
   * @param {string} contactId
   * @param {{ clear?: boolean, manual?: boolean, until?: number }} opts
   *   clear: Mitteilungen wieder an; manual: stumm bis manuell aufheben; until: Stummschaltung bis Zeitstempel (ms)
   */
  const setContactNotificationMute = useCallback((contactId, opts = {}) => {
    if (!contactId) return;
    if (opts.clear) {
      upsertContact({ id: contactId, notifyMutedManual: false, notifyMutedUntil: undefined });
      return;
    }
    if (opts.manual === true) {
      upsertContact({ id: contactId, notifyMutedManual: true, notifyMutedUntil: undefined });
      return;
    }
    if (typeof opts.until === 'number') {
      upsertContact({ id: contactId, notifyMutedManual: false, notifyMutedUntil: opts.until });
    }
  }, [upsertContact]);

  const setContactBlocked = useCallback((contactId, blocked) => {
    if (!contactId) return;
    upsertContact({ id: contactId, blocked: Boolean(blocked) });
    if (window.bluetalk) {
      void window.bluetalk.peer.send(contactId, {
        kind: 'contact-blocked',
        blocked: Boolean(blocked),
        sender: settingsRef.current.displayName,
      }).catch(() => {});
    }
    if (blocked) {
      const next = { ...e2eeSessionsRef.current };
      delete next[contactId];
      e2eeSessionsRef.current = next;
      e2eeReadyPeersRef.current.delete(contactId);
      e2eeHandshakeSentRef.current.delete(contactId);
      e2eeHandshakePromisesRef.current.delete(contactId);
      void persistE2eeSessionsMap(e2eeSessionsRef);
    } else if (window.bluetalk && ownEcdhPublicSpkiRef.current && contactWantsOutgoingE2ee(contactsRef, contactId)) {
      e2eeHandshakeSentRef.current.delete(contactId);
      void sendE2eeHandshake(contactId, { force: true });
    }
  }, [upsertContact, sendE2eeHandshake]);

  const removeContact = useCallback((contactId) => {
    setContacts((prev) => {
      const updated = prev.filter((c) => c.id !== contactId);
      if (window.bluetalk) window.bluetalk.store.set('contacts', updated);
      return updated;
    });
  }, []);

  const deleteMessage = useCallback(async (peerId, messageId) => {
    if (!window.bluetalk || !peerId || !messageId) return false;
    const deleted = await window.bluetalk.messages.deleteMessage(peerId, messageId);
    if (!deleted) return false;

    setMessages((prev) => {
      const list = prev[peerId] || [];
      const updated = list.filter((m) => m.messageId !== messageId);
      messageCacheRef.current = { ...messageCacheRef.current, [peerId]: updated };
      return { ...prev, [peerId]: updated };
    });

    setChatMeta((prev) => {
      const meta = prev[peerId];
      if (!meta) return prev;
      const newCount = Math.max(0, (meta.count || 1) - 1);
      return {
        ...prev,
        [peerId]: {
          ...meta,
          count: newCount,
          lastMessage: meta.lastMessage?.messageId === messageId ? null : meta.lastMessage,
        },
      };
    });

    return true;
  }, []);

  const deleteChat = useCallback(async (peerId) => {
    if (!window.bluetalk || !peerId) return false;

    if (!isAiChatPeerId(peerId) && !isGroupChatId(peerId)) {
      try {
        await window.bluetalk.peer.send(peerId, {
          kind: 'chat-deleted',
          sender: settingsRef.current.displayName,
        });
      } catch {
        /* Peer evtl. offline */
      }
    }

    await window.bluetalk.messages.deleteChat(peerId);
    setPeerReadReceipts((prev) => {
      const next = { ...prev };
      delete next[peerId];
      if (window.bluetalk) window.bluetalk.store.set('chatReadReceipts', next);
      return next;
    });
    setChatLastViewedPeerTs((prev) => {
      const next = { ...prev };
      delete next[peerId];
      if (window.bluetalk) window.bluetalk.store.set('chatLastViewedPeerTs', next);
      return next;
    });
    setMessages((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      messageCacheRef.current = updated;
      return updated;
    });
    setChatMeta((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setLoadedChats((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    if (isAiChatPeerId(peerId)) {
      const agents = await window.bluetalk.store.get('aiChat.agents', []);
      if (Array.isArray(agents)) {
        await window.bluetalk.store.set('aiChat.agents', agents.filter((agent) => agent?.id !== peerId));
      }
    } else if (!isGroupChatId(peerId)) {
      removeContact(peerId);
    }
    return true;
  }, [removeContact]);

  const deleteGroupChat = useCallback(async (groupId) => {
    if (!window.bluetalk || !groupId || !isGroupChatId(groupId)) return false;

    const current = groupsRef.current.find((group) => group.id === groupId);
    if (current && isActiveGroupMember(current, ownPeerIdRef.current)) {
      try {
        await leaveGroupChat(groupId);
      } catch {
        /* Austritt konnte nicht gemeldet werden – lokales Löschen trotzdem fortsetzen */
      }
    }

    removeGroup(groupId);
    persistGroupOutbox(groupOutboxRef.current.filter((entry) => entry.groupId !== groupId));
    await deleteChat(groupId);
    return true;
  }, [leaveGroupChat, removeGroup, persistGroupOutbox, deleteChat]);

  const joinGameFromPresence = useCallback(async (presence, hostPeerId) => {
    if (!presence || !hostPeerId) {
      return { ok: false, message: 'Spieldaten fehlen.' };
    }
    if (!canJoinGameViaPresence({ presence, gameInvites: gameInviteKeys, hostPeerId })) {
      return { ok: false, message: 'Diese Lobby kann derzeit nicht betreten werden.' };
    }
    const game = presence.game;
    const sessionId = presence.sessionId;
    if (!game || !sessionId) {
      return { ok: false, message: 'Die Spiel-ID fehlt.' };
    }

    const pending = game === 'poker'
      ? {
        hostPeerId,
        tableId: sessionId,
        tableName: presence.tableName || 'Poker-Tisch',
        pokerSettings: {},
      }
      : game === 'uno'
        ? {
          hostPeerId,
          gameId: sessionId,
          tableName: presence.tableName || 'UNO-Tisch',
          unoSettings: {},
        }
        : game === 'connect-four'
          ? {
            hostPeerId,
            gameId: sessionId,
            tableName: presence.tableName || 'Vier-gewinnt-Tisch',
            connectFourSettings: {},
          }
          : game === 'chess'
            ? {
              hostPeerId,
              gameId: sessionId,
              tableName: presence.tableName || 'Schach-Partie',
              chessSettings: {},
            }
            : game === 'tic-tac-toe'
              ? {
                hostPeerId,
                gameId: sessionId,
                tableName: presence.tableName || 'Tic-Tac-Toe',
                ticTacToeSettings: {},
              }
              : null;
    if (!pending) {
      return { ok: false, message: 'Dieses Spiel wird nicht unterstützt.' };
    }

    window.location.hash = '#/games';
    const response = await pluginRuntime.invokePluginCommand(game, 'join', pending);
    if (!response?.ok) {
      return {
        ok: false,
        message: response?.error === 'not_active'
          ? 'Aktiviere dieses Spiel zuerst unter Erweiterungen.'
          : response?.error === 'unknown_command'
            ? 'Das Spiele-Plugin ist veraltet. Bitte stelle es unter Erweiterungen auf Standard zurück.'
            : response?.error || 'Beitritt fehlgeschlagen.',
      };
    }
    return response.result?.ok === false ? response.result : { ok: true };
  }, [gameInviteKeys]);

  const updateSettings = useCallback((newSettings) => {
    setSettings((prev) => {
      const merged = { ...prev, ...newSettings };
      if (newSettings.uiResize && typeof newSettings.uiResize === 'object') {
        merged.uiResize = {
          ...(prev.uiResize || {}),
          ...newSettings.uiResize,
        };
      }
      if (newSettings.uiCollapse && typeof newSettings.uiCollapse === 'object') {
        merged.uiCollapse = {
          ...(prev.uiCollapse || {}),
          ...newSettings.uiCollapse,
        };
      }
      if (window.bluetalk) {
        window.bluetalk.store.set('settings', merged);
        const profileKeys = ['displayName', 'bio', 'profilePicture'];
        if (profileKeys.some((k) => Object.prototype.hasOwnProperty.call(newSettings, k))) {
          window.bluetalk.peer.broadcast({
            kind: 'profile',
            displayName: merged.displayName,
            bio: merged.bio || '',
            profilePicture: merged.profilePicture || '',
            sender: merged.displayName,
          });
        }
        if (Object.prototype.hasOwnProperty.call(newSettings, 'doNotDisturb')) {
          window.bluetalk.peer.broadcast(buildUserPresencePayload(merged));
        }
      }
      return merged;
    });
  }, []);

  const completeUsernameOnboarding = useCallback((name) => {
    updateSettings({ displayName: name, onboardingUsernameDone: true });
    setShowUsernameOnboarding(false);
  }, [updateSettings]);

  const cancelAiChat = useCallback(async () => {
    const requestId = activeAiChatRequestRef.current || aiChatProgress?.requestId;
    if (!requestId || !window.bluetalk?.ollama?.abortChat) return false;
    try {
      const result = await window.bluetalk.ollama.abortChat(requestId);
      return result?.ok === true;
    } catch {
      return false;
    }
  }, [aiChatProgress?.requestId]);

  const clearAiChatContext = useCallback(async (peerId) => {
    if (!window.bluetalk || !peerId || !isAiChatPeerId(peerId)) return false;

    if (aiChatPendingPeerId === peerId) {
      await cancelAiChat();
    }

    await window.bluetalk.messages.deleteChat(peerId);
    if (window.bluetalk.ollama?.clearAgentContext) {
      await window.bluetalk.ollama.clearAgentContext(peerId);
    }

    setMessages((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      messageCacheRef.current = updated;
      return updated;
    });
    setChatMeta((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setLoadedChats((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setAiChatProgress((current) => (current?.peerId === peerId ? null : current));
    setAiChatPendingPeerId((current) => (current === peerId ? null : current));

    return true;
  }, [aiChatPendingPeerId, cancelAiChat]);

  const versionWelcomeNotes = getReleaseNotesForVersion(APP_VERSION);

  const isAiChatPending = useCallback(
    (peerId) => Boolean(peerId && aiChatPendingPeerId === peerId),
    [aiChatPendingPeerId]
  );

  // Memoisiert, damit nicht jeder App-Render alle useApp-Consumer neu rendert
  // (z. B. ~60/s während KI-Streaming). Deps müssen JEDEN referenzierten Wert enthalten.
  const ctx = useMemo(() => ({
    peers,
    contacts,
    groups,
    ownPeerId,
    chatMeta,
    loadedChats,
    messages,
    aiChatProgress,
    aiChatPendingPeerId,
    isAiChatPending,
    settings,
    theme,
    peerCount: peers.length,
    peerReadReceipts,
    chatLastViewedPeerTs,
    peerGamePresence,
    peerUserPresence,
    gameInviteKeys,
    joinGameFromPresence,
    markPeerChatViewed,
    sendMessage,
    cancelAiChat,
    clearAiChatContext,
    sendReadReceipt,
    loadChatMessages,
    connectToAddress,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
    deleteGroupChat,
    refreshDiscovery,
    setContactNickname,
    setChatPinned,
    setContactE2eeEnabled,
    deleteMessage,
    deleteChat,
    removeContact,
    updateSettings,
    toggleTheme,
    upsertContact,
    acceptMessageRequest,
    setContactBlocked,
    setContactNotificationMute,
  }), [
    peers,
    contacts,
    groups,
    ownPeerId,
    chatMeta,
    loadedChats,
    messages,
    aiChatProgress,
    aiChatPendingPeerId,
    isAiChatPending,
    settings,
    theme,
    peerReadReceipts,
    chatLastViewedPeerTs,
    peerGamePresence,
    peerUserPresence,
    gameInviteKeys,
    joinGameFromPresence,
    markPeerChatViewed,
    sendMessage,
    cancelAiChat,
    clearAiChatContext,
    sendReadReceipt,
    loadChatMessages,
    connectToAddress,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
    deleteGroupChat,
    refreshDiscovery,
    setContactNickname,
    setChatPinned,
    setContactE2eeEnabled,
    deleteMessage,
    deleteChat,
    removeContact,
    updateSettings,
    toggleTheme,
    upsertContact,
    acceptMessageRequest,
    setContactBlocked,
    setContactNotificationMute,
  ]);

  const peersRef = useRef(peers);
  const messagesRef = useRef(messages);
  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!window.bluetalk?.plugins) return undefined;
    let cancelled = false;
    const host = {
      getOwnPeerId: () => ownPeerIdRef.current,
      getPeers: () => peersRef.current,
      getContacts: () => contactsRef.current,
      getMessages: (peerId) => (peerId ? messagesRef.current[peerId] || [] : messagesRef.current),
      sendMessage,
      deleteMessage,
      deleteChat,
      upsertContact,
      removeContact,
      setContactBlocked,
      setContactNickname,
      setChatPinned,
      toast: null,
    };
    pluginRuntime.setHost(host);
    pluginRuntime.injectReact(React, ReactDOM);
    void (async () => {
      if (!ownPeerIdRef.current) {
        try {
          const info = await window.bluetalk.peer.getInfo();
          ownPeerIdRef.current = info?.id || '';
          if (!cancelled) setOwnPeerId(info?.id || '');
        } catch {
          /* Realtime liest die ID später erneut aus dem aktuellen Ref. */
        }
      }
      if (!cancelled) await pluginRuntime.boot(host);
    })();
    return () => { cancelled = true; };
  }, [sendMessage, deleteMessage, deleteChat, upsertContact, removeContact, setContactBlocked, setContactNickname, setChatPinned]);

  if (!window.bluetalk) {
    return (
      <AppContext.Provider value={ctx}>
        <ToastProvider solidBottomRight>
          <InboundToastBridge toastRef={inboundToastRef} />
          <RuntimeUnavailablePage />
        </ToastProvider>
      </AppContext.Provider>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      <ToastProvider solidBottomRight>
        <ErrorBoundary>
            <HashRouter>
            <InboundToastBridge toastRef={inboundToastRef} />
            <PluginRuntimeToastBridge />
            <Suspense fallback={<div className="page"><div className="page-body">Wird geladen…</div></div>}>
            <Routes>
              <Route path="/docs/*" element={<DocsPage />} />
              <Route
                path="*"
                element={(
            <div className="app">
              <UsernameOnboardingModal
                open={showUsernameOnboarding}
                onSubmit={completeUsernameOnboarding}
              />
              <VersionWelcomeModal
                open={Boolean(versionWelcomeNotes && showVersionWelcome)}
                title={versionWelcomeNotes?.title}
                items={versionWelcomeNotes?.items}
                onContinue={dismissVersionWelcome}
              />
              <TitleBar />
              {loadError ? (
                <div className="app-banner app-banner--error" role="alert">
                  <span>{loadError}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLoadError('')}>
                    Dismiss
                  </button>
                </div>
              ) : null}
              <div className="app-body">
                <Sidebar />
                <main className="content">
                  <Routes>
                    <Route path="/" element={<ChatsPage />} />
                    <Route path="/new" element={<NewConnectionsPage />} />
                    <Route path="/library" element={<LibraryPage />} />
                    <Route path="/documents" element={<DocumentsLauncherPage />} />
                    <Route path="/games" element={<GamesPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/settings/account" element={<AccountSettingsPage />} />
                    <Route path="/settings/connection" element={<ConnectionSettingsPage />} />
                    <Route path="/settings/updates" element={<UpdatesSettingsPage />} />
                    <Route path="/settings/application" element={<ApplicationSettingsPage />} />
                    <Route path="/settings/stickers" element={<StickersSettingsPage />} />
                    <Route path="/settings/ai" element={<AiSettingsPage />} />
                    <Route path="/cloud-sync" element={<CloudSyncPage />} />
                    <Route path="/plugins" element={<PluginsPage />} />
                    <Route path="/plugin/:tabId" element={<PluginTabView />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </main>
              </div>
              <PluginScreenHost />
              <AgentAskUserModal
                open={Boolean(agentAskUser)}
                question={agentAskUser?.question}
                onSubmit={(answer) => {
                  const rid = agentAskUser?.requestId;
                  if (rid) window.bluetalk?.ollama?.replyAskUser?.(rid, answer);
                  setAgentAskUser(null);
                }}
                onCancel={() => {
                  const rid = agentAskUser?.requestId;
                  if (rid) window.bluetalk?.ollama?.replyAskUser?.(rid, '');
                  setAgentAskUser(null);
                }}
              />
            </div>
                )}
              />
            </Routes>
            </Suspense>
          </HashRouter>
        </ErrorBoundary>
      </ToastProvider>
    </AppContext.Provider>
  );
}
