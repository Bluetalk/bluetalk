import {
  applyRemoteBusy,
  isAnsweredElsewhere,
  uniqueDevices,
} from './callDevices.js';
import { normalizeCapabilityList, pickVideoCodec } from './videoCaps.js';

export const CALL_PHASE = {
  IDLE: 'idle',
  OUTGOING: 'outgoing',
  INCOMING: 'incoming',
  ACTIVE: 'active',
};

export const RING_TIMEOUT_MS = 45_000;
export const CALL_WATCHDOG_MS = 15_000;
export const CALL_PING_MS = 2_000;
export const CALL_OFFER_MAX_AGE_MS = 60_000;

export function createIdleCallState() {
  return {
    phase: CALL_PHASE.IDLE,
    callId: null,
    peerId: null,
    role: null,
    callKeyB64: '',
    codecs: ['opus', 'pcm16'],
    codec: null,
    muted: false,
    ringingAt: 0,
    connectedAt: 0,
    rttMs: null,
    lastHeardAt: 0,
    peerRinging: false,
    remoteDevice: null,
    ringingDevices: [],
    busyDevices: [],
    media: { video: false },
    capabilities: { video: [], screen: false },
    remoteCapabilities: { video: [], screen: false },
    videoCodec: null,
    localCamera: false,
    localScreen: false,
    remoteCamera: false,
    remoteScreen: false,
    hadVideo: false,
  };
}

