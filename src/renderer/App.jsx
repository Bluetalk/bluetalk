import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, startTransition, createContext, useContext, lazy, Suspense } from 'react';
import ReactDOM from 'react-dom';
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import { MessageCircle, Settings as SettingsIcon, UserPlus, Minus, Maximize2, SquareStack, X, Blocks, Plug, FolderOpen, Palette, Sparkles, Spade, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

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
import { isContactNotificationMuted } from './contactNotificationMute';
import { buildMessageNotificationPreview } from './utils/messageNotificationPreview';

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
const NotFoundPage = lazy(() => import('./pages/NotFound'));
const PluginsPage = lazy(() => import('./pages/Plugins'));
const PluginTabView = lazy(() => import('./plugins/PluginTabView'));
const PokerGamePage = lazy(() => import('./pages/PokerGamePage'));
const UnoGamePage = lazy(() => import('./pages/UnoGamePage'));

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
  const [chatMeta, setChatMeta] = useState({});
  const [loadedChats, setLoadedChats] = useState({});
  const [messages, setMessages] = useState({});
  const [aiChatProgress, setAiChatProgress] = useState(null);
  const [aiChatPendingPeerId, setAiChatPendingPeerId] = useState(null);
  const [agentAskUser, setAgentAskUser] = useState(null);
  const [theme, setTheme] = useState('dark');
  const [settings, setSettings] = useState({ ...DEFAULT_APP_SETTINGS });
  const messageCacheRef = useRef({});
  const deliveryTimersRef = useRef(new Map());
  const activeAiChatRequestRef = useRef(null);
  const settingsRef = useRef(settings);
  const contactsRef = useRef([]);
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
        if (!blocked && ownEcdhPublicSpkiRef.current && contactWantsOutgoingE2ee(contactsRef, peer.id)) {
          void sendE2eeHandshake(peer.id);
        }
      })
    );

    unsubs.push(
      window.bluetalk.on('peer:disconnected', (peerId) => {
        e2eeReadyPeersRef.current.delete(peerId);
        e2eeHandshakeSentRef.current.delete(peerId);
        e2eeHandshakePromisesRef.current.delete(peerId);
        setPeers((prev) => prev.filter((p) => p.id !== peerId));
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
          upsertContact({ id: fromId, chatDeletedByPeer: true });
          inboundToastRef.current?.({
            variant: 'info',
            title: 'Chat gelöscht',
            message: `${msg.sender || fromId} hat den Chat gelöscht. Du kannst den Verlauf exportieren oder lokal entfernen.`,
          });
          return;
        }

        if (msg.kind === 'messaging-blocked' && msg.refMessageId && fromId) {
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

        if (isBlocked) {
          const k = msg.kind;
          const blockable =
            k === 'chat' || k === 'file' || k === 'sticker' || k === 'encrypted-chat-e2ee' || k === 'poker-invite' || k === 'uno-invite' || k === 'contact-share';
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
            const contact = contactsRef.current.find((entry) => entry?.id === fromId);
            if (!isContactNotificationMuted(contact)) {
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
        const [storedContacts, storedChatMeta, storedSettings, storedReadReceipts, currentPeers] = await Promise.all([
          window.bluetalk.store.get('contacts', []),
          window.bluetalk.messages.getMeta(),
          window.bluetalk.store.get('settings', {}),
          window.bluetalk.store.get('chatReadReceipts', {}),
          window.bluetalk.peer.getPeers(),
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
  }, [upsertContact, applyContactPatch, applyMessagePatch, sendE2eeHandshake]);

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
        ownEcdhPrivateRef.current = null;
        ownEcdhPublicSpkiRef.current = '';
        e2eeSessionsRef.current = {};
        e2eeReadyPeersRef.current.clear();
        e2eeHandshakeSentRef.current.clear();
        e2eeHandshakePromisesRef.current.clear();
        setE2eeBootNonce((n) => n + 1);
        setUsernameOnboardingGateReady(true);
        setShowUsernameOnboarding(true);
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
    setTheme((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      if (window.bluetalk) window.bluetalk.store.set('settings.theme', next);
      return next;
    });
  }, []);

  const sendMessage = useCallback((peerId, payload) => {
    if (!window.bluetalk || !peerId) return Promise.resolve(false);

    if (isAiChatPeerId(peerId)) {
      const outgoing = typeof payload === 'string'
        ? { kind: 'chat', content: payload }
        : { kind: 'chat', ...payload };

      if (outgoing.kind !== 'chat' || !String(outgoing.content || '').trim()) {
        return Promise.resolve(false);
      }

      const messageId = newChatMessageId();
      const createdAt = Date.now();
      const selfMessage = {
        ...outgoing,
        sender: settings.displayName,
        messageId,
        timestamp: createdAt,
        from: 'self',
        deliveryStatus: 'pending',
      };

      startTransition(() => {
        setMessages((prev) => ({
          ...prev,
          [peerId]: [...(prev[peerId] || []), selfMessage],
        }));
        setChatMeta((prev) => ({
          ...prev,
          [peerId]: {
            count: (prev[peerId]?.count || 0) + 1,
            lastMessage: selfMessage,
          },
        }));
      });

      return (async () => {
        if (activeAiChatRequestRef.current) {
          return { ok: false, error: 'chat_busy' };
        }

        try {
          const meta = await window.bluetalk.messages.append(peerId, selfMessage);
          if (meta?.count) {
            setChatMeta((prev) => ({ ...prev, [peerId]: meta }));
          }
          await applyMessagePatch(peerId, messageId, { deliveryStatus: 'delivered' });
          setMessages((prev) => {
            const list = prev[peerId] || [];
            return {
              ...prev,
              [peerId]: list.map((item) =>
                item?.messageId === messageId ? { ...item, deliveryStatus: 'delivered' } : item
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
            const toolEvents = Array.isArray(update.toolResults) && update.toolResults?.length
              ? [...(lastAiUpdate.toolEvents || []), ...update.toolResults]
              : (lastAiUpdate.toolEvents || []);
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
              { peerId, prompt: outgoing.content, requestId },
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
            await applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled' });
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
            await applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled' });
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
  }, [settings.displayName, upsertContact, applyMessagePatch, sendE2eeHandshake]);

  sendMessageRef.current = sendMessage;

  useEffect(() => {
    if (!window.bluetalk?.on || !window.bluetalk?.agent?.sendMessageReply) return undefined;
    const unsub = window.bluetalk.on('agent:send-message', async (payload) => {
      const { requestId, peerId, content } = payload || {};
      let result = { ok: false, error: 'invalid_request' };
      try {
        const sent = await sendMessageRef.current?.(peerId, { kind: 'chat', content: String(content || '') });
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
    return unsub;
  }, []);

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
  }, [settings.displayName, settings.sendReadReceipts]);

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

    if (!isAiChatPeerId(peerId)) {
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
    } else {
      removeContact(peerId);
    }
    return true;
  }, [removeContact]);

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

  const ctx = {
    peers,
    contacts,
    chatMeta,
    loadedChats,
    messages,
    aiChatProgress,
    aiChatPendingPeerId,
    isAiChatPending: (peerId) => Boolean(peerId && aiChatPendingPeerId === peerId),
    settings,
    theme,
    peerCount: peers.length,
    peerReadReceipts,
    chatLastViewedPeerTs,
    markPeerChatViewed,
    sendMessage,
    cancelAiChat,
    clearAiChatContext,
    sendReadReceipt,
    loadChatMessages,
    connectToAddress,
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
  };

  const peersRef = useRef(peers);
  const messagesRef = useRef(messages);
  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!window.bluetalk?.plugins) return undefined;
    pluginRuntime.setHost({
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
    });
    pluginRuntime.injectReact(React, ReactDOM);
    void pluginRuntime.boot();
    return undefined;
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
              <Route path="/poker-game" element={<PokerGamePage />} />
              <Route path="/uno-game" element={<UnoGamePage />} />
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
