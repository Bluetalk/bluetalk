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
  };
}

export function isStaleCallOffer(event, now = Date.now()) {
  const ts = Number(event?.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return now - ts > CALL_OFFER_MAX_AGE_MS;
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
      return sameCall(current, event) && current.phase === CALL_PHASE.OUTGOING
        ? { state: { ...current, lastHeardAt: event.now || Date.now(), peerRinging: true }, effects: [] }
        : ignore(current);
    case 'local-accept':
      return reduceLocalAccept(current, event);
    case 'remote-accept':
      return reduceRemoteAccept(current, event);
    case 'local-reject':
      return reduceLocalReject(current, event);
    case 'remote-reject':
      return reduceHangup(current, event, 'rejected', 'in');
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

function reduceLocalStart(state, event) {
  if (state.phase !== CALL_PHASE.IDLE) {
    return { state, effects: [] };
  }
  const now = event.now || Date.now();
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
      effects: [{ type: 'send-signal', op: 'busy', peerId: event.peerId, callId: event.callId }],
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
      { type: 'send-signal', op: 'cancel', peerId: state.peerId, callId: state.callId },
      { type: 'stop-ringtone' },
      ...incoming.effects,
    ],
  };
}

function beginIncoming(event) {
  const now = event.now || Date.now();
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
    },
    effects: [
      { type: 'send-signal', op: 'ringing' },
      { type: 'arm-ring-timeout' },
      { type: 'notify-incoming' },
      { type: 'start-ringtone' },
    ],
  };
}

function reduceLocalAccept(state, event) {
  if (state.phase !== CALL_PHASE.INCOMING) return ignore(state);
  const now = event.now || Date.now();
  const codec = event.codec || 'pcm16';
  return {
    state: {
      ...state,
      phase: CALL_PHASE.ACTIVE,
      codec,
      connectedAt: now,
      lastHeardAt: now,
      muted: false,
    },
    effects: [
      { type: 'stop-ringtone' },
      { type: 'send-signal', op: 'accept', codec },
      { type: 'start-media' },
      { type: 'arm-watchdog' },
      { type: 'start-ping' },
    ],
  };
}

function reduceRemoteAccept(state, event) {
  if (!sameCall(state, event) || state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  const now = event.now || Date.now();
  const codec = event.codec === 'opus' || event.codec === 'pcm16' ? event.codec : 'pcm16';
  return {
    state: {
      ...state,
      phase: CALL_PHASE.ACTIVE,
      codec,
      connectedAt: now,
      lastHeardAt: now,
    },
    effects: [
      { type: 'stop-ringtone' },
      { type: 'start-media' },
      { type: 'arm-watchdog' },
      { type: 'start-ping' },
    ],
  };
}

function reduceLocalReject(state, event) {
  if (state.phase !== CALL_PHASE.INCOMING) return ignore(state);
  return idleWith([
    { type: 'stop-ringtone' },
    { type: 'send-signal', op: 'reject' },
    { type: 'stop-media' },
    { type: 'clear-timers' },
    callLogEffect(state, 'rejected', event.now),
  ]);
}

function reduceLocalCancel(state, event) {
  if (state.phase !== CALL_PHASE.OUTGOING) return ignore(state);
  return idleWith([
    { type: 'send-signal', op: 'cancel' },
    { type: 'clear-timers' },
    callLogEffect(state, 'failed', event.now),
  ]);
}

function reduceRemoteCancel(state, event) {
  if (!sameCall(state, event)) return ignore(state);
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

function reduceLocalEnd(state, event) {
  if (state.phase !== CALL_PHASE.ACTIVE) return ignore(state);
  return idleWith([
    { type: 'send-signal', op: 'end' },
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
      { type: 'send-signal', op: 'cancel' },
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
    { type: 'send-signal', op: 'end' },
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

function callLogEffect(state, outcome, now) {
  const ts = now || Date.now();
  const durationMs = state.connectedAt ? Math.max(0, ts - state.connectedAt) : 0;
  return {
    type: 'call-log',
    peerId: state.peerId,
    direction: state.role === 'caller' ? 'out' : 'in',
    outcome,
    durationMs,
  };
}
