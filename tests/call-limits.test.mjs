import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_MAX_PACKET_B64,
  VIDEO_MAX_FRAGS,
  VIDEO_MAX_PACKET_B64,
  sanitizeCallAudio,
  sanitizeCallOffer,
  sanitizeCallSignal,
  sanitizeCallVideo,
} from '../src/renderer/calls/callLimits.js';

test('call-signal drops unknown ops and oversized fields', () => {
  assert.equal(sanitizeCallSignal({ op: 'explode', callId: 'c1' }), null);
  assert.equal(sanitizeCallSignal({ op: 'end', callId: 'x'.repeat(500) }), null);
  assert.equal(sanitizeCallSignal({ op: 'end' }), null);
  const ok = sanitizeCallSignal({ op: 'end', callId: 'c1', junk: 'ignore-me' });
  assert.equal(ok.op, 'end');
  assert.equal(ok.callId, 'c1');
  assert.equal(ok.junk, undefined);
});

test('call-signal keeps only bounded accept/keyframe fields', () => {
  const accept = sanitizeCallSignal({
    op: 'accept',
    callId: 'c1',
    codec: 'opus',
    capabilities: { video: ['vp8', 'evil'], screen: true },
  });
  assert.equal(accept.codec, 'opus');
  assert.deepEqual(accept.capabilities.video, ['vp8']);
  const key = sanitizeCallSignal({ op: 'keyframe', callId: 'c1', stream: 'screen' });
  assert.equal(key.stream, 'screen');
});

test('call-offer from 2.3 without capabilities stays without video', () => {
  const offer = sanitizeCallOffer({
    callId: 'c1',
    callKeyB64: 'a'.repeat(44),
    codecs: ['opus', 'pcm16'],
  });
  assert.deepEqual(offer.capabilities.video, []);
  assert.equal(offer.media.video, false);
});

test('call-audio rejects bad seq and oversized packets', () => {
  assert.equal(sanitizeCallAudio({ callId: 'c1', seq: -1, data: 'abcd' }), null);
  assert.equal(sanitizeCallAudio({ callId: 'c1', seq: 1.5, data: 'abcd' }), null);
  assert.equal(sanitizeCallAudio({
    callId: 'c1',
    seq: 1,
    data: 'a'.repeat(AUDIO_MAX_PACKET_B64 + 1),
  }), null);
  const ok = sanitizeCallAudio({ callId: 'c1', seq: 3, data: 'abcd' });
  assert.equal(ok.seq, 3);
});

test('call-video rejects huge frags, oversized payload and bad codec', () => {
  const data = 'abcd';
  assert.equal(sanitizeCallVideo({
    callId: 'c1', seq: 0, frag: 0, frags: VIDEO_MAX_FRAGS + 1, data,
  }), null);
  assert.equal(sanitizeCallVideo({
    callId: 'c1', seq: 0, frag: 0, frags: 1e12, data,
  }), null);
  assert.equal(sanitizeCallVideo({
    callId: 'c1', seq: 0, frag: 0, frags: 1, data: 'a'.repeat(VIDEO_MAX_PACKET_B64 + 1),
  }), null);
  assert.equal(sanitizeCallVideo({
    callId: 'c1', seq: 0, frag: 0, frags: 1, data, codec: 'hev1',
  }), null);
  const ok = sanitizeCallVideo({
    callId: 'c1', seq: 9, frag: 0, frags: 1, data, codec: 'vp8', w: 640, h: 360,
  });
  assert.equal(ok.frags, 1);
  assert.equal(ok.codec, 'vp8');
});
