import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CALL_DIR_OUT,
  CALL_IV_CAM_IN,
  CALL_IV_CAM_OUT,
  CALL_IV_SCREEN_IN,
  CALL_IV_SCREEN_OUT,
  buildCallIv,
  callVideoIvDirection,
  parseCallIv,
} from '../src/renderer/calls/iv.js';

test('camera and screen IVs occupy separate spaces from audio', () => {
  assert.equal(callVideoIvDirection('camera', 'caller', true), CALL_IV_CAM_OUT);
  assert.equal(callVideoIvDirection('camera', 'caller', false), CALL_IV_CAM_IN);
  assert.equal(callVideoIvDirection('camera', 'callee', true), CALL_IV_CAM_IN);
  assert.equal(callVideoIvDirection('screen', 'caller', true), CALL_IV_SCREEN_OUT);
  assert.equal(callVideoIvDirection('screen', 'callee', true), CALL_IV_SCREEN_IN);
  assert.notEqual(CALL_IV_CAM_OUT, CALL_DIR_OUT);
  assert.notEqual(CALL_IV_SCREEN_OUT, CALL_IV_CAM_OUT);
});

test('video IVs are 12 bytes and round-trip seq', () => {
  const iv = buildCallIv(CALL_IV_CAM_OUT, 42);
  assert.equal(iv.length, 12);
  assert.deepEqual([...iv.slice(0, 4)], [0, 0, 0, 0x11]);
  assert.deepEqual(parseCallIv(iv), { direction: CALL_IV_CAM_OUT, seq: 42 });
});

test('same seq in audio vs camera yields different IVs', () => {
  const audio = buildCallIv(CALL_DIR_OUT, 7);
  const camera = buildCallIv(CALL_IV_CAM_OUT, 7);
  assert.notDeepEqual([...audio], [...camera]);
});
