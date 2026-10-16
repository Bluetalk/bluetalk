import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_MAX_PACKED_FRAMES,
  opusFrameTimestampUs,
  packLengthPrefixedFrames,
  unpackLengthPrefixedFrames,
} from '../src/renderer/calls/frames.js';

test('packs and unpacks three opus-like frames', () => {
  const a = Uint8Array.from([1, 2, 3]);
  const b = Uint8Array.from([9]);
  const c = Uint8Array.from([7, 7, 7, 7]);
  const packed = packLengthPrefixedFrames([a, b, c]);
  assert.deepEqual([...packed.slice(0, 2)], [0, 3]);
  const frames = unpackLengthPrefixedFrames(packed);
  assert.equal(frames.length, 3);
  assert.deepEqual([...frames[0]], [1, 2, 3]);
  assert.deepEqual([...frames[1]], [9]);
  assert.deepEqual([...frames[2]], [7, 7, 7, 7]);
});

test('opus timestamps are monotone: seq * 60 ms + frame * 20 ms in µs', () => {
  assert.equal(opusFrameTimestampUs(0, 0), 0);
  assert.equal(opusFrameTimestampUs(0, 1), 20_000);
  assert.equal(opusFrameTimestampUs(0, 2), 40_000);
  assert.equal(opusFrameTimestampUs(1, 0), 60_000);
  assert.equal(opusFrameTimestampUs(2, 2), 160_000);
});

test('truncated payload stops without throwing', () => {
  const packed = Uint8Array.from([0, 5, 1, 2]);
  const frames = unpackLengthPrefixedFrames(packed);
  assert.equal(frames.length, 0);
});

test('unpacking stops after the packed-frame cap', () => {
  const chunks = Array.from({ length: AUDIO_MAX_PACKED_FRAMES + 4 }, () => Uint8Array.from([1]));
  const packed = packLengthPrefixedFrames(chunks);
  const frames = unpackLengthPrefixedFrames(packed);
  assert.equal(frames.length, AUDIO_MAX_PACKED_FRAMES);
});

test('oversized packed frame is not unpacked', () => {
  const packed = packLengthPrefixedFrames([new Uint8Array(5000)]);
  const frames = unpackLengthPrefixedFrames(packed);
  assert.equal(frames.length, 0);
});
