import assert from 'node:assert/strict';
import test from 'node:test';

import { createJitterBuffer } from '../src/renderer/calls/jitterBuffer.js';
import { createPlaybackRing, PLAYBACK_MAX_SAMPLES, PLAYBACK_TARGET_SAMPLES } from '../src/renderer/calls/playbackBuffer.js';

test('plays packets in seq order without waiting for a target fill', () => {
  const buf = createJitterBuffer({ packetMs: 60, waitMs: 60 });
  buf.push(2, 'c');
  buf.push(0, 'a');
  buf.push(1, 'b');
  assert.deepEqual(buf.pull(), { type: 'packet', seq: 0, payload: 'a' });
  assert.deepEqual(buf.pull(), { type: 'packet', seq: 1, payload: 'b' });
  assert.deepEqual(buf.pull(), { type: 'packet', seq: 2, payload: 'c' });
});

test('waits one packet duration for a missing seq, then reports loss', () => {
  let now = 1000;
  const buf = createJitterBuffer({ packetMs: 60, waitMs: 60, now: () => now });
  buf.push(0, 'a');
  buf.push(2, 'c');
  assert.equal(buf.pull(now).payload, 'a');
  assert.equal(buf.pull(now), null);
  now = 1040;
  assert.equal(buf.pull(now), null);
  now = 1060;
  assert.deepEqual(buf.pull(now), { type: 'loss', seq: 1 });
  assert.deepEqual(buf.pull(now), { type: 'packet', seq: 2, payload: 'c' });
});

test('ignores duplicates and old seq', () => {
  const buf = createJitterBuffer({ packetMs: 60, waitMs: 60 });
  assert.equal(buf.push(0, 'a'), true);
  assert.equal(buf.push(0, 'dup'), false);
  assert.equal(buf.pull().payload, 'a');
  assert.equal(buf.push(0, 'old'), false);
  assert.equal(buf.push(-1, 'no'), false);
});

test('playback ring prefills 80 ms before starting', () => {
  const ring = createPlaybackRing();
  const out = new Float32Array(128);
  ring.push(new Float32Array(PLAYBACK_TARGET_SAMPLES - 10).fill(0.5));
  const before = ring.pull(out);
  assert.equal(before.playing, false);
  assert.ok(out.every((s) => s === 0));
  ring.push(new Float32Array(20).fill(0.5));
  const started = ring.pull(out);
  assert.equal(started.playing, true);
  assert.equal(out[0], 0.5);
});

test('playback ring rebuffers on underrun and drops oldest above 300 ms', () => {
  const ring = createPlaybackRing();
  ring.push(new Float32Array(PLAYBACK_TARGET_SAMPLES).fill(0.2));
  const startBuf = new Float32Array(128);
  assert.equal(ring.pull(startBuf).playing, true);

  ring.push(new Float32Array(PLAYBACK_MAX_SAMPLES + 4800).fill(0.9));
  assert.ok(ring.filled <= PLAYBACK_MAX_SAMPLES);

  const drain = new Float32Array(ring.filled + 8);
  const result = ring.pull(drain);
  assert.equal(result.underrun, true);
  assert.equal(result.playing, false);
  const silence = new Float32Array(64);
  const waiting = ring.pull(silence);
  assert.equal(waiting.playing, false);
  assert.ok(silence.every((s) => s === 0));
});
