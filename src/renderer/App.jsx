import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';

import RuntimeUnavailablePage from './pages/RuntimeUnavailable';
import { ToastProvider } from './components/ToastProvider';
import { APP_VERSION } from './appVersion';
import { getReleaseNotesForVersion } from './releaseNotes';
import { DEFAULT_APP_SETTINGS } from './app/chatConstants';
import { AppContext, AiProgressContext } from './app/appContext';
import { InboundToastBridge } from './app/bridges';
import AppShell from './app/AppShell';
import { useContactsAndSettings } from './app/hooks/useContactsAndSettings';
import { useChatData } from './app/hooks/useChatData';
import { useE2ee } from './app/hooks/useE2ee';
import { useGroupChats } from './app/hooks/useGroupChats';
import { usePeerEvents } from './app/hooks/usePeerEvents';
import { useMessaging } from './app/hooks/useMessaging';
import { useAiChat } from './app/hooks/useAiChat';
import { useGamePresence } from './app/hooks/useGamePresence';
import { usePluginHost } from './app/hooks/usePluginHost';

// Bestehende Importe aus '../App' (Pages/Components) bleiben gültig:
export { useApp, useAiProgress } from './app/appContext';

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

  const {
    applyContactPatch,
    upsertContact,
    toggleTheme,
    markPeerChatViewed,
    connectToAddress,
    refreshDiscovery,
    acceptMessageRequest,
    setContactNickname,
    setChatPinned,
    setContactNotificationMute,
    removeContact,
    updateSettings,
    completeUsernameOnboarding,
  } = useContactsAndSettings({
    theme,
    setTheme,
    setContacts,
    setSettings,
    setPeers,
    setChatLastViewedPeerTs,
    setShowUsernameOnboarding,
  });

  const { loadChatMessages, applyMessagePatch } = useChatData({
    messages,
    setMessages,
    setLoadedChats,
    messageCacheRef,
  });

  const {
    sendE2eeHandshake,
    sendPairwiseEncrypted,
    resetE2eeSession,
    setContactBlocked,
  } = useE2ee({
    e2eeBootNonce,
    contactsRef,
    settingsRef,
    ownEcdhPrivateRef,
    ownEcdhPublicSpkiRef,
    e2eeSessionsRef,
    e2eeReadyPeersRef,
    e2eeHandshakeSentRef,
    e2eeHandshakePromisesRef,
    upsertContact,
  });

  const {
    replaceGroup,
    removeGroup,
    persistGroupOutbox,
    rememberIncomingGroupEvent,
    sendGroupPacket,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
  } = useGroupChats({
    peers,
    setGroups,
    groupsRef,
    groupOutboxRef,
    groupEventIdsRef,
    sendGroupPacketRef,
    flushGroupOutboxRef,
    contactsRef,
    settingsRef,
    ownPeerIdRef,
    messageCacheRef,
    sendPairwiseEncrypted,
    applyMessagePatch,
  });

  usePeerEvents({
    setPeers,
    setContacts,
    setGroups,
    setOwnPeerId,
    setChatMeta,
    setMessages,
    setLoadedChats,
    setPeerReadReceipts,
    setChatLastViewedPeerTs,
    setPeerGamePresence,
    setPeerUserPresence,
    setGameInviteKeys,
    setSettings,
    setTheme,
    setLoadError,
    setShowVersionWelcome,
    setShowUsernameOnboarding,
    setUsernameOnboardingGateReady,
    setE2eeBootNonce,
    setAgentAskUser,
    contactsRef,
    settingsRef,
    groupsRef,
    ownPeerIdRef,
    groupOutboxRef,
    groupEventIdsRef,
    sendGroupPacketRef,
    flushGroupOutboxRef,
    deliveryTimersRef,
    messageCacheRef,
    inboundToastRef,
    ownEcdhPrivateRef,
    ownEcdhPublicSpkiRef,
    e2eeSessionsRef,
    e2eeReadyPeersRef,
    e2eeHandshakeSentRef,
    e2eeHandshakePromisesRef,
    upsertContact,
    applyContactPatch,
    applyMessagePatch,
    sendE2eeHandshake,
    replaceGroup,
    rememberIncomingGroupEvent,
    persistGroupOutbox,
  });

  const {
    sendMessage,
    sendReadReceipt,
    deleteMessage,
    deleteChat,
    deleteGroupChat,
  } = useMessaging({
    settings,
    setMessages,
    setChatMeta,
    setLoadedChats,
    setPeerReadReceipts,
    setChatLastViewedPeerTs,
    setAiChatProgress,
    setAiChatPendingPeerId,
    contactsRef,
    settingsRef,
    groupsRef,
    ownPeerIdRef,
    messageCacheRef,
    deliveryTimersRef,
    inboundToastRef,
    activeAiChatRequestRef,
    sendMessageRef,
    e2eeSessionsRef,
    e2eeReadyPeersRef,
    ownEcdhPublicSpkiRef,
    groupOutboxRef,
    upsertContact,
    applyMessagePatch,
    sendE2eeHandshake,
    sendGroupPacket,
    removeContact,
    leaveGroupChat,
    removeGroup,
    persistGroupOutbox,
  });

  const { cancelAiChat, clearAiChatContext, isAiChatPending } = useAiChat({
    aiChatProgress,
    aiChatPendingPeerId,
    setAiChatProgress,
    setAiChatPendingPeerId,
    setMessages,
    setChatMeta,
    setLoadedChats,
    messageCacheRef,
    activeAiChatRequestRef,
    sendMessageRef,
    connectToAddress,
  });

  const { joinGameFromPresence } = useGamePresence({
    setPeerGamePresence,
    gameInviteKeys,
  });

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

  const versionWelcomeNotes = getReleaseNotesForVersion(APP_VERSION);

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
    resetE2eeSession,
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
    resetE2eeSession,
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

  usePluginHost({
    peers,
    messages,
    ownPeerIdRef,
    contactsRef,
    setOwnPeerId,
    sendMessage,
    deleteMessage,
    deleteChat,
    upsertContact,
    removeContact,
    setContactBlocked,
    setContactNickname,
    setChatPinned,
  });

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
      <AiProgressContext.Provider value={aiChatProgress}>
        <AppShell
          inboundToastRef={inboundToastRef}
          showUsernameOnboarding={showUsernameOnboarding}
          completeUsernameOnboarding={completeUsernameOnboarding}
          versionWelcomeNotes={versionWelcomeNotes}
          showVersionWelcome={showVersionWelcome}
          dismissVersionWelcome={dismissVersionWelcome}
          loadError={loadError}
          setLoadError={setLoadError}
          agentAskUser={agentAskUser}
          setAgentAskUser={setAgentAskUser}
        />
      </AiProgressContext.Provider>
    </AppContext.Provider>
  );
}