export function isStaleCallOffer(event, now = Date.now()) {
  const ts = Number(event?.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return now - ts > CALL_OFFER_MAX_AGE_MS;
}

export function callHasVideo(state) {
  if (!state) return false;
  return Boolean(state.localCamera || state.localScreen || state.remoteCamera || state.remoteScreen);
}

export const VIDEO_LOCAL_UNSUPPORTED_HINT = 'Video auf diesem Gerät nicht verfügbar';
export const VIDEO_PEER_UNSUPPORTED_HINT = 'Gegenüber unterstützt kein Video (ältere Version)';

/** 2.3.x sendet kein capabilities.video — dann gilt der Gegenüber als ohne Video. */
export function peerSupportsVideo(capabilities) {
  return normalizeCapabilityList(capabilities?.video).length > 0;
}

export function videoControlHint(localCapable, remoteCapable) {
  if (!localCapable) return VIDEO_LOCAL_UNSUPPORTED_HINT;
  if (!remoteCapable) return VIDEO_PEER_UNSUPPORTED_HINT;
  return '';
}

/**
 * Reine Zustandsmaschine. Liefert `{ state, effects }`.
 * Effects werden vom CallManager ausgeführt (Senden, Timer, Logs, Media).
 */
export function reduceCall(state, event) {
  const current = state || createIdleCallState();
  switch (event?.type) {
    case 'local-start':
      return reduceLocalStart(current, event);
    case 'remote-offer':
      return reduceRemoteOffer(current, event);
    case 'remote-ringing':
      return reduceRemoteRinging(current, event);
    case 'local-accept':
      return reduceLocalAccept(current, event);
    case 'remote-accept':
      return reduceRemoteAccept(current, event);
    case 'local-reject':
      return reduceLocalReject(current, event);
    case 'remote-reject':
      return reduceHangup(current, event, 'rejected');
    case 'local-cancel':
      return reduceLocalCancel(current, event);
    case 'remote-cancel':
      return reduceRemoteCancel(current, event);
    case 'local-end':
      return reduceLocalEnd(current, event);
    case 'remote-end':
      return reduceRemoteEnd(current, event);
    case 'remote-busy':
      return reduceRemoteBusy(current, event);
    case 'offer-failed':
      return reduceOfferFailed(current, event);
    case 'ring-timeout':
      return reduceRingTimeout(current, event);
    case 'connection-lost':
      return reduceConnectionLost(current, event);
    case 'toggle-mute':
      return current.phase === CALL_PHASE.ACTIVE
        ? { state: { ...current, muted: !current.muted }, effects: [{ type: 'apply-mute' }] }
        : ignore(current);
    case 'local-camera':
      return reduceLocalMediaFlag(current, event, 'localCamera', 'camera');
    case 'local-screen':
      return reduceLocalMediaFlag(current, event, 'localScreen', 'screen');
    case 'remote-camera':
      return reduceRemoteMediaFlag(current, event, 'remoteCamera');
    case 'remote-screen':
      return reduceRemoteMediaFlag(current, event, 'remoteScreen');
    case 'local-keyframe':
      return reduceLocalKeyframe(current, event);
    case 'pong':
      return reducePong(current, event);
    case 'heard':
      return sameCall(current, event)
        ? { state: { ...current, lastHeardAt: event.now || Date.now() }, effects: [] }
        : ignore(current);
    default:
      return ignore(current);
  }
}

function ignore(state) {
  return { state, effects: [] };
}

function sameCall(state, event) {
  if (state.phase === CALL_PHASE.IDLE) return false;
  if (event.callId && event.callId !== state.callId) return false;
  if (event.peerId && event.peerId !== state.peerId) return false;
  return true;
}

function idleWith(effects) {
  return { state: createIdleCallState(), effects };
}

function offerCodecs(event) {
  return Array.isArray(event.codecs) && event.codecs.length ? event.codecs : ['opus', 'pcm16'];
}

function offerCapabilities(event) {
  const caps = event?.capabilities || {};
  return {
    video: normalizeCapabilityList(caps.video),
    screen: caps.screen !== false && normalizeCapabilityList(caps.video).length > 0,
  };
}

/**
 * Signale, die den Anruf beenden, müssen peerId/callId/deviceKey tragen:
 * der Manager setzt den State zuerst auf idle (Felder null) und sendet danach.
 */
function signalEffect(state, op, extra = {}) {
  const effect = {
    type: 'send-signal',
    op,
    peerId: extra.peerId ?? state.peerId,
    callId: extra.callId ?? state.callId,
  };
  const deviceKey = extra.deviceKey !== undefined ? extra.deviceKey : state.remoteDevice;
  if (deviceKey) effect.deviceKey = deviceKey;
  if (extra.codec) effect.codec = extra.codec;
  if (extra.stream) effect.stream = extra.stream;
  if (extra.reason) effect.reason = extra.reason;
  if (extra.capabilities) effect.capabilities = extra.capabilities;
  return effect;
}

function reduceLocalStart(state, event) {
  if (state.phase !== CALL_PHASE.IDLE) {
    return { state, effects: [] };
  }
  const now = event.now || Date.now();
  const capabilities = offerCapabilities(event);
  const next = {
    ...createIdleCallState(),
    phase: CALL_PHASE.OUTGOING,
    callId: event.callId,
    peerId: event.peerId,
    role: 'caller',
    callKeyB64: event.callKeyB64,
    codecs: event.codecs || ['opus', 'pcm16'],
    ringingAt: now,
    lastHeardAt: now,
    media: { video: event.media?.video === true },
    capabilities,
  };
  return {
    state: next,
    effects: [
      { type: 'send-offer' },
      { type: 'start-ringback' },
      { type: 'arm-ring-timeout' },
    ],
  };
}

function reduceRemoteOffer(state, event) {
  if (event.blocked) return ignore(state);
  if (isStaleCallOffer(event, event.now || Date.now())) return ignore(state);
  if (state.phase === CALL_PHASE.OUTGOING && event.peerId === state.peerId) {
    return reduceGlare(state, event);
  }
  if (state.phase !== CALL_PHASE.IDLE) {
    return {
      state,
      effects: [signalEffect(state, 'busy', { peerId: event.peerId, callId: event.callId, deviceKey: event.fromDevice || null })],
    };
  }
  return beginIncoming(event);
}

/**
 * Beide rufen sich gleichzeitig an: das Angebot mit der kleineren callId
 * gewinnt. Die Verliererseite verwirft ihr ausgehendes Angebot und wechselt
 * in „eingehend“ — ohne automatisch anzunehmen.
 */
function reduceGlare(state, event) {
  const incomingId = String(event.callId || '');
  const outgoingId = String(state.callId || '');
  if (!incomingId || !outgoingId || incomingId === outgoingId) {
    return ignore(state);
  }
  if (incomingId > outgoingId) {
    return ignore(state);
  }
  const incoming = beginIncoming(event);
  return {
    state: incoming.state,
    effects: [
      signalEffect(state, 'cancel', { peerId: state.peerId, callId: state.callId }),
      { type: 'stop-ringtone' },
      ...incoming.effects,
    ],
  };
}

function beginIncoming(event) {
  const now = event.now || Date.now();
  const capabilities = offerCapabilities(event);
  const remoteDevice = event.fromDevice || null;
  return {
    state: {
      ...createIdleCallState(),
      phase: CALL_PHASE.INCOMING,
      callId: event.callId,
      peerId: event.peerId,
      role: 'callee',
      callKeyB64: event.callKeyB64,
      codecs: offerCodecs(event),
      ringingAt: now,
      lastHeardAt: now,
      media: { video: event.media?.video === true },
      remoteCapabilities: capabilities,
      remoteDevice,
    },
    effects: [
      signalEffect({
        peerId: event.peerId,
        callId: event.callId,
        remoteDevice,
      }, 'ringing'),
      { type: 'arm-ring-timeout' },
      { type: 'notify-incoming' },
      { type: 'start-ringtone' },
    ],
  };
}

function reduceRemoteRinging(state, event) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  const ringingDevices = uniqueDevices([...(state.ringingDevices || []), event.fromDevice]);
  const remoteCapabilities = event.capabilities
    ? offerCapabilities(event)
    : state.remoteCapabilities;
  return {
    state: {
      ...state,
      lastHeardAt: event.now || Date.now(),
      peerRinging: true,
      ringingDevices,
      remoteCapabilities,
    },
    effects: [],
  };
}

