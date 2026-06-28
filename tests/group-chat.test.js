const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const groupChatUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'shared', 'group-chat.js')).href;

test('group chat helpers', async () => {
  const {
    GROUP_MESSAGE_KIND,
    applyGroupEvent,
    buildTargetedGroupRoute,
    createChatRef,
    createGroup,
    createGroupAcceptEvent,
    createGroupInviteEvent,
    createGroupUpdateEvent,
    deriveGroupDeliveryStatus,
    getGroupMember,
    rememberGroupEventId,
    validateIncomingGroupMessage,
  } = await import(groupChatUrl);

  function fixture() {
    return createGroup({
      id: 'group:12345678',
      name: 'Projekt',
      creator: { peerId: 'bt-admin', displayName: 'Admin' },
      members: [
        { peerId: 'bt-alice', displayName: 'Alice' },
        { peerId: 'bt-bob', displayName: 'Bob', state: 'active' },
      ],
    });
  }

  test('createGroupInviteEvent and applyGroupEvent add invited member', () => {
    const group = fixture();
    const event = createGroupInviteEvent({
      groupId: group.id,
      actorId: 'bt-admin',
      invitee: { peerId: 'bt-carol', displayName: 'Carol' },
    });
    const applied = applyGroupEvent(group, event, 'bt-admin');
    assert.equal(applied.ok, true);
    assert.equal(getGroupMember(applied.group, 'bt-carol')?.state, 'invited');
  });

  test('createGroupAcceptEvent activates invited member', () => {
    let group = fixture();
    const invite = createGroupInviteEvent({
      groupId: group.id,
      actorId: 'bt-admin',
      invitee: { peerId: 'bt-carol', displayName: 'Carol' },
    });
    group = applyGroupEvent(group, invite, 'bt-admin').group;
    const accept = createGroupAcceptEvent({
      groupId: group.id,
      actorId: 'bt-carol',
    });
    const applied = applyGroupEvent(group, accept, 'bt-carol');
    assert.equal(applied.ok, true);
    assert.equal(getGroupMember(applied.group, 'bt-carol')?.state, 'active');
  });

  test('createGroupUpdateEvent renames group for admin', () => {
    const group = fixture();
    const event = createGroupUpdateEvent({
      groupId: group.id,
      actorId: 'bt-admin',
      patch: { name: 'Neu' },
    });
    const applied = applyGroupEvent(group, event, 'bt-admin');
    assert.equal(applied.ok, true);
    assert.equal(applied.group.name, 'Neu');
  });

  test('validateIncomingGroupMessage rejects foreign sender', () => {
    const group = fixture();
    const message = {
      kind: GROUP_MESSAGE_KIND,
      groupId: group.id,
      senderId: 'bt-alice',
      sender: 'Alice',
      content: 'Hallo',
    };
    const result = validateIncomingGroupMessage(group, message, 'bt-bob');
    assert.equal(result.ok, false);
  });

  test('buildTargetedGroupRoute returns peer ids except sender', () => {
    const group = fixture();
    const route = buildTargetedGroupRoute(group, 'bt-admin');
    assert.deepEqual(route.sort(), ['bt-alice', 'bt-bob'].sort());
  });

  test('deriveGroupDeliveryStatus summarizes member receipts', () => {
    const group = fixture();
    const status = deriveGroupDeliveryStatus(group, {
      'bt-alice': 'delivered',
      'bt-bob': 'pending',
    });
    assert.equal(status.deliveredCount, 1);
    assert.equal(status.pendingCount, 1);
  });

  test('rememberGroupEventId deduplicates', () => {
    const first = rememberGroupEventId([], 'evt-1');
    assert.equal(first.duplicate, false);
    const second = rememberGroupEventId(first.eventIds, 'evt-1');
    assert.equal(second.duplicate, true);
  });

  test('createChatRef encodes group id', () => {
    assert.equal(createChatRef('group:abc'), 'group:abc');
  });
});

test('group protocol enforces admin updates, membership, deduplication, and partial delivery', async () => {
  const {
    GROUP_MESSAGE_KIND,
    applyGroupEvent,
    createGroup,
    createGroupUpdateEvent,
    deriveGroupDeliveryStatus,
    rememberGroupEventId,
    validateIncomingGroupMessage,
  } = await import(groupChatUrl);
  const group = createGroup({
    id: 'group:secure123',
    name: 'Sicher',
    creator: { peerId: 'bt-admin' },
    members: [
      { peerId: 'bt-alice', state: 'active' },
      { peerId: 'bt-bob', state: 'active' },
    ],
  });
  const next = { ...group, name: 'Neu', revision: group.revision + 1 };
  const forged = { ...createGroupUpdateEvent(group, next, 'bt-admin'), actorId: 'bt-alice' };
  assert.equal(applyGroupEvent(group, forged, 'bt-bob').error, 'admin_required');

  const message = {
    kind: GROUP_MESSAGE_KIND,
    protocolVersion: 1,
    groupId: group.id,
    groupRevision: group.revision,
    senderPeerId: 'bt-alice',
    messageId: 'gm-secure',
    payload: { kind: 'chat', content: 'Hallo' },
  };
  assert.equal(validateIncomingGroupMessage(group, message, 'bt-alice', 'bt-bob').ok, true);
  assert.equal(validateIncomingGroupMessage(group, message, 'bt-outsider', 'bt-bob').error, 'sender_mismatch');

  const first = rememberGroupEventId([], 'event-1');
  assert.equal(rememberGroupEventId(first.eventIds, 'event-1').duplicate, true);
  assert.equal(deriveGroupDeliveryStatus({ 'bt-alice': 'delivered', 'bt-bob': 'offline' }, ['bt-alice', 'bt-bob']), 'partial');
});
