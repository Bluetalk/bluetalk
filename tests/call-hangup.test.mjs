import assert from 'node:assert/strict';
import test from 'node:test';

import { CALL_PHASE, createIdleCallState, reduceCall } from '../src/renderer/calls/callState.js';

/**
 * Simuliert CallManager.dispatch: erst neuer State (idle löscht peerId/callId),
 * dann Effects. Genau diese Reihenfolge hat das Auflegen verschluckt.
 */
class SimulatedManager {
  constructor(id) {
    this.id = id;
    this.state = createIdleCallState();
    this.inbox = null;
    this.sent = [];
  }

  connect(other) {
    this.inbox = other;
  }

  dispatch(event) {
    const { state, effects } = reduceCall(this.state, event);
    this.state = state;
    for (const effect of effects) this.runEffect(effect);
  }

  runEffect(effect) {
    if (effect.type !== 'send-signal' && effect.type !== 'send-offer') return;
    const peerId = effect.peerId || this.state.peerId;
    const callId = effect.callId || this.state.callId;
    if (!peerId || !callId) return;
    const payload = effect.type === 'send-offer'
      ? {
        kind: 'call-offer',
        callId,
        callKeyB64: this.state.callKeyB64 || 'k',
        codecs: ['pcm16'],
      }
      : {
        kind: 'call-signal',
        callId,
        op: effect.op,
        codec: effect.codec,
        reason: effect.reason,
      };
    this.sent.push({ to: peerId, payload, deviceKey: effect.deviceKey || null });
    this.inbox?.handleInbound(this.id, payload);
  }

  handleInbound(fromId, msg) {
    if (msg.kind === 'call-offer') {
      this.dispatch({
        type: 'remote-offer',
        peerId: fromId,
        callId: msg.callId,
        callKeyB64: msg.callKeyB64,
        codecs: msg.codecs,
        now: Date.now(),
        fromDevice: msg.fromDevice,
      });
      return;
    }
    if (msg.kind !== 'call-signal') return;
    const base = { peerId: fromId, callId: msg.callId, now: Date.now(), fromDevice: msg.fromDevice };
    const map = {
      ringing: 'remote-ringing',
      accept: 'remote-accept',
      reject: 'remote-reject',
      busy: 'remote-busy',
      cancel: 'remote-cancel',
      end: 'remote-end',
    };
    const type = map[msg.op];
    if (!type) return;
    this.dispatch({ type, codec: msg.codec, reason: msg.reason, ...base });
  }

  hangup() {
    const { phase, callId, peerId } = this.state;
    const now = Date.now();
    if (phase === CALL_PHASE.OUTGOING) this.dispatch({ type: 'local-cancel', now, callId, peerId });
    else if (phase === CALL_PHASE.INCOMING) this.dispatch({ type: 'local-reject', now, callId, peerId });
    else this.dispatch({ type: 'local-end', now, callId, peerId });
  }
}

function linkedPair() {
  const alice = new SimulatedManager('alice');
  const bob = new SimulatedManager('bob');
  alice.connect(bob);
  bob.connect(alice);
  return { alice, bob };
}

test('signal roundtrip: hangup sends end and the remote manager goes idle', () => {
  const { alice, bob } = linkedPair();
  alice.dispatch({
    type: 'local-start',
    peerId: 'bob',
    callId: 'call-1',
    callKeyB64: 'k',
    now: 10,
  });
  assert.equal(alice.state.phase, CALL_PHASE.OUTGOING);
  assert.equal(bob.state.phase, CALL_PHASE.INCOMING);

  bob.dispatch({ type: 'local-accept', codec: 'pcm16', now: 20, callId: 'call-1', peerId: 'alice' });
  assert.equal(bob.state.phase, CALL_PHASE.ACTIVE);
  assert.equal(alice.state.phase, CALL_PHASE.ACTIVE);

  alice.hangup();
  assert.equal(alice.state.phase, CALL_PHASE.IDLE);
  assert.equal(bob.state.phase, CALL_PHASE.IDLE);
  assert.ok(alice.sent.some((item) => item.payload?.op === 'end' && item.payload?.callId === 'call-1'));
});

test('signal roundtrip: remote hangup ends the local active call', () => {
  const { alice, bob } = linkedPair();
  alice.dispatch({
    type: 'local-start',
    peerId: 'bob',
    callId: 'call-2',
    callKeyB64: 'k',
    now: 10,
  });
  bob.dispatch({ type: 'local-accept', codec: 'pcm16', now: 20, callId: 'call-2', peerId: 'alice' });
  bob.hangup();
  assert.equal(alice.state.phase, CALL_PHASE.IDLE);
  assert.equal(bob.state.phase, CALL_PHASE.IDLE);
  assert.ok(bob.sent.some((item) => item.payload?.op === 'end' && item.payload?.callId === 'call-2'));
});

test('signal roundtrip: cancel while ringing stops the callee', () => {
  const { alice, bob } = linkedPair();
  alice.dispatch({
    type: 'local-start',
    peerId: 'bob',
    callId: 'call-3',
    callKeyB64: 'k',
    now: 10,
  });
  assert.equal(bob.state.phase, CALL_PHASE.INCOMING);
  alice.hangup();
  assert.equal(alice.state.phase, CALL_PHASE.IDLE);
  assert.equal(bob.state.phase, CALL_PHASE.IDLE);
  assert.ok(alice.sent.some((item) => item.payload?.op === 'cancel' && item.payload?.callId === 'call-3'));
});

test('end payload keeps callId even after local state is already idle', () => {
  const { alice, bob } = linkedPair();
  alice.dispatch({
    type: 'local-start',
    peerId: 'bob',
    callId: 'call-4',
    callKeyB64: 'k',
    now: 10,
  });
  bob.dispatch({ type: 'local-accept', codec: 'pcm16', now: 20, callId: 'call-4', peerId: 'alice' });
  alice.hangup();
  const end = alice.sent.find((item) => item.payload?.op === 'end');
  assert.equal(end.payload.callId, 'call-4');
  assert.equal(end.to, 'bob');
  assert.equal(alice.state.callId, null);
});
