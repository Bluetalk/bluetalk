// bluetalk-Event-Subscriptions (peer:connected/disconnected/list-sync/peer:message),
// Initial-Load, app:data-cleared und agent-ask-user, 1:1 aus App.jsx ausgelagert.
import { useEffect, useLayoutEffect } from 'react';
import { DEFAULT_APP_SETTINGS } from '../chatConstants';
import { isAiChatPeerId } from '../../aiChatConstants';
import { buildUserPresencePayload } from '../../../shared/user-presence.js';
import { createPeerMessageHandler } from '../peerMessageHandler';
import { loadInitialData } from '../initialLoad';

export function usePeerEvents(deps) {
  const {
    // Setter
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
    setDocInvites,
    setSettings,
    setTheme,
    setLoadError,
    setShowVersionWelcome,
    setShowUsernameOnboarding,
    setUsernameOnboardingGateReady,
    setE2eeBootNonce,
    setAgentAskUser,
    // Refs
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
    // Callbacks
    upsertContact,
    applyContactPatch,
    applyMessagePatch,
    sendE2eeHandshake,
    replaceGroup,
    rememberIncomingGroupEvent,
    persistGroupOutbox,
  } = deps;

  useEffect(() => () => {
    for (const t of deliveryTimersRef.current.values()) {
      clearTimeout(t);
    }
    deliveryTimersRef.current.clear();
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
        if (!blocked && ownEcdhPublicSpkiRef.current) {
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
      window.bluetalk.on('peer:message', createPeerMessageHandler({
        contactsRef,
        settingsRef,
        deliveryTimersRef,
        inboundToastRef,
        e2eeSessionsRef,
        e2eeReadyPeersRef,
        e2eeHandshakeSentRef,
        ownEcdhPrivateRef,
        ownEcdhPublicSpkiRef,
        upsertContact,
        applyContactPatch,
        applyMessagePatch,
        sendE2eeHandshake,
        setPeerReadReceipts,
        setPeerUserPresence,
        setPeerGamePresence,
        setGameInviteKeys,
        setDocInvites,
        setChatMeta,
        setMessages,
        setContacts,
        // Für den Gruppen-Protokoll-Teil (handleGroupProtocolFrame):
        groupsRef,
        groupEventIdsRef,
        groupOutboxRef,
        ownPeerIdRef,
        messageCacheRef,
        sendGroupPacketRef,
        rememberIncomingGroupEvent,
        replaceGroup,
        persistGroupOutbox,
      }))
    );

    let cancelled = false;
    void loadInitialData({
      setContacts,
      setChatMeta,
      setGroups,
      setOwnPeerId,
      setChatLastViewedPeerTs,
      setPeerReadReceipts,
      setGameInviteKeys,
      setDocInvites,
      setSettings,
      setTheme,
      setShowUsernameOnboarding,
      setUsernameOnboardingGateReady,
      setPeers,
      setLoadError,
      groupsRef,
      ownPeerIdRef,
      groupOutboxRef,
      groupEventIdsRef,
    }, () => cancelled);

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
}
