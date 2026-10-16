import assert from 'node:assert/strict';
import test from 'node:test';

import { CALL_PHASE, createIdleCallState, reduceCall } from '../src/renderer/calls/callState.js';

test('outgoing offer then remote accept becomes active', () => {
  let { state, effects } = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'key',
    now: 1000,
  });
  assert.equal(state.phase, CALL_PHASE.OUTGOING);
  assert.ok(effects.some((e) => e.type === 'send-offer'));
  ({ state, effects } = reduceCall(state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'c1',
    codec: 'opus',
    now: 1500,
  }));
  assert.equal(state.phase, CALL_PHASE.ACTIVE);
  assert.equal(state.codec, 'opus');
  assert.ok(effects.some((e) => e.type === 'start-media'));
});

test('second offer while busy yields busy signal without replacing the call', () => {
  const first = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const second = reduceCall(first.state, {
    type: 'remote-offer',
    peerId: 'p2',
    callId: 'c2',
    callKeyB64: 'k2',
    now: 2,
  });
  assert.equal(second.state.callId, 'c1');
  assert.deepEqual(second.effects[0], { type: 'send-signal', op: 'busy', peerId: 'p2', callId: 'c2' });
});

test('blocked offer is dropped silently', () => {
  const { state, effects } = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    blocked: true,
    now: 1,
  });
  assert.equal(state.phase, CALL_PHASE.IDLE);
  assert.equal(effects.length, 0);
});

test('ring timeout on callee logs a missed call', () => {
  const incoming = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 10,
  });
  const timed = reduceCall(incoming.state, {
    type: 'ring-timeout',
    peerId: 'p1',
    callId: 'c1',
    now: 45010,
  });
  assert.equal(timed.state.phase, CALL_PHASE.IDLE);
  const log = timed.effects.find((e) => e.type === 'call-log');
  assert.equal(log.outcome, 'missed');
  assert.equal(log.direction, 'in');
});

test('stale offer older than 60s is ignored', () => {
  const { state, effects } = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    timestamp: 1,
    now: 70_000,
  });
  assert.equal(state.phase, CALL_PHASE.IDLE);
  assert.equal(effects.length, 0);
});

test('glare: smaller callId wins, loser becomes incoming without auto-accept', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'call-b',
    callKeyB64: 'own',
    now: 10,
  });
  const glared = reduceCall(outgoing.state, {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'call-a',
    callKeyB64: 'theirs',
    now: 11,
  });
  assert.equal(glared.state.phase, CALL_PHASE.INCOMING);
  assert.equal(glared.state.callId, 'call-a');
  assert.equal(glared.state.role, 'callee');
  assert.ok(glared.effects.some((e) => e.type === 'send-signal' && e.op === 'cancel' && e.callId === 'call-b'));
  assert.ok(glared.effects.some((e) => e.type === 'send-signal' && e.op === 'ringing'));
  assert.ok(!glared.effects.some((e) => e.type === 'start-media' || e.op === 'accept'));
});

test('glare: larger remote callId is dropped so the local offer keeps ringing', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'call-a',
    callKeyB64: 'own',
    now: 10,
  });
  const glared = reduceCall(outgoing.state, {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'call-b',
    callKeyB64: 'theirs',
    now: 11,
  });
  assert.equal(glared.state.phase, CALL_PHASE.OUTGOING);
  assert.equal(glared.state.callId, 'call-a');
  assert.equal(glared.effects.length, 0);
});

test('offer-failed ends the outgoing call as failed and unreachable', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const failed = reduceCall(outgoing.state, {
    type: 'offer-failed',
    peerId: 'p1',
    callId: 'c1',
    now: 2,
  });
  assert.equal(failed.state.phase, CALL_PHASE.IDLE);
  const log = failed.effects.find((e) => e.type === 'call-log');
  assert.equal(log.outcome, 'failed');
  assert.ok(failed.effects.some((e) => e.type === 'toast' && e.message === 'Nicht erreichbar'));
});

test('remote ringing marks the outgoing call as klingelt', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const ringing = reduceCall(outgoing.state, {
    type: 'remote-ringing',
    peerId: 'p1',
    callId: 'c1',
    now: 2,
  });
  assert.equal(ringing.state.peerRinging, true);
});

test('wrong callId is ignored', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const ignored = reduceCall(outgoing.state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'other',
    codec: 'pcm16',
    now: 2,
  });
  assert.equal(ignored.state.phase, CALL_PHASE.OUTGOING);
  assert.equal(ignored.effects.length, 0);
});
