import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CallManager } from './CallManager.js';
import { setCallInboundHandler } from './inbound.js';
import { CALL_PHASE, callHasVideo, createIdleCallState } from './callState.js';
import { newChatMessageId } from '../app/appHelpers.js';
import { CallIncomingOverlay } from './CallIncomingOverlay.jsx';
import { CallOutgoingOverlay } from './CallOutgoingOverlay.jsx';
import { ActiveCallCard } from './ActiveCallCard.jsx';
import { VideoStage } from './VideoStage.jsx';
import { stopAllVoicePlayback } from '../voice/playbackController.js';

const CallContext = createContext(null);

export function useCall() {
  return useContext(CallContext);
}

function sendPeerPayload(peerId, payload, deviceKey) {
  const api = window.bluetalk?.peer;
  if (!api) return Promise.resolve(false);
  if (deviceKey && typeof api.sendTo === 'function') {
    return api.sendTo(peerId, deviceKey, payload);
  }
  return api.send?.(peerId, payload);
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
  const [stageMinimized, setStageMinimized] = useState(false);

  useEffect(() => {
    const manager = new CallManager({
      sendPairwiseEncrypted: (peerId, inner) => sendEncRef.current?.(peerId, inner),
      sendPeer: (peerId, payload, deviceKey) => sendPeerPayload(peerId, payload, deviceKey),
      isBlocked: (peerId) => contactsRef.current.some((c) => c?.id === peerId && c.blocked === true),
      getDisplayName: () => settingsRef.current.displayName || '',
      notifyIncoming: (peerId, media) => {
        const contact = contactsRef.current.find((c) => c?.id === peerId);
        const name = contact?.nickname || contact?.name || peerId;
        if (typeof document !== 'undefined' && !document.hasFocus()) {
          void window.bluetalk?.notify?.show?.({
            title: name,
            body: media?.video ? 'Eingehender Videoanruf' : 'Eingehender Sprachanruf',
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
          video: Boolean(effect.video),
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
    setCall(manager.getSnapshot());
    const unsub = manager.subscribe(setCall);
    return () => {
      unsub();
      setCallInboundHandler(null);
      manager.destroy();
      if (managerRef.current === manager) managerRef.current = null;
    };
  }, [inboundToastRef]);

  useEffect(() => {
    if (call.phase === CALL_PHASE.IDLE) setStageMinimized(false);
  }, [call.phase]);

  const startCall = useCallback(async (peerId, options) => {
    stopAllVoicePlayback();
    return managerRef.current?.startCall(peerId, options);
  }, []);

  const accept = useCallback((options) => managerRef.current?.accept(options), []);
  const acceptWithCamera = useCallback(() => managerRef.current?.accept({ camera: true }), []);
  const reject = useCallback(() => managerRef.current?.reject(), []);
  const hangup = useCallback(() => managerRef.current?.hangup(), []);
  const toggleMute = useCallback(() => managerRef.current?.toggleMute(), []);
  const toggleCamera = useCallback(() => {
    setStageMinimized(false);
    managerRef.current?.toggleCamera();
  }, []);
  const toggleScreen = useCallback(() => {
    setStageMinimized(false);
    managerRef.current?.toggleScreen();
  }, []);
  const getLevels = useCallback(() => managerRef.current?.getLevels() || { capture: 0, playback: 0 }, []);
  const getLocalStreams = useCallback(() => managerRef.current?.getLocalStreams() || { camera: null, screen: null }, []);
  const setVideoSink = useCallback((stream, canvas) => {
    managerRef.current?.setVideoSink(stream, canvas);
  }, []);

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
    toggleCamera,
    toggleScreen,
    peerInfo,
  }), [accept, call, hangup, peerInfo, reject, startCall, toggleCamera, toggleMute, toggleScreen]);

  return (
    <CallContext.Provider value={value}>
      {children}
      <CallLayer
        call={call}
        peerInfo={peerInfo}
        accept={accept}
        acceptWithCamera={acceptWithCamera}
        reject={reject}
        hangup={hangup}
        toggleMute={toggleMute}
        toggleCamera={toggleCamera}
        toggleScreen={toggleScreen}
        getLevels={getLevels}
        getLocalStreams={getLocalStreams}
        setVideoSink={setVideoSink}
        stageMinimized={stageMinimized}
        setStageMinimized={setStageMinimized}
      />
    </CallContext.Provider>
  );
}

function CallLayer({
  call,
  peerInfo,
  accept,
  acceptWithCamera,
  reject,
  hangup,
  toggleMute,
  toggleCamera,
  toggleScreen,
  getLevels,
  getLocalStreams,
  setVideoSink,
  stageMinimized,
  setStageMinimized,
}) {
  if (!call || call.phase === CALL_PHASE.IDLE) return null;
  if (call.phase === CALL_PHASE.INCOMING) {
    return (
      <CallIncomingOverlay
        name={peerInfo.name}
        picture={peerInfo.picture}
        video={Boolean(call.media?.video)}
        videoCapable={Boolean(call.videoCapable)}
        onAccept={() => accept({ camera: false })}
        onAcceptWithCamera={acceptWithCamera}
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
        video={Boolean(call.media?.video)}
        onCancel={hangup}
      />
    );
  }
  if (call.phase === CALL_PHASE.ACTIVE) {
    const showStage = callHasVideo(call) && !stageMinimized;
    return (
      <>
        {showStage ? (
          <VideoStage
            call={call}
            name={peerInfo.name}
            picture={peerInfo.picture}
            transport={peerInfo.transport}
            muted={call.muted}
            videoCapable={Boolean(call.videoCapable)}
            peerVideoCapable={Boolean(call.remoteVideoCapable)}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
            onToggleScreen={toggleScreen}
            onHangup={hangup}
            onMinimize={() => setStageMinimized(true)}
            getLocalStreams={getLocalStreams}
            setVideoSink={setVideoSink}
          />
        ) : (
          <ActiveCallCard
            name={peerInfo.name}
            picture={peerInfo.picture}
            transport={peerInfo.transport}
            connectedAt={call.connectedAt}
            rttMs={call.rttMs}
            muted={call.muted}
            localCamera={Boolean(call.localCamera)}
            localScreen={Boolean(call.localScreen)}
            hasVideo={callHasVideo(call)}
            videoCapable={Boolean(call.videoCapable)}
            peerVideoCapable={Boolean(call.remoteVideoCapable)}
            onToggleMute={toggleMute}
            onToggleCamera={toggleCamera}
            onToggleScreen={toggleScreen}
            onHangup={hangup}
            onExpand={callHasVideo(call) ? () => setStageMinimized(false) : undefined}
            getLevels={getLevels}
          />
        )}
      </>
    );
  }
  return null;
}
