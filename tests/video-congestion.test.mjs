import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CAMERA_BITRATE_BPS,
  VIDEO_MAX_IN_FLIGHT,
  createCongestionController,
} from '../src/renderer/calls/videoCongestion.js';

test('limits in-flight frames per stream and skips when audio is busy', () => {
  let audioBusy = false;
  const ctl = createCongestionController({ audioBusy: () => audioBusy });
  for (let i = 0; i < VIDEO_MAX_IN_FLIGHT; i += 1) {
    assert.equal(ctl.canSend('camera'), true);
    ctl.onQueued('camera');
  }
  assert.equal(ctl.canSend('camera'), false);
  assert.equal(ctl.canSend('screen'), true);
  ctl.onDone('camera');
  assert.equal(ctl.canSend('camera'), true);
  audioBusy = true;
  assert.equal(ctl.canSend('camera'), false);
});

test('congestion lowers bitrate stepwise but not below the floor', () => {
  const ctl = createCongestionController();
  assert.equal(ctl.currentBitrate('camera'), CAMERA_BITRATE_BPS);
  const next = ctl.onCongested('camera');
  assert.ok(next < CAMERA_BITRATE_BPS);
  for (let i = 0; i < 20; i += 1) ctl.onCongested('camera');
  assert.equal(ctl.currentBitrate('camera'), 80_000);
});