function reduceLocalAccept(state, event) {
  if (state.phase !== CALL_PHASE.INCOMING) return ignore(state);
  const now = event.now || Date.now();
  const codec = event.codec || 'pcm16';
  const camera = event.camera === true && peerSupportsVideo(state.remoteCapabilities);
  const videoCodec = pickVideoCodec(
    event.localVideoCodecs || state.capabilities?.video,
    state.remoteCapabilities?.video,
  );
  const effects = [
    { type: 'stop-ringtone' },
    signalEffect(state, 'accept', { codec }),
    { type: 'start-media' },
    { type: 'arm-watchdog' },
    { type: 'start-ping' },
  ];
  if (camera) effects.push({ type: 'start-camera' });
  return {
    state: {
      ...state,
      phase: CALL_PHASE.ACTIVE,
      codec,
      connectedAt: now,
      lastHeardAt: now,
      muted: false,
      localCamera: camera,
      hadVideo: camera || state.media?.video === true,
      videoCodec,
      capabilities: event.capabilities || state.capabilities,
    },
    effects,
  };
}

function reduceRemoteAccept(state, event) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  const now = event.now || Date.now();
  const codec = event.codec === 'opus' || event.codec === 'pcm16' ? event.codec : 'pcm16';
  const remoteDevice = event.fromDevice || state.remoteDevice;
  const remoteCapabilities = event.capabilities
    ? offerCapabilities(event)
    : state.remoteCapabilities;
  const videoCodec = pickVideoCodec(state.capabilities?.video, remoteCapabilities?.video);
  const startCamera = state.media?.video === true && peerSupportsVideo(remoteCapabilities);
  const effects = [
    { type: 'stop-ringtone' },
    { type: 'start-media' },
    { type: 'arm-watchdog' },
    { type: 'start-ping' },
    {
      type: 'cancel-other-devices',
      peerId: state.peerId,
      callId: state.callId,
      exceptDevice: remoteDevice,
      ringingDevices: state.ringingDevices,
    },
  ];
  if (startCamera) effects.push({ type: 'start-camera' });
  return {
    state: {
      ...state,
      phase: CALL_PHASE.ACTIVE,
      codec,
      connectedAt: now,
      lastHeardAt: now,
      remoteDevice,
      remoteCapabilities,
      videoCodec,
      localCamera: startCamera,
      hadVideo: startCamera,
    },
    effects,
  };
}

function reduceLocalReject(state, event) {
  if (state.phase !== CALL_PHASE.INCOMING) return ignore(state);
  return idleWith([
    { type: 'stop-ringtone' },
    signalEffect(state, 'reject'),
    { type: 'stop-media' },
    { type: 'clear-timers' },
    callLogEffect(state, 'rejected', event.now),
  ]);
}

