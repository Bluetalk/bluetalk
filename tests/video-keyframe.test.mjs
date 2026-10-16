import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyframeController } from '../src/renderer/calls/videoKeyframe.js';

test('requests a keyframe at most once per second and drops deltas until it arrives', () => {
  const gate = createKeyframeController({ minIntervalMs: 1000 });
  const first = gate.onGap(1000);
  assert.equal(first.request, true);
  assert.equal(gate.shouldDropDelta(), true);
  const second = gate.onGap(1500);
  assert.equal(second.request, false);
  const third = gate.onGap(2000);
  assert.equal(third.request, true);
  gate.onKeyframe();
  assert.equal(gate.shouldDropDelta(), false);
  assert.equal(gate.isWaiting(), false);
});
