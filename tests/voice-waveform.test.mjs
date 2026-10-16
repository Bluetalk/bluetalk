import assert from 'node:assert/strict';
import test from 'node:test';

import { downsampleWaveform, rmsToBar, WAVEFORM_BARS } from '../src/renderer/voice/waveform.js';
import { formatDurationMs, voiceFileName } from '../src/renderer/voice/format.js';
import { sanitizeVoiceMeta, isVoiceMessage, voicePreviewText } from '../src/renderer/voice/voiceMeta.js';

test('downsampleWaveform always yields 64 clamped bars', () => {
  assert.equal(downsampleWaveform([]).length, WAVEFORM_BARS);
  assert.deepEqual(downsampleWaveform([]), Array(64).fill(0));
  const up = downsampleWaveform([10, 20, 300, -4], 4);
  assert.deepEqual(up, [10, 20, 255, 0]);
  const down = downsampleWaveform(Array.from({ length: 128 }, (_, i) => i), 64);
  assert.equal(down.length, 64);
  assert.equal(down[0], 1);
  assert.ok(down[63] >= 126);
});

test('rmsToBar maps silence and peaks', () => {
  assert.equal(rmsToBar([]), 0);
  assert.equal(rmsToBar(new Float32Array(64)), 0);
  const loud = new Float32Array(32).fill(1);
  assert.equal(rmsToBar(loud), 255);
});

test('duration and filename formatting', () => {
  assert.equal(formatDurationMs(0), '0:00');
  assert.equal(formatDurationMs(12_000), '0:12');
  assert.equal(formatDurationMs(72_400), '1:12');
  const name = voiceFileName(new Date('2026-10-16T13:04:05'), 'webm');
  assert.equal(name, 'Sprachnachricht-2026-10-16-130405.webm');
});

test('sanitizeVoiceMeta keeps a valid payload and drops junk', () => {
  assert.equal(sanitizeVoiceMeta(null), null);
  assert.equal(sanitizeVoiceMeta({ durationMs: 0, waveform: [] }), null);
  const ok = sanitizeVoiceMeta({ durationMs: 1234, waveform: [1, 2], mime: 'audio/webm' });
  assert.equal(ok.durationMs, 1234);
  assert.equal(ok.waveform.length, 64);
  assert.equal(ok.mime, 'audio/webm');
  assert.equal(isVoiceMessage({ kind: 'file', voice: ok }), true);
  assert.equal(isVoiceMessage({ kind: 'file' }), false);
  assert.equal(voicePreviewText({ voice: { durationMs: 12000, waveform: [], mime: 'audio/webm' } }), '🎤 Sprachnachricht (0:12)');
});