function reduceLocalCancel(state, event) {
  if (state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  return idleWith([
    signalEffect(state, 'cancel'),
    { type: 'stop-ringtone' },
    { type: 'clear-timers' },
    callLogEffect(state, 'failed', event.now),
  ]);
}

function reduceRemoteCancel(state, event) {
  if (!sameCall(state, event)) return ignore(state);
  if (isAnsweredElsewhere(event.reason)) {
    if (state.phase === CALL_PHASE.INCOMING) {
      return idleWith([
        { type: 'stop-ringtone' },
        { type: 'clear-timers' },
      ]);
    }
    return ignore(state);
  }
  if (state.phase === CALL_PHASE.INCOMING) {
    return idleWith([
      { type: 'stop-ringtone' },
      { type: 'clear-timers' },
      callLogEffect(state, 'missed', event.now),
    ]);
  }
  if (state.phase === CALL_PHASE.OUTGOING) {
    return idleWith([
      { type: 'clear-timers' },
      callLogEffect(state, 'failed', event.now),
    ]);
  }
  if (state.phase === CALL_PHASE.ACTIVE) {
    return idleWith([
      { type: 'stop-media' },
      { type: 'clear-timers' },
      callLogEffect(state, 'completed', event.now),
    ]);
  }
  return ignore(state);
}

function reduceLocalEnd(state, event) {
  if (state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  return idleWith([
    signalEffect(state, 'end'),
    { type: 'stop-media' },
    { type: 'clear-timers' },
    callLogEffect(state, 'completed', event.now),
  ]);
}

function reduceRemoteEnd(state, event) {
  if (!sameCall(state, event)) return ignore(state);
  if (state.phase === CALL_PHASE.ACTIVE) {
    return idleWith([
      { type: 'stop-media' },
      { type: 'clear-timers' },
      callLogEffect(state, 'completed', event.now),
    ]);
  }
  if (state.phase === CALL_PHASE.INCOMING) {
    return idleWith([
      { type: 'stop-ringtone' },
      { type: 'clear-timers' },
      callLogEffect(state, 'missed', event.now),
    ]);
  }
  if (state.phase === CALL_PHASE.OUTGOING) {
    return idleWith([
      { type: 'clear-timers' },
      callLogEffect(state, 'failed', event.now),
    ]);
  }
  return ignore(state);
}

function reduceRemoteBusy(state, event) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  const { busy, ringing, endBusy } = applyRemoteBusy(state, event.fromDevice);
  if (!endBusy) {
    return {
      state: { ...state, busyDevices: busy, ringingDevices: ringing, lastHeardAt: event.now || Date.now() },
      effects: [],
    };
  }
  return idleWith([
    { type: 'clear-timers' },
    callLogEffect(state, 'busy', event.now),
  ]);
}

function reduceOfferFailed(state, event) {
  if (state.phase !== CALL_PHASE.OUTGOING || !sameCall(state, event)) return ignore(state);
  return idleWith([
    { type: 'clear-timers' },
    { type: 'toast', message: 'Nicht erreichbar' },
    callLogEffect(state, 'failed', event.now),
  ]);
}

function reduceHangup(state, event, outcome) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  return idleWith([
    { type: 'clear-timers' },
    callLogEffect(state, outcome, event.now),
  ]);
}

function reduceRingTimeout(state, event) {
  if (state.phase === CALL_PHASE.OUTGOING && sameCall(state, event)) {
    return idleWith([
      signalEffect(state, 'cancel'),
      { type: 'clear-timers' },
      callLogEffect(state, 'failed', event.now),
    ]);
  }
  if (state.phase === CALL_PHASE.INCOMING && sameCall(state, event)) {
    return idleWith([
      { type: 'stop-ringtone' },
      { type: 'clear-timers' },
      callLogEffect(state, 'missed', event.now),
    ]);
  }
  return ignore(state);
}

function reduceConnectionLost(state, event) {
  if (state.phase !== CALL_PHASE.ACTIVE || !sameCall(state, event)) return ignore(state);
  return idleWith([
    signalEffect(state, 'end'),
    { type: 'stop-media' },
    { type: 'clear-timers' },
    { type: 'toast', message: 'Verbindung verloren' },
    callLogEffect(state, 'failed', event.now),
  ]);
}

function reducePong(state, event) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  const now = event.now || Date.now();
  const sentAt = Number(event.t);
  const rttMs = Number.isFinite(sentAt) ? Math.max(0, now - sentAt) : state.rttMs;
  return {
    state: { ...state, rttMs, lastHeardAt: now },
    effects: [],
  };
}

function reduceLocalMediaFlag(state, event, flag, stream) {
  if (state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  const on = event.on !== false;
  if (on && !peerSupportsVideo(state.remoteCapabilities)) return ignore(state);
  if (state[flag] === on) return ignore(state);
  const op = stream === 'screen'
    ? (on ? 'screen-on' : 'screen-off')
    : (on ? 'video-on' : 'video-off');
  const effects = [
    signalEffect(state, op, { stream }),
    { type: on ? `start-${stream}` : `stop-${stream}` },
  ];
  return {
    state: {
      ...state,
      [flag]: on,
      hadVideo: state.hadVideo || on,
    },
    effects,
  };
}

function reduceRemoteMediaFlag(state, event, flag) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  const on = event.on !== false;
  if (state[flag] === on) return ignore(state);
  return {
    state: {
      ...state,
      [flag]: on,
      hadVideo: state.hadVideo || on,
      lastHeardAt: event.now || Date.now(),
    },
    effects: [],
  };
}

function reduceLocalKeyframe(state, event) {
  if (state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  const stream = event.stream === 'screen' ? 'screen' : 'camera';
  return {
    state,
    effects: [signalEffect(state, 'keyframe', { stream })],
  };
}

function callLogEffect(state, outcome, now) {
  const ts = now || Date.now();
  const durationMs = state.connectedAt ? Math.max(0, ts - state.connectedAt) : 0;
  return {
    type: 'call-log',
    peerId: state.peerId,
    direction: state.role === 'caller' ? 'out' : 'in',
    outcome,
    durationMs,
    video: Boolean(state.hadVideo || callHasVideo(state)),
  };
}
