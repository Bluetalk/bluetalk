import assert from 'node:assert/strict';
import test from 'node:test';

import { createVideoDirection } from '../src/renderer/calls/videoPipeline.js';

function mockTrack() {
  let stopped = 0;
  const listeners = new Map();
  return {
    stop() { stopped += 1; },
    get stopped() { return stopped; },
    getSettings() { return { width: 640, height: 360 }; },
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
    contentHint: '',
  };
}

function installEncoder({ onConfigure } = {}) {
  const previous = globalThis.VideoEncoder;
  let encoderClosed = 0;
  globalThis.VideoEncoder = class {
    constructor() {}
    configure() { onConfigure?.(); }
    close() { encoderClosed += 1; }
    encode() {}
    get encodeQueueSize() { return 0; }
  };
  return {
    get encoderClosed() { return encoderClosed; },
    restore() {
      if (previous === undefined) delete globalThis.VideoEncoder;
      else globalThis.VideoEncoder = previous;
    },
  };
}

test('Kamera an → sofort auflegen: Track wird nach getUserMedia gestoppt', async () => {
  const track = mockTrack();
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
  let resolveGum;
  const gum = new Promise((resolve) => { resolveGum = resolve; });
  const encoder = installEncoder();
  let current = true;
  try {
    const pending = createVideoDirection({
      streamKind: 'camera',
      callKey: {},
      role: 'caller',
      codec: 'vp8',
      isCurrent: () => current,
      sendFragment: () => {},
      getUserMedia: () => gum,
    });
    current = false;
    resolveGum(stream);
    await assert.rejects(pending, /call_aborted/);
    assert.ok(track.stopped >= 1, 'Kamera-Track muss nach dem Auflegen gestoppt sein');
  } finally {
    encoder.restore();
  }
});

test('Auflegen während encoder.configure schließt Encoder und Track', async () => {
  const track = mockTrack();
  const stream = {
    getVideoTracks: () => [track],
    getTracks: () => [track],
  };
  let current = true;
  const encoder = installEncoder({ onConfigure: () => { current = false; } });
  try {
    await assert.rejects(createVideoDirection({
      streamKind: 'camera',
      callKey: {},
      role: 'caller',
      codec: 'vp8',
      isCurrent: () => current,
      sendFragment: () => {},
      getUserMedia: async () => stream,
    }), /call_aborted/);
    assert.ok(track.stopped >= 1);
    assert.ok(encoder.encoderClosed >= 1);
  } finally {
    encoder.restore();
  }
});
