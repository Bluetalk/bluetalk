import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCallIv, parseCallIv, CALL_DIR_OUT, CALL_DIR_IN } from '../src/renderer/calls/iv.js';

test('IV is 12 bytes: 4-byte direction BE || 8-byte seq BE', () => {
  const iv = buildCallIv(CALL_DIR_OUT, 1);
  assert.equal(iv.length, 12);
  assert.deepEqual([...iv.slice(0, 4)], [0, 0, 0, 1]);
  assert.deepEqual([...iv.slice(4)], [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(parseCallIv(iv), { direction: CALL_DIR_OUT, seq: 1 });
});

test('callee direction and large seq round-trip', () => {
  const seq = 0x1ffffffff;
  const iv = buildCallIv(CALL_DIR_IN, seq);
  assert.deepEqual([...iv.slice(0, 4)], [0, 0, 0, 2]);
  const parsed = parseCallIv(iv);
  assert.equal(parsed.direction, CALL_DIR_IN);
  assert.equal(parsed.seq, seq);
});
