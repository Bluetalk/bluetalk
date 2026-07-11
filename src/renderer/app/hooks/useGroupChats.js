// Gruppen-Chats: Modell-Pflege, Outbox, Paket-Versand und Gruppen-Aktionen,
// 1:1 aus App.jsx ausgelagert.
import { useEffect, useCallback } from 'react';
import groupChat from '../../../shared/group-chat.js';

const {
  createGroup: createGroupModel,
  createGroupInviteEvent,
  createGroupLeaveEvent,
  createGroupUpdateEvent,
  deriveGroupDeliveryStatus,
  getGroupMember,
  groupPeerIds,
  isActiveGroupMember,
  isGroupAdmin,
  normalizeGroup,
  rememberGroupEventId,
  summarizeGroupDelivery,
} = groupChat;

export function useGroupChats({
  peers,
  setGroups,
  groupsRef,
  groupOutboxRef,
  groupEventIdsRef,
  sendGroupPacketRef,
  flushGroupOutboxRef,
  contactsRef,
  settingsRef,
  ownPeerIdRef,
  messageCacheRef,
  sendPairwiseEncrypted,
  applyMessagePatch,
}) {
  const replaceGroup = useCallback((nextGroup) => {
    let normalized;
    try {
      normalized = normalizeGroup(nextGroup);
    } catch {
      return false;
    }
    const current = groupsRef.current;
    const idx = current.findIndex((group) => group.id === normalized.id);
    const updated = idx >= 0
      ? current.map((group, index) => (index === idx ? normalized : group))
      : [...current, normalized];
    groupsRef.current = updated;
    setGroups(updated);
    void window.bluetalk?.store?.set?.('groups', updated);
    return true;
  }, []);

  const removeGroup = useCallback((groupId) => {
    if (!groupId) return false;
    const updated = groupsRef.current.filter((group) => group.id !== groupId);
    if (updated.length === groupsRef.current.length) return false;
    groupsRef.current = updated;
    setGroups(updated);
    void window.bluetalk?.store?.set?.('groups', updated);
    return true;
  }, []);

  const persistGroupOutbox = useCallback((next) => {
    const bounded = (Array.isArray(next) ? next : []).slice(-1000);
    groupOutboxRef.current = bounded;
    void window.bluetalk?.store?.set?.('groupOutbox', bounded);
    return bounded;
  }, []);

  const rememberIncomingGroupEvent = useCallback((eventId) => {
    const remembered = rememberGroupEventId(groupEventIdsRef.current, eventId);
    groupEventIdsRef.current = remembered.eventIds;
    if (!remembered.duplicate) {
      void window.bluetalk?.store?.set?.('groupEventIds', remembered.eventIds);
    }
    return remembered.duplicate;
  }, []);

  const sendGroupPacket = useCallback(async (peerId, packet, options = {}) => {
    const packetId = options.packetId || packet?.messageId || packet?.eventId || packet?.refMessageId;
    const queue = options.queue !== false;
    let entry = null;
    if (queue && packetId) {
      entry = {
        id: `${options.type || 'control'}:${packetId}:${peerId}`,
        type: options.type || 'control',
        packetId,
        messageId: options.messageId || packet?.messageId || '',
        groupId: options.groupId || packet?.groupId || '',
        peerId,
        packet,
        status: 'queued',
        attempts: 0,
        createdAt: Date.now(),
      };
      const next = groupOutboxRef.current.filter((item) => item.id !== entry.id);
      persistGroupOutbox([...next, entry]);
    }

    const sent = await sendPairwiseEncrypted(peerId, packet);
    if (!entry) return sent;
    persistGroupOutbox(groupOutboxRef.current.map((item) => item.id === entry.id
      ? { ...item, status: sent ? 'sent' : 'offline', attempts: (item.attempts || 0) + 1, lastAttemptAt: Date.now() }
      : item));
    return sent;
  }, [persistGroupOutbox, sendPairwiseEncrypted]);

  sendGroupPacketRef.current = sendGroupPacket;

  const flushGroupOutbox = useCallback(async (peerId) => {
    if (!peerId) return;
    const pending = groupOutboxRef.current.filter((entry) => entry.peerId === peerId);
    for (const entry of pending) {
      const sent = await sendPairwiseEncrypted(peerId, entry.packet);
      if (!sent) continue;
      persistGroupOutbox(groupOutboxRef.current.map((item) => item.id === entry.id
        ? { ...item, status: 'sent', attempts: (item.attempts || 0) + 1, lastAttemptAt: Date.now() }
        : item));
      if (entry.type === 'message') {
        const stored = (messageCacheRef.current[entry.groupId] || [])
          .find((message) => message.messageId === entry.messageId);
        if (stored) {
          const delivery = {
            ...(stored.groupDelivery || {}),
            [peerId]: { status: 'sent', at: Date.now() },
          };
          const recipients = stored.groupRecipientIds || [];
          await applyMessagePatch(entry.groupId, entry.messageId, {
            groupDelivery: delivery,
            deliveryStatus: deriveGroupDeliveryStatus(delivery, recipients),
            groupDeliverySummary: summarizeGroupDelivery(delivery, recipients),
          });
        }
      }
    }
  }, [applyMessagePatch, persistGroupOutbox, sendPairwiseEncrypted]);

  flushGroupOutboxRef.current = flushGroupOutbox;

  useEffect(() => {
    for (const peer of peers) {
      if (peer?.id && groupOutboxRef.current.some((entry) => entry.peerId === peer.id)) {
        void flushGroupOutbox(peer.id);
      }
    }
  }, [peers, flushGroupOutbox]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const online = new Set(peers.map((peer) => peer.id));
      const pendingPeerIds = [...new Set(groupOutboxRef.current
        .map((entry) => entry.peerId)
        .filter((peerId) => online.has(peerId)))];
      for (const peerId of pendingPeerIds) void flushGroupOutbox(peerId);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [peers, flushGroupOutbox]);

  const createGroupChat = useCallback(async ({ name, image = '', memberIds = [] }) => {
    const selfPeerId = ownPeerIdRef.current;
    if (!selfPeerId) throw new Error('identity_not_ready');
    const selected = [...new Set(memberIds.filter((id) => id && id !== selfPeerId))]
      .map((peerId) => {
        const contact = contactsRef.current.find((entry) => entry.id === peerId);
        return contact ? {
          peerId,
          displayName: contact.nickname || contact.name || peerId,
        } : null;
      })
      .filter(Boolean);
    const group = createGroupModel({
      name,
      image,
      creator: { peerId: selfPeerId, displayName: settingsRef.current.displayName },
      members: selected,
    });
    replaceGroup(group);
    for (const member of selected) {
      const invite = createGroupInviteEvent(group, selfPeerId, member.peerId);
      void sendGroupPacket(member.peerId, invite, {
        packetId: invite.eventId,
        groupId: group.id,
        type: 'control',
      });
    }
    return group;
  }, [replaceGroup, sendGroupPacket]);

  const updateGroupChat = useCallback(async (groupId, patch = {}) => {
    const selfPeerId = ownPeerIdRef.current;
    const current = groupsRef.current.find((group) => group.id === groupId);
    if (!current) throw new Error('unknown_group');
    if (!isGroupAdmin(current, selfPeerId)) throw new Error('admin_required');
    const addIds = [...new Set((patch.addMemberIds || []).filter(Boolean))];
    const removeIds = new Set((patch.removeMemberIds || []).filter((id) => (
      id && id !== selfPeerId && Boolean(getGroupMember(current, id))
    )));
    const existingIds = new Set(current.members.map((member) => member.peerId));
    const readdedIds = new Set(addIds.filter((peerId) => {
      const member = getGroupMember(current, peerId);
      return member && (member.state === 'left' || member.state === 'removed');
    }));
    const addedMembers = addIds
      .filter((peerId) => !existingIds.has(peerId))
      .map((peerId) => {
        const contact = contactsRef.current.find((entry) => entry.id === peerId);
        return contact ? {
          peerId,
          displayName: contact.nickname || contact.name || peerId,
          role: 'member',
          state: 'invited',
          addedAt: Date.now(),
        } : null;
      })
      .filter(Boolean);
    const now = Date.now();
    const next = normalizeGroup({
      ...current,
      name: Object.prototype.hasOwnProperty.call(patch, 'name') ? patch.name : current.name,
      image: Object.prototype.hasOwnProperty.call(patch, 'image') ? patch.image : current.image,
      revision: current.revision + 1,
      updatedAt: now,
      members: [
        ...current.members.map((member) => {
          if (removeIds.has(member.peerId)) return { ...member, state: 'removed', removedAt: now };
          if (readdedIds.has(member.peerId)) {
            const contact = contactsRef.current.find((entry) => entry.id === member.peerId);
            return {
              ...member,
              displayName: contact?.nickname || contact?.name || member.displayName,
              role: 'member',
              state: 'invited',
              addedAt: now,
              joinedAt: undefined,
              removedAt: undefined,
            };
          }
          return member;
        }),
        ...addedMembers,
      ],
    });
    const update = createGroupUpdateEvent(current, next, selfPeerId, patch.reason || 'group-info');
    replaceGroup(next);

    const newIds = new Set([...addedMembers.map((member) => member.peerId), ...readdedIds]);
    const existingRecipients = [...new Set([
      ...groupPeerIds(current, { excludePeerId: selfPeerId, includeInvited: true }),
      ...removeIds,
    ])].filter((peerId) => !newIds.has(peerId));
    for (const recipientId of existingRecipients) {
      void sendGroupPacket(recipientId, update, {
        packetId: update.eventId,
        groupId: next.id,
        type: 'control',
      });
    }
    for (const recipientId of newIds) {
      const invite = createGroupInviteEvent(next, selfPeerId, recipientId);
      void sendGroupPacket(recipientId, invite, {
        packetId: invite.eventId,
        groupId: next.id,
        type: 'control',
      });
    }
    return next;
  }, [replaceGroup, sendGroupPacket]);

  const leaveGroupChat = useCallback(async (groupId) => {
    const selfPeerId = ownPeerIdRef.current;
    const current = groupsRef.current.find((group) => group.id === groupId);
    if (!current || !isActiveGroupMember(current, selfPeerId)) throw new Error('active_member_required');
    const leave = createGroupLeaveEvent(current, selfPeerId);
    const otherActive = current.members.filter((member) => member.peerId !== selfPeerId && member.state === 'active');
    const wasAdmin = isGroupAdmin(current, selfPeerId);
    const hasOtherAdmin = otherActive.some((member) => member.role === 'admin');
    const now = Date.now();
    let members = current.members.map((member) => member.peerId === selfPeerId
      ? { ...member, state: 'left', removedAt: now }
      : member);
    if (wasAdmin && !hasOtherAdmin && otherActive[0]) {
      members = members.map((member) => member.peerId === otherActive[0].peerId
        ? { ...member, role: 'admin' }
        : member);
    }
    const next = normalizeGroup({ ...current, revision: current.revision + 1, updatedAt: now, members });
    replaceGroup(next);

    if (wasAdmin) {
      const update = createGroupUpdateEvent(current, next, selfPeerId, 'member-left');
      for (const recipientId of otherActive.map((member) => member.peerId)) {
        void sendGroupPacket(recipientId, update, {
          packetId: update.eventId,
          groupId,
          type: 'control',
        });
      }
    } else {
      const admins = current.members.filter((member) => member.state === 'active' && member.role === 'admin');
      for (const admin of admins) {
        void sendGroupPacket(admin.peerId, leave, {
          packetId: leave.eventId,
          groupId,
          type: 'control',
        });
      }
    }
    return next;
  }, [replaceGroup, sendGroupPacket]);

  return {
    replaceGroup,
    removeGroup,
    persistGroupOutbox,
    rememberIncomingGroupEvent,
    sendGroupPacket,
    flushGroupOutbox,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
  };
}
