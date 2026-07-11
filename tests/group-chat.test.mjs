import assert from 'node:assert/strict';
import test from 'node:test';

import groupChat from '../src/shared/group-chat.js';

const {
  applyGroupEvent,
  createGroup,
  createGroupAcceptEvent,
  createGroupInviteEvent,
  getGroupMember,
  validateIncomingGroupMessage,
} = groupChat;

test('group membership changes remain admin- and invite-gated', () => {
  let group = createGroup({
    id: 'group:12345678',
    name: 'Projekt',
    creator: { peerId: 'bt-admin', displayName: 'Admin' },
    members: [{ peerId: 'bt-alice', displayName: 'Alice' }],
  });
  const unauthorized = createGroupInviteEvent({
    groupId: group.id,
    actorId: 'bt-alice',
    invitee: { peerId: 'bt-mallory', displayName: 'Mallory' },
  });
  assert.equal(applyGroupEvent(group, unauthorized, 'bt-alice').ok, false);

  const invite = createGroupInviteEvent({
    groupId: group.id,
    actorId: 'bt-admin',
    invitee: { peerId: 'bt-carol', displayName: 'Carol' },
  });
  group = applyGroupEvent(group, invite, 'bt-admin').group;
  assert.equal(getGroupMember(group, 'bt-carol').state, 'invited');
  const accept = createGroupAcceptEvent({ groupId: group.id, actorId: 'bt-carol' });
  group = applyGroupEvent(group, accept, 'bt-carol').group;
  assert.equal(getGroupMember(group, 'bt-carol').state, 'active');
});

test('group messages reject a sender that is not an active member', () => {
  const group = createGroup({
    id: 'group:12345678',
    name: 'Projekt',
    creator: { peerId: 'bt-admin', displayName: 'Admin' },
    members: [{ peerId: 'bt-alice', displayName: 'Alice' }],
  });
  const result = validateIncomingGroupMessage(group, {
    kind: 'group-message-v1',
    protocolVersion: 1,
    groupId: group.id,
    senderPeerId: 'bt-mallory',
    messageId: 'm-1',
    payload: { kind: 'chat', content: 'forged' },
  }, 'bt-mallory');
  assert.equal(result.ok, false);
});

