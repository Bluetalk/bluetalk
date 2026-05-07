import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, startTransition, createContext, useContext } from 'react';
import ReactDOM from 'react-dom';
import { HashRouter, Routes, Route, NavLink } from 'react-router-dom';
import * as LucideIcons from 'lucide-react';
import { MessageCircle, Settings as SettingsIcon, UserPlus, Minus, Maximize2, SquareStack, X, Plug } from 'lucide-react';

import ChatsPage from './pages/Chats';
import SettingsPage from './pages/Settings';
import NewConnectionsPage from './pages/NewConnections';
import CloudSyncPage from './pages/CloudSync';
import NotFoundPage from './pages/NotFound';
import PluginsPage from './pages/Plugins';
import RuntimeUnavailablePage from './pages/RuntimeUnavailable';
import NotificationCenter from './components/NotificationCenter';
import ProfileMenu from './components/ProfileMenu';
import { ToastProvider, useToast } from './components/ToastProvider';
import PluginTabView from './plugins/PluginTabView';
import PluginScreenHost from './plugins/PluginScreenHost';
import PokerGamePage from './pages/PokerGamePage';
import { pluginRuntime } from './plugins/pluginRuntime';
import ErrorBoundary from './components/ErrorBoundary';
import VersionWelcomeModal from './components/VersionWelcomeModal';
import UsernameOnboardingModal from './components/UsernameOnboardingModal';
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
} from './chatCrypto';
import { mergeFeatureFlagDefaults, getEffectiveFlag } from './featureFlags';
import VerticalResizeHandle from './components/VerticalResizeHandle';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
const CHAT_MESSAGE_BATCH_SIZE = 24;

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
  featureFlags: mergeFeatureFlagDefaults(),
  /** Gespeicherte Panel-Breiten (Pixel), nur wirksam mit Feature-Flag `resizableUi`. */
  uiResize: {},
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

async function persistE2eeSessionsMap(sessionsRef) {
  if (!window.bluetalk) return;
  const out = {};
  for (const [peerId, row] of Object.entries(sessionsRef.current || {})) {
    if (row?.aesKey) {
      out[peerId] = { aesKeyB64: await exportAesKeyToB64(row.aesKey) };
    }
  }
  window.bluetalk.store.set('e2eeSessions', out);
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
  const { peerCount } = useApp();
  const [isMaximized, setIsMaximized] = useState(false);

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
  const direct = LucideIcons[name];
  if (direct) return direct;
  const camel = name.charAt(0).toUpperCase() + name.slice(1);
  return LucideIcons[camel] || Plug;
}

const SIDEBAR_WIDTH_DEFAULT = 56;
const SIDEBAR_WIDTH_MIN = 56;
const SIDEBAR_WIDTH_MAX = 280;

function Sidebar() {
  const { settings, updateSettings } = useApp();
  const resizableUi = getEffectiveFlag(settings, 'resizableUi');
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

  const sidebarDisplayWidth = resizableUi ? sidebarPreview ?? sidebarCommitted : undefined;

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
    { to: '/plugins', label: 'Plugins', icon: Plug },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <>
      <nav
        className={`sidebar${resizableUi ? ' sidebar--resizable' : ''}`}
        style={sidebarDisplayWidth != null ? { width: sidebarDisplayWidth } : undefined}
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
                <span>{tab.label}</span>
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
      {resizableUi ? (
        <VerticalResizeHandle
          onBegin={onSidebarResizeBegin}
          onDelta={onSidebarResizeDelta}
          onCommit={commitSidebarWidth}
          onDoubleClick={resetSidebarWidth}
        />
      ) : null}
    </>
  );
}

