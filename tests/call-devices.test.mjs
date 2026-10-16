import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRemoteBusy,
  devicesToCancel,
  shouldDropBoundMessage,
  uniqueDevices,
} from '../src/renderer/calls/callDevices.js';

test('uniqueDevices drops empties and duplicates', () => {
  assert.deepEqual(uniqueDevices(['web', '', 'web', 'desk', null]), ['web', 'desk']);
});

test('bound messages from other devices are dropped, missing fromDevice is kept', () => {
  assert.equal(shouldDropBoundMessage('web', 'desk'), true);
  assert.equal(shouldDropBoundMessage('web', 'web'), false);
  assert.equal(shouldDropBoundMessage('web', null), false);
  assert.equal(shouldDropBoundMessage(null, 'desk'), false);
});

test('busy of one ringing device does not end the call', () => {
  const once = applyRemoteBusy({ ringingDevices: ['web', 'desk'], busyDevices: [] }, 'web');
  assert.equal(once.endBusy, false);
  assert.deepEqual(once.busy, ['web']);
  const all = applyRemoteBusy({ ringingDevices: once.ringing, busyDevices: once.busy }, 'desk');
  assert.equal(all.endBusy, true);
});

test('busy without fromDevice ends immediately (legacy client)', () => {
  const result = applyRemoteBusy({ ringingDevices: ['web'], busyDevices: [] }, null);
  assert.equal(result.endBusy, true);
});

test('devicesToCancel skips the accepting device', () => {
  assert.deepEqual(devicesToCancel(['web', 'desk', 'web'], 'web'), ['desk']);
});
