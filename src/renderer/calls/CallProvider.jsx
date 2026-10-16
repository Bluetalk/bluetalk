import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CallManager } from './CallManager.js';
import { setCallInboundHandler } from './inbound.js';
import { CALL_PHASE, createIdleCallState } from './callState.js';
import { newChatMessageId } from '../app/appHelpers.js';
import { CallIncomingOverlay } from './CallIncomingOverlay.jsx';
import { CallOutgoingOverlay } from './CallOutgoingOverlay.jsx';
import { ActiveCallCard } from './ActiveCallCard.jsx';
import { stopAllVoicePlayback } from '../voice/playbackController.js';

const CallContext = createContext(null);

export function useCall() {
  return useContext(CallContext);
}

export function CallProvider({
  children,
  sendPairwiseEncrypted,
  setMessages,
  setChatMeta,
  contacts,
  peers,
  settings,
  inboundToastRef,
}) {
  const contactsRef = useRef(contacts);
  const peersRef = useRef(peers);
  const settingsRef = useRef(settings);
  const sendEncRef = useRef(sendPairwiseEncrypted);
  const setMessagesRef = useRef(setMessages);
  const setChatMetaRef = useRef(setChatMeta);
  contactsRef.current = contacts;
  peersRef.current = peers;
  settingsRef.current = settings;
  sendEncRef.current = sendPairwiseEncrypted;
  setMessagesRef.current = setMessages;
  setChatMetaRef.current = setChatMeta;

  const managerRef = useRef(null);
  const [call, setCall] = useState(createIdleCallState);

  useEffect(() => {
    const manager = new CallManager({
      sendPairwiseEncrypted: (peerId, inner) => sendEncRef.current?.(peerId, inner),
      sendPeer: (peerId, payload) => {
        if (!window.bluetalk?.peer?.send) return Promise.resolve(false);
        return window.bluetalk.peer.send(peerId, payload);
      },
      isBlocked: (peerId) => contactsRef.current.some((c) => c?.id === peerId && c.blocked === true),
      getDisplayName: () => settingsRef.current.displayName || '',
      notifyIncoming: (peerId) => {
        const contact = contactsRef.current.find((c) => c?.id === peerId);
        const name = contact?.nickname || contact?.name || peerId;
        if (typeof document !== 'undefined' && !document.hasFocus()) {
          void window.bluetalk?.notify?.show?.({
            title: name,
            body: 'Eingehender Sprachanruf',
          });
        }
      },
      toast: (message) => {
        inboundToastRef?.current?.({ variant: 'warning', title: 'Anruf', message });
      },
      appendCallLog: async (effect) => {
        if (!effect?.peerId || !window.bluetalk?.messages?.append) return;
        const message = {
          kind: 'call-log',
          messageId: newChatMessageId(),
          timestamp: Date.now(),
          from: 'self',
          direction: effect.direction,
          outcome: effect.outcome,
          durationMs: effect.durationMs || 0,
        };
        const meta = await window.bluetalk.messages.append(effect.peerId, message);
        setMessagesRef.current((prev) => ({
          ...prev,
          [effect.peerId]: [...(prev[effect.peerId] || []), message],
        }));
        setChatMetaRef.current((prev) => ({
          ...prev,
          [effect.peerId]: meta?.count ? meta : {
            count: (prev[effect.peerId]?.count || 0) + 1,
            lastMessage: message,
          },
        }));
      },
    });
    managerRef.current = manager;
    setCallInboundHandler((fromId, msg) => manager.handleInbound(fromId, msg));
    const unsub = manager.subscribe(setCall);
    return () => {
      unsub();
      setCallInboundHandler(null);
      manager.destroy();
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [inboundToastRef]);

  const startCall = useCallback(async (peerId) => {
    stopAllVoicePlayback();
    return managerRef.current?.startCall(peerId);
  }, []);

  const accept = useCallback(() => managerRef.current?.accept(), []);
  const reject = useCallback(() => managerRef.current?.reject(), []);
  const hangup = useCallback(() => managerRef.current?.hangup(), []);
  const toggleMute = useCallback(() => managerRef.current?.toggleMute(), []);
  const getLevels = useCallback(() => managerRef.current?.getLevels() || { capture: 0, playback: 0 }, []);

  const peerInfo = useMemo(() => {
    if (!call?.peerId) return { name: '', picture: '', transport: '' };
    const contact = contacts.find((c) => c?.id === call.peerId);
    const peer = peers.find((p) => p?.id === call.peerId);
    return {
      name: contact?.nickname || contact?.name || peer?.name || call.peerId,
      picture: contact?.profilePicture || peer?.profilePicture || '',
      transport: peer?.transport || '',
      online: Boolean(peer),
    };
  }, [call?.peerId, contacts, peers]);

  useEffect(() => {
    if (call.phase === CALL_PHASE.IDLE || !call.peerId) return undefined;
    const online = peers.some((p) => p?.id === call.peerId);
    if (!online && call.phase === CALL_PHASE.ACTIVE) {
      managerRef.current?.handlePeerDisconnected(call.peerId);
    }
    return undefined;
  }, [peers, call.phase, call.peerId]);

  const value = useMemo(() => ({
    call,
    startCall,
    accept,
    reject,
    hangup,
    toggleMute,
    peerInfo,
  }), [accept, call, hangup, peerInfo, reject, startCall, toggleMute]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallLayer call={call} peerInfo={peerInfo} accept={accept} reject={reject} hangup={hangup} toggleMute={toggleMute} getLevels={getLevels} />
    </CallContext.Provider>
  );
}

function CallLayer({ call, peerInfo, accept, reject, hangup, toggleMute, getLevels }) {
  if (!call || call.phase === CALL_PHASE.IDLE) return null;
  if (call.phase === CALL_PHASE.INCOMING) {
    return (
      <CallIncomingOverlay
        name={peerInfo.name}
        picture={peerInfo.picture}
        onAccept={accept}
        onReject={reject}
      />
    );
  }
  if (call.phase === CALL_PHASE.OUTGOING) {
    return (
      <CallOutgoingOverlay
        name={peerInfo.name}
        picture={peerInfo.picture}
        ringing={Boolean(call.peerRinging)}
        onCancel={hangup}
      />
    );
  }
  if (call.phase === CALL_PHASE.ACTIVE) {
    return (
      <ActiveCallCard
        name={peerInfo.name}
        picture={peerInfo.picture}
        transport={peerInfo.transport}
        connectedAt={call.connectedAt}
        rttMs={call.rttMs}
        muted={call.muted}
        onToggleMute={toggleMute}
        onHangup={hangup}
        getLevels={getLevels}
      />
    );
  }
  return null;
}
