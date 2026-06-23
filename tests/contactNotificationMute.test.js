const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isContactNotificationMuted,
  isPeerNotificationMuted,
} = require('../src/shared/contactNotificationMute');

test('isContactNotificationMuted respects manual and timed mute', () => {
  const now = 1_700_000_000_000;

  assert.equal(isContactNotificationMuted(null, now), false);
  assert.equal(isContactNotificationMuted({ id: 'a' }, now), false);
  assert.equal(isContactNotificationMuted({ id: 'a', notifyMutedManual: true }, now), true);
  assert.equal(
    isContactNotificationMuted({ id: 'a', notifyMutedUntil: now + 60_000 }, now),
    true
  );
  assert.equal(
    isContactNotificationMuted({ id: 'a', notifyMutedUntil: now - 1 }, now),
    false
  );
});

test('isPeerNotificationMuted finds contact by peer id', () => {
  const now = 1_700_000_000_000;
  const contacts = [
    { id: 'peer-a', notifyMutedManual: true },
    { id: 'peer-b', notifyMutedUntil: now + 60_000 },
  ];

  assert.equal(isPeerNotificationMuted(contacts, 'peer-a', now), true);
  assert.equal(isPeerNotificationMuted(contacts, 'peer-b', now), true);
  assert.equal(isPeerNotificationMuted(contacts, 'peer-c', now), false);
  assert.equal(isPeerNotificationMuted(null, 'peer-a', now), false);
});