export default function App() {
  const [peers, setPeers] = useState([]);
  const [contacts, setContacts] = useState([]);
  const [chatMeta, setChatMeta] = useState({});
  const [loadedChats, setLoadedChats] = useState({});
  const [messages, setMessages] = useState({});
  const [theme, setTheme] = useState('dark');
  const [settings, setSettings] = useState({ ...DEFAULT_APP_SETTINGS });
  const messageCacheRef = useRef({});
  const deliveryTimersRef = useRef(new Map());
  const settingsRef = useRef(settings);
  const contactsRef = useRef([]);
  const ownEcdhPrivateRef = useRef(null);
  const ownEcdhPublicSpkiRef = useRef('');
  const e2eeSessionsRef = useRef({});
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
        if (cancelled) return;
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          identity.privateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits']
        );
        ownEcdhPrivateRef.current = privateKey;
        ownEcdhPublicSpkiRef.current = identity.publicSpkiB64;

        const storedSessions = await window.bluetalk.store.get('e2eeSessions', {});
        const next = {};
        if (storedSessions && typeof storedSessions === 'object') {
          for (const [pid, row] of Object.entries(storedSessions)) {
            if (row?.aesKeyB64) {
              try {
                next[pid] = { aesKey: await importAesKeyFromRawB64(row.aesKeyB64) };
              } catch {
                /* skip corrupt row */
              }
            }
          }
        }
        if (!cancelled) e2eeSessionsRef.current = next;

        if (!cancelled && window.bluetalk?.peer?.getPeers && ownEcdhPublicSpkiRef.current) {
          try {
            const peerList = await window.bluetalk.peer.getPeers();
            for (const p of peerList || []) {
              if (!p?.id) continue;
              if (!contactWantsOutgoingE2ee(contactsRef, p.id)) continue;
              if (contactsRef.current.some((c) => c?.id === p.id && c.blocked === true)) continue;
              void window.bluetalk.peer.send(p.id, {
                kind: 'e2ee-key-handshake',
                publicSpkiB64: ownEcdhPublicSpkiRef.current,
                sender: settingsRef.current.displayName,
              });
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
  }, [e2eeBootNonce]);

  useEffect(() => () => {
    for (const t of deliveryTimersRef.current.values()) {
      clearTimeout(t);
    }
    deliveryTimersRef.current.clear();
  }, []);

  const upsertContact = useCallback((patch) => {
    if (!patch?.id) return;
    setContacts((prev) => {
      const idx = prev.findIndex((c) => c.id === patch.id);
      const merged = idx >= 0
        ? { ...prev[idx], ...patch }
        : { id: patch.id, addedAt: Date.now(), ...patch };

      const updated = idx >= 0
        ? prev.map((contact, i) => (i === idx ? merged : contact))
        : [...prev, merged];

      if (window.bluetalk) window.bluetalk.store.set('contacts', updated);
      return updated;
    });
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
          void window.bluetalk.peer.send(peer.id, {
            kind: 'e2ee-key-handshake',
            publicSpkiB64: ownEcdhPublicSpkiRef.current,
            sender: settingsRef.current.displayName,
          });
        }
      })
    );

    unsubs.push(
      window.bluetalk.on('peer:disconnected', (peerId) => {
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
            const peerPub = await importPeerPublicFromSpki(msg.publicSpkiB64);
            const aesKey = await deriveSharedAesKey(ownEcdhPrivateRef.current, peerPub);
            e2eeSessionsRef.current = { ...e2eeSessionsRef.current, [fromId]: { aesKey } };
            await persistE2eeSessionsMap(e2eeSessionsRef);
            void window.bluetalk.peer.send(fromId, {
              kind: 'e2ee-key-handshake',
              publicSpkiB64: ownEcdhPublicSpkiRef.current,
              sender: settingsRef.current.displayName,
            });
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

        if (isBlocked) {
          const k = msg.kind;
          const blockable =
            k === 'chat' || k === 'file' || k === 'encrypted-chat-e2ee' || k === 'poker-invite';
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
          const session = e2eeSessionsRef.current[fromId];
          if (!session?.aesKey) {
            return;
          }
          try {
            const inner = await decryptChatPayload(session.aesKey, msg);
            normalized = {
              ...inner,
              messageId: inner.messageId || normalized.messageId,
              timestamp: typeof inner.timestamp === 'number' ? inner.timestamp : normalized.timestamp,
              from: fromId,
            };
          } catch (e) {
            console.error('E2EE decrypt failed:', e);
            return;
          }
        }

        if ((normalized.kind === 'chat' || normalized.kind === 'file') && normalized.messageId && fromId) {
          void window.bluetalk.peer.send(fromId, {
            kind: 'delivery-receipt',
            refMessageId: normalized.messageId,
            receivedAt: Date.now(),
            sender: settingsRef.current.displayName,
          });
        }

        const meta = await window.bluetalk.messages.append(fromId, normalized);

        upsertContact({ id: fromId, blockedByPeer: false });

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
            const idx = prev.findIndex((c) => c.id === fromId);
            const existing = idx >= 0 ? prev[idx] : null;
            const hasOutgoing = existing?.hasOutgoing === true;
            const requestCleared = existing?.pendingMessageRequest === false;
            const merged = {
              ...(existing || { id: fromId, addedAt: Date.now() }),
              name: normalized.sender || existing?.name || fromId,
              pendingMessageRequest: hasOutgoing || requestCleared ? false : true,
            };
            const updated = idx >= 0
              ? prev.map((c, i) => (i === idx ? merged : c))
              : [...prev, merged];
            if (window.bluetalk) window.bluetalk.store.set('contacts', updated);
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
        mergedSettings.featureFlags = mergeFeatureFlagDefaults(stored.featureFlags);
        mergedSettings.uiResize = {
          ...(DEFAULT_APP_SETTINGS.uiResize || {}),
          ...(stored.uiResize && typeof stored.uiResize === 'object' ? stored.uiResize : {}),
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
  }, [upsertContact, applyMessagePatch]);

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
      }
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

    if (contactsRef.current.some((c) => c?.id === peerId && c.blocked === true)) {
      return Promise.resolve(false);
    }

    const outgoing = typeof payload === 'string'
      ? { kind: 'chat', content: payload }
      : { kind: 'chat', ...payload };

    const localPreviewUrl = outgoing.kind === 'file' ? outgoing.localPreviewUrl : undefined;
    const fileDataB64 = outgoing.kind === 'file' ? outgoing.fileData : undefined;

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
      innerPlain.kind === 'file'
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
      if (contactWantsOutgoingE2ee(contactsRef, peerId)) {
        let session = e2eeSessionsRef.current[peerId];
        if (!session?.aesKey && ownEcdhPublicSpkiRef.current) {
          void window.bluetalk.peer.send(peerId, {
            kind: 'e2ee-key-handshake',
            publicSpkiB64: ownEcdhPublicSpkiRef.current,
            sender: settingsRef.current.displayName,
          });
          const deadline = Date.now() + 8000;
          while (Date.now() < deadline) {
            await new Promise((r) => {
              setTimeout(r, 120);
            });
            session = e2eeSessionsRef.current[peerId];
            if (session?.aesKey) break;
          }
        }

        if (session?.aesKey && (innerPlain.kind === 'chat' || innerPlain.kind === 'file')) {
          try {
            wirePayload = await encryptChatPayload(session.aesKey, innerPlain);
          } catch (e) {
            console.error('E2EE encrypt failed:', e);
            failScheduled();
            return false;
          }
        }
      }

      const wire = {
        ...wirePayload,
        sender: settingsRef.current.displayName,
        messageId,
        timestamp: createdAt,
      };

      const isFile = innerPlain.kind === 'file';
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
  }, [settings.displayName, upsertContact, applyMessagePatch]);

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
    upsertContact({ id: contactId, e2eeEnabled: Boolean(enabled) });
  }, [upsertContact]);

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
    if (blocked) {
      const next = { ...e2eeSessionsRef.current };
      delete next[contactId];
      e2eeSessionsRef.current = next;
      void persistE2eeSessionsMap(e2eeSessionsRef);
    } else if (window.bluetalk && ownEcdhPublicSpkiRef.current && contactWantsOutgoingE2ee(contactsRef, contactId)) {
      void window.bluetalk.peer.send(contactId, {
        kind: 'e2ee-key-handshake',
        publicSpkiB64: ownEcdhPublicSpkiRef.current,
        sender: settingsRef.current.displayName,
      });
    }
  }, [upsertContact]);

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
    removeContact(peerId);
    return true;
  }, [removeContact]);

  const updateSettings = useCallback((newSettings) => {
    setSettings((prev) => {
      const merged = { ...prev, ...newSettings };
      if (newSettings.featureFlags && typeof newSettings.featureFlags === 'object') {
        merged.featureFlags = {
          ...(prev.featureFlags || {}),
          ...newSettings.featureFlags,
        };
      }
      if (newSettings.uiResize && typeof newSettings.uiResize === 'object') {
        merged.uiResize = {
          ...(prev.uiResize || {}),
          ...newSettings.uiResize,
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

  const versionWelcomeNotes = getReleaseNotesForVersion(APP_VERSION);

  const ctx = {
    peers,
    contacts,
    chatMeta,
    loadedChats,
    messages,
    settings,
    theme,
    peerCount: peers.length,
    peerReadReceipts,
    chatLastViewedPeerTs,
    markPeerChatViewed,
    sendMessage,
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
            <Routes>
              <Route path="/poker-game" element={<PokerGamePage />} />
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
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/cloud-sync" element={<CloudSyncPage />} />
                    <Route path="/plugins" element={<PluginsPage />} />
                    <Route path="/plugin/:tabId" element={<PluginTabView />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </main>
              </div>
              <PluginScreenHost />
            </div>
                )}
              />
            </Routes>
          </HashRouter>
        </ErrorBoundary>
      </ToastProvider>
    </AppContext.Provider>
  );
}
