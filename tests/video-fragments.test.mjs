import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VIDEO_MAX_FRAGMENT_BYTES,
  createFrameReassembler,
  splitVideoFrame,
} from '../src/renderer/calls/videoFragments.js';

test('splits a frame into fragments of at most 24 KiB', () => {
  const bytes = new Uint8Array(VIDEO_MAX_FRAGMENT_BYTES * 2 + 10);
  bytes[0] = 9;
  bytes[bytes.length - 1] = 7;
  const parts = splitVideoFrame(bytes);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((part) => part.length <= VIDEO_MAX_FRAGMENT_BYTES));
  const joined = new Uint8Array(bytes.length);
  joined.set(parts[0], 0);
  joined.set(parts[1], parts[0].length);
  joined.set(parts[2], parts[0].length + parts[1].length);
  assert.deepEqual([...joined], [...bytes]);
});

test('reassembles fragments by start seq and discards stale frames', () => {
  const reassembler = createFrameReassembler({ ttlMs: 1000, now: () => 1000 });
  const a = Uint8Array.from([1, 2]);
  const b = Uint8Array.from([3, 4, 5]);
  assert.equal(reassembler.push({ seq: 10, frag: 0, frags: 2, data: a, stream: 'camera', ts: 1, key: true }), null);
  const done = reassembler.push({ seq: 11, frag: 1, frags: 2, data: b, stream: 'camera', ts: 1, key: true });
  assert.ok(done);
  assert.equal(done.key, true);
  assert.deepEqual([...done.bytes], [1, 2, 3, 4, 5]);
});

test('incomplete frames are dropped after 1 s', () => {
  let now = 1000;
  const reassembler = createFrameReassembler({ ttlMs: 1000, now: () => now });
  reassembler.push({ seq: 0, frag: 0, frags: 2, data: Uint8Array.from([1]), stream: 'screen' });
  assert.equal(reassembler.size, 1);
  now = 2001;
  const late = reassembler.push({ seq: 1, frag: 1, frags: 2, data: Uint8Array.from([2]), stream: 'screen' });
  assert.equal(late, null);
  assert.equal(reassembler.size, 1);
});

test('single-fragment frames complete immediately', () => {
  const reassembler = createFrameReassembler();
  const frame = reassembler.push({
    seq: 0,
    frag: 0,
    frags: 1,
    data: Uint8Array.from([8, 8]),
    codec: 'vp8',
    w: 640,
    h: 360,
    key: true,
  });
  assert.deepEqual([...frame.bytes], [8, 8]);
  assert.equal(frame.codec, 'vp8');
});

test('huge frags from the peer is rejected without allocating', () => {
  const reassembler = createFrameReassembler();
  assert.equal(reassembler.push({
    seq: 0,
    frag: 0,
    frags: 2 ** 32,
    data: Uint8Array.from([1]),
  }), null);
  assert.equal(reassembler.push({
    seq: 0,
    frag: 0,
    frags: 1e12,
    data: Uint8Array.from([1]),
  }), null);
  assert.equal(reassembler.size, 0);
});

test('at most 8 open frames per stream, oldest dropped', () => {
  const reassembler = createFrameReassembler();
  for (let i = 0; i < 12; i += 1) {
    reassembler.push({
      seq: i * 2,
      frag: 0,
      frags: 2,
      data: Uint8Array.from([i]),
      stream: 'camera',
    });
  }
  assert.equal(reassembler.size, 8);
});

test('reassembly buffer stays within the byte cap', () => {
  const reassembler = createFrameReassembler({ maxBytes: 50, maxOpenFrames: 8 });
  reassembler.push({ seq: 0, frag: 0, frags: 2, data: new Uint8Array(40), stream: 'camera' });
  reassembler.push({ seq: 2, frag: 0, frags: 2, data: new Uint8Array(40), stream: 'camera' });
  assert.ok(reassembler.bufferedBytes <= 50);
  assert.equal(reassembler.size, 1);
});

test('oversized fragment, implausible size, codec and desc are dropped', () => {
  const reassembler = createFrameReassembler();
  assert.equal(reassembler.push({
    seq: 0, frag: 0, frags: 1, data: new Uint8Array(VIDEO_MAX_FRAGMENT_BYTES + 1),
  }), null);
  assert.equal(reassembler.push({
    seq: 0, frag: 0, frags: 1, data: Uint8Array.from([1]), w: 9999, h: 10,
  }), null);
  assert.equal(reassembler.push({
    seq: 0, frag: 0, frags: 1, data: Uint8Array.from([1]), codec: 'not-a-codec',
  }), null);
  assert.equal(reassembler.push({
    seq: 0, frag: 0, frags: 1, data: Uint8Array.from([1]), desc: new Uint8Array(20_000),
  }), null);
});
