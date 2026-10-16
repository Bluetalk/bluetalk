import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedVideoCodec, pickVideoCodec, probeVideoCodecs } from '../src/renderer/calls/videoCaps.js';

test('prefers VP8 when both sides list it, else H.264', () => {
  assert.equal(pickVideoCodec(['vp8', 'avc1'], ['avc1', 'vp8']), 'vp8');
  assert.equal(pickVideoCodec(['avc1'], ['avc1.42E01F']), 'avc1');
  assert.equal(pickVideoCodec(['vp8'], ['avc1']), null);
  assert.equal(pickVideoCodec([], ['vp8']), null);
});

test('only VP8 and AVC1 are on the codec allowlist', () => {
  assert.equal(isAllowedVideoCodec('vp8'), true);
  assert.equal(isAllowedVideoCodec('avc1.42E01F'), true);
  assert.equal(isAllowedVideoCodec('hev1'), false);
  assert.equal(isAllowedVideoCodec(''), false);
});

test('probeVideoCodecs uses injected support hooks', async () => {
  const caps = await probeVideoCodecs({
    isEncoderSupported: async (cfg) => ({ supported: cfg.codec === 'vp8' }),
    isDecoderSupported: async (cfg) => ({ supported: cfg.codec === 'vp8' }),
  });
  assert.deepEqual(caps.video, ['vp8']);
  assert.equal(caps.screen, true);
});
