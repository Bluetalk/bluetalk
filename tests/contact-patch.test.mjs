import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyContactPatchToList,
  isPlaceholderDisplayName,
  upsertContactNameFromIncomingMessage,
} from '../src/renderer/app/contactPatch.js';
import { buildProfilePayload } from '../src/renderer/app/profileShare.js';

test('undefined profile fields do not wipe stored name and picture', () => {
  const prev = [{
    id: 'p1',
    name: 'Ada',
    profilePicture: 'data:image/png;base64,abc',
    bio: 'hi',
  }];
  const next = applyContactPatchToList(prev, {
    id: 'p1',
    name: undefined,
    profilePicture: undefined,
    bio: undefined,
    address: 'relay://p1',
  });
  assert.equal(next[0].name, 'Ada');
  assert.equal(next[0].profilePicture, 'data:image/png;base64,abc');
  assert.equal(next[0].bio, 'hi');
  assert.equal(next[0].address, 'relay://p1');
});

test('placeholder handshake name does not replace a real contact name', () => {
  const prev = [{ id: 'p1', name: 'Ada', profilePicture: 'pic' }];
  const byDefault = applyContactPatchToList(prev, { id: 'p1', name: 'BlueTalk user' });
  assert.equal(byDefault[0].name, 'Ada');
  const byPeerId = applyContactPatchToList(prev, { id: 'p1', name: 'p1' });
  assert.equal(byPeerId[0].name, 'Ada');
  const byAnonymous = applyContactPatchToList(prev, { id: 'p1', name: 'Anonymous' });
  assert.equal(byAnonymous[0].name, 'Ada');
});

test('real incoming name still updates the contact', () => {
  const prev = [{ id: 'p1', name: 'p1' }];
  const next = applyContactPatchToList(prev, { id: 'p1', name: 'Ada', profilePicture: 'pic' });
  assert.equal(next[0].name, 'Ada');
  assert.equal(next[0].profilePicture, 'pic');
});

test('notifyMutedUntil undefined still clears the mute timestamp', () => {
  const prev = [{ id: 'p1', name: 'Ada', notifyMutedUntil: 99 }];
  const next = applyContactPatchToList(prev, { id: 'p1', notifyMutedUntil: undefined });
  assert.equal(next[0].name, 'Ada');
  assert.equal(Object.prototype.hasOwnProperty.call(next[0], 'notifyMutedUntil'), false);
});

test('synced inbound messages fill a missing contact name', () => {
  const created = upsertContactNameFromIncomingMessage([], 'p1', {
    from: 'p1',
    sender: 'Ada',
    timestamp: 10,
  });
  assert.equal(created.changed, true);
  assert.equal(created.contacts[0].name, 'Ada');

  const kept = upsertContactNameFromIncomingMessage(created.contacts, 'p1', {
    from: 'p1',
    sender: 'Other',
  });
  assert.equal(kept.changed, false);
  assert.equal(kept.contacts[0].name, 'Ada');

  const self = upsertContactNameFromIncomingMessage([], 'p1', {
    from: 'self',
    sender: 'Me',
  });
  assert.equal(self.changed, false);
});

test('placeholder names are recognized', () => {
  assert.equal(isPlaceholderDisplayName('BlueTalk user'), true);
  assert.equal(isPlaceholderDisplayName('Ada'), false);
});

test('profile payload includes name and picture', () => {
  const payload = buildProfilePayload({
    displayName: 'Ada',
    bio: 'hi',
    profilePicture: 'data:image/png;base64,abc',
  });
  assert.equal(payload.kind, 'profile');
  assert.equal(payload.displayName, 'Ada');
  assert.equal(payload.profilePicture, 'data:image/png;base64,abc');
  assert.ok(Array.isArray(payload.features));
});

test('name hydration skips group chats', () => {
  const groupId = 'group:' + 'a'.repeat(16);
  const result = upsertContactNameFromIncomingMessage([], groupId, { from: 'bt2_x', sender: 'X' });
  assert.equal(result.changed, false);
});
