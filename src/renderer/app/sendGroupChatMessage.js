// Gruppen-Zweig von sendMessage(), 1:1 aus App.jsx ausgelagert.
// Wird von useMessaging aufgerufen; alle Abhängigkeiten kommen über `deps`.
import { startTransition } from 'react';
import { newChatMessageId } from './appHelpers';
import groupChat from '../../shared/group-chat.js';

const {
  GROUP_MESSAGE_KIND,
  GROUP_PROTOCOL_VERSION,
  buildTargetedGroupRoute,
  deriveGroupDeliveryStatus,
  isActiveGroupMember,
  summarizeGroupDelivery,
} = groupChat;

export function sendGroupChatMessage(deps, peerId, payload) {
  const {
    groupsRef,
    ownPeerIdRef,
    messageCacheRef,
    displayName,
    setMessages,
    setChatMeta,
    sendGroupPacket,
    applyMessagePatch,
  } = deps;

  const group = groupsRef.current.find((entry) => entry.id === peerId);
  const selfPeerId = ownPeerIdRef.current;
  if (!group || !selfPeerId || !isActiveGroupMember(group, selfPeerId)) {
    return Promise.resolve({ ok: false, error: 'not_group_member' });
  }
  const outgoing = typeof payload === 'string'
    ? { kind: 'chat', content: payload }
    : { kind: 'chat', ...payload };
  if (!['chat', 'file', 'sticker', 'contact-share'].includes(outgoing.kind)) {
    return Promise.resolve({ ok: false, error: 'unsupported_group_payload' });
  }
  const localPreviewUrl = ['file', 'sticker'].includes(outgoing.kind) ? outgoing.localPreviewUrl : undefined;
  const wireContent = { ...outgoing };
  delete wireContent.localPreviewUrl;
  const messageId = newChatMessageId();
  const createdAt = Date.now();
  const route = buildTargetedGroupRoute(group, selfPeerId, { includeInvited: false });
  const initialDelivery = Object.fromEntries(route.recipients.map((recipientId) => [
    recipientId,
    { status: 'offline' },
  ]));
  const inner = {
    kind: GROUP_MESSAGE_KIND,
    protocolVersion: GROUP_PROTOCOL_VERSION,
    groupId: group.id,
    groupRevision: group.revision,
    messageId,
    senderPeerId: selfPeerId,
    sender: displayName,
    timestamp: createdAt,
    payload: wireContent,
  };
  const selfMessage = {
    ...wireContent,
    localPreviewUrl,
    sender: displayName,
    senderPeerId: selfPeerId,
    messageId,
    timestamp: createdAt,
    groupId: group.id,
    groupRevision: group.revision,
    groupRecipientIds: route.recipients,
    groupDelivery: initialDelivery,
    groupDeliverySummary: summarizeGroupDelivery(initialDelivery, route.recipients),
    from: 'self',
    deliveryStatus: deriveGroupDeliveryStatus(initialDelivery, route.recipients),
  };

  const nextCached = [...(messageCacheRef.current[group.id] || []), selfMessage];
  messageCacheRef.current = { ...messageCacheRef.current, [group.id]: nextCached };
  startTransition(() => {
    setMessages((prev) => ({ ...prev, [group.id]: [...(prev[group.id] || []), selfMessage] }));
    setChatMeta((prev) => ({
      ...prev,
      [group.id]: { count: (prev[group.id]?.count || 0) + 1, lastMessage: selfMessage },
    }));
  });

  return (async () => {
    const meta = await window.bluetalk.messages.append(group.id, selfMessage);
    const pairs = await Promise.all(route.recipients.map(async (recipientId) => {
      const sent = await sendGroupPacket(recipientId, inner, {
        packetId: messageId,
        messageId,
        groupId: group.id,
        type: 'message',
      });
      return [recipientId, sent];
    }));
    const delivery = { ...initialDelivery };
    for (const [recipientId, sent] of pairs) {
      delivery[recipientId] = { status: sent ? 'sent' : 'offline', at: Date.now() };
    }
    const patch = {
      groupDelivery: delivery,
      groupDeliverySummary: summarizeGroupDelivery(delivery, route.recipients),
      deliveryStatus: deriveGroupDeliveryStatus(delivery, route.recipients),
      localPreviewUrl: undefined,
    };
    await applyMessagePatch(group.id, messageId, patch);
    if (meta?.count) setChatMeta((prev) => ({ ...prev, [group.id]: meta }));
    return { ok: true, queued: pairs.some(([, sent]) => !sent), delivery: patch.groupDeliverySummary };
  })().catch((error) => ({ ok: false, error: error?.message || 'group_send_failed' }));
}
