const GROUP_PROTOCOL_VERSION = 1;
const GROUP_ID_PREFIX = 'group:';
const GROUP_EVENT_KIND = 'group-event-v1';
const GROUP_MESSAGE_KIND = 'group-message-v1';
const GROUP_RECEIPT_KIND = 'group-receipt-v1';
const GROUP_MAX_NAME_CHARS = 80;
const GROUP_MAX_IMAGE_CHARS = 520 * 1024;
const GROUP_EVENT_HISTORY_LIMIT = 512;

const GROUP_MEMBER_STATES = new Set(['invited', 'active', 'left', 'removed']);
const GROUP_MEMBER_ROLES = new Set(['admin', 'member']);
const GROUP_EVENT_ACTIONS = new Set(['invite', 'accept', 'update', 'leave']);

function randomId(prefix = '') {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `${prefix}${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `${prefix}${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

function createGroupId() {
  return randomId(GROUP_ID_PREFIX);
}

function isGroupChatId(value) {
  return typeof value === 'string' && /^group:[A-Za-z0-9_-]{8,128}$/.test(value);
}

function createChatRef(type, id) {
  if (id === undefined && typeof type === 'string') return type;
  if (type === 'group') {
    if (!isGroupChatId(id)) throw new Error('invalid_group_chat_id');
    return { id, type: 'group' };
  }
  if (type === 'direct' && typeof id === 'string' && id.length > 0) {
    return { id, type: 'direct' };
  }
  throw new Error('invalid_chat_ref');
}

function parseChatRef(id) {
  return createChatRef(isGroupChatId(id) ? 'group' : 'direct', id);
}

function cleanString(value, maxChars) {
  return String(value || '').trim().slice(0, maxChars);
}

function normalizeMember(raw, fallbackNow = Date.now()) {
  const peerId = cleanString(raw?.peerId || raw?.id, 96);
  if (!peerId) return null;
  const state = GROUP_MEMBER_STATES.has(raw?.state) ? raw.state : 'invited';
  const role = GROUP_MEMBER_ROLES.has(raw?.role) ? raw.role : 'member';
  return {
    peerId,
    displayName: cleanString(raw?.displayName || raw?.name || peerId, 80),
    role,
    state,
    addedAt: Number.isFinite(raw?.addedAt) ? raw.addedAt : fallbackNow,
    joinedAt: Number.isFinite(raw?.joinedAt) ? raw.joinedAt : (state === 'active' ? fallbackNow : undefined),
    removedAt: Number.isFinite(raw?.removedAt) ? raw.removedAt : undefined,
  };
}

function normalizeGroup(raw) {
  if (!raw || !isGroupChatId(raw.id)) throw new Error('invalid_group');
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  const members = [];
  const seen = new Set();
  for (const candidate of Array.isArray(raw.members) ? raw.members : []) {
    const member = normalizeMember(candidate, createdAt);
    if (!member || seen.has(member.peerId)) continue;
    seen.add(member.peerId);
    members.push(member);
  }
  const createdBy = cleanString(raw.createdBy, 96);
  if (!createdBy || !seen.has(createdBy)) throw new Error('invalid_group_creator');
  const creator = members.find((member) => member.peerId === createdBy);
  creator.role = 'admin';
  if (creator.state === 'invited') creator.state = 'active';
  return {
    id: raw.id,
    type: 'group',
    protocolVersion: GROUP_PROTOCOL_VERSION,
    revision: Math.max(1, Number.isInteger(raw.revision) ? raw.revision : 1),
    name: cleanString(raw.name, GROUP_MAX_NAME_CHARS) || 'Neue Gruppe',
    image: cleanString(raw.image, GROUP_MAX_IMAGE_CHARS),
    createdAt,
    createdBy,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    members,
  };
}

function createGroup({ id = createGroupId(), name, image = '', creator, members = [], now = Date.now() }) {
  if (!creator?.peerId) throw new Error('creator_required');
  const rows = [
    {
      peerId: creator.peerId,
      displayName: creator.displayName || creator.peerId,
      role: 'admin',
      state: 'active',
      addedAt: now,
      joinedAt: now,
    },
    ...members.map((member) => ({
      peerId: member.peerId || member.id,
      displayName: member.displayName || member.name || member.peerId || member.id,
      role: member.role === 'admin' ? 'admin' : 'member',
      state: member.state === 'active' ? 'active' : 'invited',
      addedAt: now,
      joinedAt: member.state === 'active' ? now : undefined,
    })),
  ];
  const group = normalizeGroup({
    id,
    name,
    image,
    createdAt: now,
    updatedAt: now,
    createdBy: creator.peerId,
    revision: 1,
    members: rows,
  });
  if (group.members.length < 2) throw new Error('group_member_required');
  return group;
}

function getGroupMember(group, peerId) {
  return group?.members?.find((member) => member.peerId === peerId) || null;
}

function isActiveGroupMember(group, peerId) {
  return getGroupMember(group, peerId)?.state === 'active';
}

function isGroupAdmin(group, peerId) {
  const member = getGroupMember(group, peerId);
  return member?.state === 'active' && member.role === 'admin';
}

function groupPeerIds(group, options = {}) {
  const includeInvited = options.includeInvited === true;
  const excludePeerId = options.excludePeerId || '';
  return [...new Set((group?.members || [])
    .filter((member) => member.peerId !== excludePeerId)
    .filter((member) => member.state === 'active' || (includeInvited && member.state === 'invited'))
    .map((member) => member.peerId))];
}

function buildTargetedGroupRoute(group, senderPeerId, options = {}) {
  const recipients = groupPeerIds(group, {
    excludePeerId: senderPeerId,
    includeInvited: options.includeInvited !== false,
  });
  Object.defineProperties(recipients, {
    chat: { value: createChatRef('group', group.id), enumerable: false },
    recipients: { value: recipients, enumerable: false },
    transport: { value: 'pairwise-e2ee', enumerable: false },
  });
  return recipients;
}

function eventBase(action, groupId, actorId, now = Date.now()) {
  if (!GROUP_EVENT_ACTIONS.has(action)) throw new Error('invalid_group_action');
  return {
    kind: GROUP_EVENT_KIND,
    protocolVersion: GROUP_PROTOCOL_VERSION,
    eventId: randomId('group-event:'),
    action,
    groupId,
    actorId,
    timestamp: now,
  };
}

function createGroupInviteEvent(group, actorId, recipientId, now = Date.now()) {
  if (group?.groupId && group?.actorId && group?.invitee) {
    return {
      ...eventBase('invite', group.groupId, group.actorId, group.timestamp || Date.now()),
      invitee: normalizeMember(group.invitee),
      legacyMutation: true,
    };
  }
  if (!isGroupAdmin(group, actorId)) throw new Error('admin_required');
  const member = getGroupMember(group, recipientId);
  if (!member || (member.state !== 'invited' && member.state !== 'active')) throw new Error('invalid_invitee');
  return {
    ...eventBase('invite', group.id, actorId, now),
    recipientId,
    group: normalizeGroup(group),
  };
}

function createGroupAcceptEvent(group, actorId, now = Date.now()) {
  if (group?.groupId && group?.actorId && !group?.members) {
    return {
      ...eventBase('accept', group.groupId, group.actorId, group.timestamp || Date.now()),
      legacyMutation: true,
    };
  }
  const member = getGroupMember(group, actorId);
  if (!member || (member.state !== 'invited' && member.state !== 'active')) throw new Error('not_invited');
  return {
    ...eventBase('accept', group.id, actorId, now),
    inviteRevision: group.revision,
  };
}

function createGroupUpdateEvent(previousGroup, nextGroup, actorId, reason = 'metadata', now = Date.now()) {
  if (previousGroup?.groupId && previousGroup?.actorId && previousGroup?.patch) {
    return {
      ...eventBase('update', previousGroup.groupId, previousGroup.actorId, previousGroup.timestamp || Date.now()),
      patch: previousGroup.patch,
      legacyMutation: true,
    };
  }
  if (!isGroupAdmin(previousGroup, actorId)) throw new Error('admin_required');
  const normalized = normalizeGroup(nextGroup);
  if (normalized.id !== previousGroup.id) throw new Error('group_id_mismatch');
  if (normalized.revision <= previousGroup.revision) throw new Error('stale_group_revision');
  return {
    ...eventBase('update', normalized.id, actorId, now),
    reason: cleanString(reason, 40) || 'metadata',
    group: normalized,
  };
}

function createGroupLeaveEvent(group, actorId, now = Date.now()) {
  if (!isActiveGroupMember(group, actorId)) throw new Error('active_member_required');
  return {
    ...eventBase('leave', group.id, actorId, now),
    knownRevision: group.revision,
  };
}

function withAcceptedMember(group, peerId, now) {
  return normalizeGroup({
    ...group,
    revision: group.revision + 1,
    updatedAt: now,
    members: group.members.map((member) => member.peerId === peerId
      ? { ...member, state: 'active', joinedAt: member.joinedAt || now, removedAt: undefined }
      : member),
  });
}

function withDepartedMember(group, peerId, state, now) {
  return normalizeGroup({
    ...group,
    revision: group.revision + 1,
    updatedAt: now,
    members: group.members.map((member) => member.peerId === peerId
      ? { ...member, state, removedAt: now }
      : member),
  });
}

function applyGroupEvent(localGroup, event, selfPeerId) {
  if (!event || event.kind !== GROUP_EVENT_KIND || event.protocolVersion !== GROUP_PROTOCOL_VERSION) {
    return { ok: false, error: 'invalid_group_event' };
  }
  if (!isGroupChatId(event.groupId) || !event.eventId || !event.actorId) {
    return { ok: false, error: 'invalid_group_event' };
  }

  if (event.action === 'invite') {
    if (event.legacyMutation && event.invitee && localGroup) {
      const current = normalizeGroup(localGroup);
      if (!isGroupAdmin(current, event.actorId) || selfPeerId !== event.actorId) {
        return { ok: false, error: 'admin_required' };
      }
      if (getGroupMember(current, event.invitee.peerId)) return { ok: true, group: current, duplicate: true };
      return {
        ok: true,
        group: normalizeGroup({
          ...current,
          revision: current.revision + 1,
          updatedAt: event.timestamp,
          members: [...current.members, { ...event.invitee, state: 'invited', role: 'member' }],
        }),
      };
    }
    if (event.recipientId !== selfPeerId) return { ok: false, error: 'wrong_invitee' };
    let invited;
    try {
      invited = normalizeGroup(event.group);
    } catch {
      return { ok: false, error: 'invalid_group_snapshot' };
    }
    if (invited.id !== event.groupId || !isGroupAdmin(invited, event.actorId)) {
      return { ok: false, error: 'unauthorized_invite' };
    }
    if (localGroup) {
      const current = normalizeGroup(localGroup);
      if (!isGroupAdmin(current, event.actorId)) return { ok: false, error: 'admin_required' };
      if (invited.revision <= current.revision) return { ok: true, group: current, duplicate: true };
    }
    const self = getGroupMember(invited, selfPeerId);
    if (!self || !['invited', 'active'].includes(self.state)) return { ok: false, error: 'not_invited' };
    return { ok: true, group: invited, shouldAccept: self.state !== 'active' };
  }

  if (!localGroup || localGroup.id !== event.groupId) return { ok: false, error: 'unknown_group' };
  const current = normalizeGroup(localGroup);

  if (event.action === 'accept') {
    if (event.legacyMutation && event.actorId === selfPeerId) {
      const member = getGroupMember(current, event.actorId);
      if (!member || !['invited', 'active'].includes(member.state)) return { ok: false, error: 'not_invited' };
      return member.state === 'active'
        ? { ok: true, group: current, duplicate: true }
        : { ok: true, group: withAcceptedMember(current, event.actorId, event.timestamp) };
    }
    if (event.actorId === selfPeerId) return { ok: false, error: 'self_accept_echo' };
    if (!isGroupAdmin(current, selfPeerId)) return { ok: false, error: 'admin_required' };
    const member = getGroupMember(current, event.actorId);
    if (!member || !['invited', 'active'].includes(member.state)) return { ok: false, error: 'not_invited' };
    if (member.state === 'active') return { ok: true, group: current, duplicate: true };
    return { ok: true, group: withAcceptedMember(current, event.actorId, event.timestamp), shouldBroadcast: true };
  }

  if (event.action === 'update') {
    if (event.legacyMutation && event.patch) {
      if (!isGroupAdmin(current, event.actorId) || selfPeerId !== event.actorId) {
        return { ok: false, error: 'admin_required' };
      }
      return {
        ok: true,
        group: normalizeGroup({
          ...current,
          ...event.patch,
          id: current.id,
          createdBy: current.createdBy,
          members: current.members,
          revision: current.revision + 1,
          updatedAt: event.timestamp,
        }),
      };
    }
    if (!isGroupAdmin(current, event.actorId)) return { ok: false, error: 'admin_required' };
    let next;
    try {
      next = normalizeGroup(event.group);
    } catch {
      return { ok: false, error: 'invalid_group_snapshot' };
    }
    if (next.id !== current.id || next.createdBy !== current.createdBy) {
      return { ok: false, error: 'group_identity_changed' };
    }
    if (next.revision <= current.revision) return { ok: true, group: current, duplicate: true };
    return { ok: true, group: next };
  }

  if (event.action === 'leave') {
    if (event.actorId === selfPeerId) return { ok: false, error: 'self_leave_echo' };
    if (!isGroupAdmin(current, selfPeerId)) return { ok: false, error: 'admin_required' };
    if (!isActiveGroupMember(current, event.actorId)) return { ok: false, error: 'active_member_required' };
    return {
      ok: true,
      group: withDepartedMember(current, event.actorId, 'left', event.timestamp),
      shouldBroadcast: true,
    };
  }

  return { ok: false, error: 'unsupported_group_action' };
}

function validateIncomingGroupMessage(group, envelope, transportPeerId, selfPeerId) {
  if (!group || !envelope || envelope.kind !== GROUP_MESSAGE_KIND) return { ok: false, error: 'invalid_group_message' };
  if (envelope.protocolVersion !== GROUP_PROTOCOL_VERSION || envelope.groupId !== group.id) {
    return { ok: false, error: 'group_mismatch' };
  }
  if (!envelope.messageId || envelope.senderPeerId !== transportPeerId) {
    return { ok: false, error: 'sender_mismatch' };
  }
  if (!isActiveGroupMember(group, transportPeerId)) return { ok: false, error: 'sender_not_member' };
  if (!isActiveGroupMember(group, selfPeerId)) return { ok: false, error: 'recipient_not_member' };
  if (!envelope.payload || !['chat', 'file', 'sticker', 'contact-share'].includes(envelope.payload.kind)) {
    return { ok: false, error: 'unsupported_group_payload' };
  }
  return { ok: true };
}

function deriveGroupDeliveryStatus(delivery = {}, recipientIds = []) {
  if (delivery?.members && recipientIds && !Array.isArray(recipientIds)) {
    const recipients = groupPeerIds(delivery, { excludePeerId: delivery.createdBy, includeInvited: true });
    const summary = summarizeGroupDelivery(recipientIds, recipients);
    return {
      status: deriveGroupDeliveryStatus(recipientIds, recipients),
      deliveredCount: summary.delivered,
      pendingCount: summary.pending,
      offlineCount: summary.offline,
      totalCount: summary.total,
    };
  }
  const recipients = [...new Set(recipientIds.filter(Boolean))];
  if (recipients.length === 0) return 'delivered';
  const states = recipients.map((peerId) => delivery[peerId]?.status || delivery[peerId] || 'offline');
  const delivered = states.filter((status) => status === 'delivered' || status === 'seen').length;
  if (delivered === recipients.length) return 'delivered';
  if (delivered > 0) return 'partial';
  if (states.some((status) => status === 'sent' || status === 'pending')) return 'pending';
  return 'scheduled';
}

function summarizeGroupDelivery(delivery = {}, recipientIds = []) {
  const recipients = [...new Set(recipientIds.filter(Boolean))];
  let delivered = 0;
  let pending = 0;
  let offline = 0;
  for (const peerId of recipients) {
    const status = delivery[peerId]?.status || delivery[peerId] || 'offline';
    if (status === 'delivered' || status === 'seen') delivered += 1;
    else if (status === 'sent' || status === 'pending') pending += 1;
    else offline += 1;
  }
  return { total: recipients.length, delivered, pending, offline };
}

function rememberGroupEventId(eventIds, eventId, limit = GROUP_EVENT_HISTORY_LIMIT) {
  const list = Array.isArray(eventIds) ? eventIds.filter((id) => typeof id === 'string') : [];
  if (!eventId || list.includes(eventId)) return { duplicate: Boolean(eventId && list.includes(eventId)), eventIds: list };
  return { duplicate: false, eventIds: [...list, eventId].slice(-Math.max(1, limit)) };
}

const groupChat = {
  GROUP_PROTOCOL_VERSION,
  GROUP_ID_PREFIX,
  GROUP_EVENT_KIND,
  GROUP_MESSAGE_KIND,
  GROUP_RECEIPT_KIND,
  GROUP_MAX_NAME_CHARS,
  createGroupId,
  isGroupChatId,
  createChatRef,
  parseChatRef,
  normalizeGroup,
  createGroup,
  getGroupMember,
  isActiveGroupMember,
  isGroupAdmin,
  groupPeerIds,
  buildTargetedGroupRoute,
  createGroupInviteEvent,
  createGroupAcceptEvent,
  createGroupUpdateEvent,
  createGroupLeaveEvent,
  withAcceptedMember,
  withDepartedMember,
  applyGroupEvent,
  validateIncomingGroupMessage,
  deriveGroupDeliveryStatus,
  summarizeGroupDelivery,
  rememberGroupEventId,
};

export {
  GROUP_PROTOCOL_VERSION,
  GROUP_ID_PREFIX,
  GROUP_EVENT_KIND,
  GROUP_MESSAGE_KIND,
  GROUP_RECEIPT_KIND,
  GROUP_MAX_NAME_CHARS,
  createGroupId,
  isGroupChatId,
  createChatRef,
  parseChatRef,
  normalizeGroup,
  createGroup,
  getGroupMember,
  isActiveGroupMember,
  isGroupAdmin,
  groupPeerIds,
  buildTargetedGroupRoute,
  createGroupInviteEvent,
  createGroupAcceptEvent,
  createGroupUpdateEvent,
  createGroupLeaveEvent,
  withAcceptedMember,
  withDepartedMember,
  applyGroupEvent,
  validateIncomingGroupMessage,
  deriveGroupDeliveryStatus,
  summarizeGroupDelivery,
  rememberGroupEventId,
};

export default groupChat;
