import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALL_PHASE,
  VIDEO_PEER_UNSUPPORTED_HINT,
  createIdleCallState,
  peerSupportsVideo,
  reduceCall,
  videoControlHint,
} from '../src/renderer/calls/callState.js';

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

function activeCall() {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1000,
  });
  return reduceCall(outgoing.state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'c1',
    codec: 'pcm16',
    now: 1500,
  });
}

test('local hangup from active sends end with peerId and callId after going idle', () => {
  const ended = reduceCall(activeCall().state, { type: 'local-end', now: 2000 });
  assert.equal(ended.state.phase, CALL_PHASE.IDLE);
  assert.equal(ended.state.peerId, null);
  assert.equal(ended.state.callId, null);
  const sig = ended.effects.find((e) => e.type === 'send-signal' && e.op === 'end');
  assert.ok(sig, 'end-Signal muss gesendet werden');
  assert.equal(sig.peerId, 'p1');
  assert.equal(sig.callId, 'c1');
  assert.ok(ended.effects.some((e) => e.type === 'stop-media'));
});

test('local cancel from outgoing sends cancel with ids', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const canceled = reduceCall(outgoing.state, { type: 'local-cancel', now: 2 });
  assert.equal(canceled.state.phase, CALL_PHASE.IDLE);
  const sig = canceled.effects.find((e) => e.type === 'send-signal' && e.op === 'cancel');
  assert.equal(sig.peerId, 'p1');
  assert.equal(sig.callId, 'c1');
});

test('local reject from incoming sends reject with ids', () => {
  const incoming = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const rejected = reduceCall(incoming.state, { type: 'local-reject', now: 2 });
  const sig = rejected.effects.find((e) => e.type === 'send-signal' && e.op === 'reject');
  assert.equal(sig.peerId, 'p1');
  assert.equal(sig.callId, 'c1');
});

test('remote end during active hangs up locally without sending another end', () => {
  const ended = reduceCall(activeCall().state, {
    type: 'remote-end',
    peerId: 'p1',
    callId: 'c1',
    now: 2000,
  });
  assert.equal(ended.state.phase, CALL_PHASE.IDLE);
  assert.ok(!ended.effects.some((e) => e.type === 'send-signal' && e.op === 'end'));
  assert.ok(ended.effects.some((e) => e.type === 'stop-media'));
});

test('remote accept binds remoteDevice and cancels other ringing devices', () => {
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
    fromDevice: 'desk',
    now: 2,
  });
  const ringing2 = reduceCall(ringing.state, {
    type: 'remote-ringing',
    peerId: 'p1',
    callId: 'c1',
    fromDevice: 'web',
    now: 3,
  });
  const accepted = reduceCall(ringing2.state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'c1',
    codec: 'pcm16',
    fromDevice: 'web',
    now: 4,
  });
  assert.equal(accepted.state.remoteDevice, 'web');
  const cancel = accepted.effects.find((e) => e.type === 'cancel-other-devices');
  assert.equal(cancel.exceptDevice, 'web');
  assert.ok(cancel.ringingDevices.includes('desk'));
});

test('busy from one device is ignored while another can still ring', () => {
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
    fromDevice: 'desk',
    now: 2,
  });
  const ringing2 = reduceCall(ringing.state, {
    type: 'remote-ringing',
    peerId: 'p1',
    callId: 'c1',
    fromDevice: 'web',
    now: 3,
  });
  const busyOne = reduceCall(ringing2.state, {
    type: 'remote-busy',
    peerId: 'p1',
    callId: 'c1',
    fromDevice: 'desk',
    now: 4,
  });
  assert.equal(busyOne.state.phase, CALL_PHASE.OUTGOING);
  const busyAll = reduceCall(busyOne.state, {
    type: 'remote-busy',
    peerId: 'p1',
    callId: 'c1',
    fromDevice: 'web',
    now: 5,
  });
  assert.equal(busyAll.state.phase, CALL_PHASE.IDLE);
  assert.equal(busyAll.effects.find((e) => e.type === 'call-log')?.outcome, 'busy');
});

test('answered-elsewhere on incoming stops without missed log', () => {
  const incoming = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  const canceled = reduceCall(incoming.state, {
    type: 'remote-cancel',
    peerId: 'p1',
    callId: 'c1',
    reason: 'answered-elsewhere',
    now: 2,
  });
  assert.equal(canceled.state.phase, CALL_PHASE.IDLE);
  assert.ok(!canceled.effects.some((e) => e.type === 'call-log'));
});

test('local camera on during active sends video-on with call ids', () => {
  const ready = {
    ...activeCall().state,
    remoteCapabilities: { video: ['vp8'], screen: true },
  };
  const toggled = reduceCall(ready, {
    type: 'local-camera',
    on: true,
    now: 2000,
  });
  assert.equal(toggled.state.localCamera, true);
  const sig = toggled.effects.find((e) => e.type === 'send-signal' && e.op === 'video-on');
  assert.equal(sig.peerId, 'p1');
  assert.equal(sig.callId, 'c1');
  assert.equal(sig.stream, 'camera');
});

test('offer without capabilities.video marks a 2.3 peer as without video', () => {
  const incoming = reduceCall(createIdleCallState(), {
    type: 'remote-offer',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    now: 1,
  });
  assert.equal(peerSupportsVideo(incoming.state.remoteCapabilities), false);
  assert.equal(
    videoControlHint(true, peerSupportsVideo(incoming.state.remoteCapabilities)),
    VIDEO_PEER_UNSUPPORTED_HINT,
  );
});

test('camera toggle is ignored if the peer did not report capabilities.video', () => {
  const toggled = reduceCall(activeCall().state, {
    type: 'local-camera',
    on: true,
    now: 2000,
  });
  assert.equal(toggled.state.localCamera, false);
  assert.equal(toggled.effects.length, 0);
});

test('video call to a 2.3 peer does not auto-start camera', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    media: { video: true },
    capabilities: { video: ['vp8'] },
    now: 1,
  });
  const accepted = reduceCall(outgoing.state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'c1',
    codec: 'pcm16',
    now: 2,
  });
  assert.equal(accepted.state.localCamera, false);
  assert.ok(!accepted.effects.some((e) => e.type === 'start-camera'));
});

test('accept with remote capabilities.video starts the camera when requested', () => {
  const outgoing = reduceCall(createIdleCallState(), {
    type: 'local-start',
    peerId: 'p1',
    callId: 'c1',
    callKeyB64: 'k',
    media: { video: true },
    capabilities: { video: ['vp8'] },
    now: 1,
  });
  const accepted = reduceCall(outgoing.state, {
    type: 'remote-accept',
    peerId: 'p1',
    callId: 'c1',
    codec: 'pcm16',
    capabilities: { video: ['vp8'], screen: true },
    now: 2,
  });
  assert.equal(accepted.state.localCamera, true);
  assert.ok(accepted.effects.some((e) => e.type === 'start-camera'));
});
