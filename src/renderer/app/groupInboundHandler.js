// Verarbeitung eingehender Gruppen-Protokoll-Frames (Event/Receipt/Message),
// 1:1 aus dem `peer:message`-Handler in App.jsx ausgelagert.
import { startTransition } from 'react';
import { base64ByteLength, validateStickerData } from '../stickers/stickerStore';
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_TEXT_CHARS } from './chatConstants';
import { buildMessageNotificationPreview } from '../utils/messageNotificationPreview';
import groupChat from '../../shared/group-chat.js';

const {
  GROUP_EVENT_KIND,
  GROUP_MESSAGE_KIND,
  GROUP_PROTOCOL_VERSION,
  GROUP_RECEIPT_KIND,
  applyGroupEvent,
  buildTargetedGroupRoute,
  createGroupAcceptEvent,
  createGroupUpdateEvent,
  deriveGroupDeliveryStatus,
  getGroupMember,
  isGroupAdmin,
  summarizeGroupDelivery,
  validateIncomingGroupMessage,
} = groupChat;

export const GROUP_PROTOCOL_KINDS = [GROUP_EVENT_KIND, GROUP_MESSAGE_KIND, GROUP_RECEIPT_KIND];

/**
 * Verarbeitet ein bereits entschlüsseltes Gruppen-Frame. Muss nur für
 * `normalized.kind` in GROUP_PROTOCOL_KINDS aufgerufen werden; jeder Zweig
 * entspricht exakt dem ursprünglichen Inline-Code (inkl. aller Returns).
 */
export async function handleGroupProtocolFrame(deps, normalized, fromId, wasPairwiseEncrypted) {
  const {
    groupsRef,
    groupEventIdsRef,
    groupOutboxRef,
    ownPeerIdRef,
    settingsRef,
    messageCacheRef,
    sendGroupPacketRef,
    inboundToastRef,
    rememberIncomingGroupEvent,
    replaceGroup,
    persistGroupOutbox,
    applyMessagePatch,
    setChatMeta,
    setMessages,
  } = deps;

  if (!wasPairwiseEncrypted) {
    console.warn('Rejected unencrypted group protocol frame from peer:', fromId);
    return;
  }

  if (normalized.kind === GROUP_EVENT_KIND) {
    if (!fromId || normalized.actorId !== fromId) return;
    const sendEventReceipt = () => {
      const receipt = {
        kind: GROUP_RECEIPT_KIND,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        groupId: normalized.groupId,
        refEventId: normalized.eventId,
        senderPeerId: ownPeerIdRef.current,
        status: 'delivered',
        receivedAt: Date.now(),
      };
      void sendGroupPacketRef.current?.(fromId, receipt, {
        packetId: `event-receipt:${normalized.eventId}`,
        groupId: normalized.groupId,
        type: 'receipt',
        queue: false,
      });
    };
    if (groupEventIdsRef.current.includes(normalized.eventId)) {
      sendEventReceipt();
      return;
    }
    const current = groupsRef.current.find((group) => group.id === normalized.groupId) || null;
    const applied = applyGroupEvent(current, normalized, ownPeerIdRef.current);
    if (!applied.ok) {
      console.warn('Rejected group event:', applied.error, normalized.groupId, fromId);
      return;
    }
    rememberIncomingGroupEvent(normalized.eventId);
    replaceGroup(applied.group);
    sendEventReceipt();

    if (applied.shouldAccept) {
      try {
        const accept = createGroupAcceptEvent(applied.group, ownPeerIdRef.current);
        void sendGroupPacketRef.current?.(fromId, accept, {
          packetId: accept.eventId,
          groupId: applied.group.id,
          type: 'control',
        });
      } catch (error) {
        console.warn('Could not acknowledge group invitation:', error?.message);
      }
      inboundToastRef.current?.({
        variant: 'success',
        title: 'Neue Gruppe',
        message: `Du wurdest zu „${applied.group.name}“ hinzugefügt.`,
      });
    }

    if (applied.shouldBroadcast && current && isGroupAdmin(applied.group, ownPeerIdRef.current)) {
      try {
        const update = createGroupUpdateEvent(
          current,
          applied.group,
          ownPeerIdRef.current,
          normalized.action === 'accept' ? 'member-accepted' : 'member-left'
        );
        const route = buildTargetedGroupRoute(applied.group, ownPeerIdRef.current, { includeInvited: true });
        for (const recipientId of route.recipients) {
          void sendGroupPacketRef.current?.(recipientId, update, {
            packetId: update.eventId,
            groupId: applied.group.id,
            type: 'control',
          });
        }
      } catch (error) {
        console.warn('Could not publish group membership update:', error?.message);
      }
    }
    return;
  }

  if (normalized.kind === GROUP_RECEIPT_KIND) {
    const group = groupsRef.current.find((entry) => entry.id === normalized.groupId);
    if (group && normalized.senderPeerId === fromId && normalized.refEventId) {
      persistGroupOutbox(groupOutboxRef.current.filter((entry) => !(
        entry.peerId === fromId && entry.packetId === normalized.refEventId
      )));
      return;
    }
    if (
      !group
      || normalized.senderPeerId !== fromId
      || !normalized.refMessageId
    ) return;
    const existingMessage = (messageCacheRef.current[group.id] || [])
      .find((item) => item.messageId === normalized.refMessageId && item.from === 'self');
    if (!existingMessage) return;
    const recipients = existingMessage.groupRecipientIds || [];
    if (!recipients.includes(fromId)) return;
    const delivery = {
      ...(existingMessage.groupDelivery || {}),
      [fromId]: {
        status: normalized.status === 'seen' ? 'seen' : 'delivered',
        at: Number.isFinite(normalized.receivedAt) ? normalized.receivedAt : Date.now(),
      },
    };
    await applyMessagePatch(group.id, normalized.refMessageId, {
      groupDelivery: delivery,
      deliveryStatus: deriveGroupDeliveryStatus(delivery, recipients),
      groupDeliverySummary: summarizeGroupDelivery(delivery, recipients),
    });
    persistGroupOutbox(groupOutboxRef.current.filter((entry) => !(
      entry.type === 'message'
      && entry.peerId === fromId
      && entry.messageId === normalized.refMessageId
    )));
    return;
  }

  if (normalized.kind === GROUP_MESSAGE_KIND) {
    const group = groupsRef.current.find((entry) => entry.id === normalized.groupId);
    const validation = validateIncomingGroupMessage(group, normalized, fromId, ownPeerIdRef.current);
    if (!validation.ok) {
      console.warn('Rejected group message:', validation.error, normalized.groupId, fromId);
      return;
    }
    let groupMessage = {
      ...normalized.payload,
      messageId: normalized.messageId,
      timestamp: normalized.timestamp,
      sender: getGroupMember(group, fromId)?.displayName || fromId,
      senderPeerId: fromId,
      groupId: group.id,
      groupRevision: normalized.groupRevision,
      from: fromId,
    };
    if (groupMessage.kind === 'sticker') {
      try {
        groupMessage = { ...groupMessage, ...validateStickerData(groupMessage) };
      } catch {
        return;
      }
    } else if (groupMessage.kind === 'file' && groupMessage.fileData) {
      const actualSize = base64ByteLength(groupMessage.fileData);
      if (actualSize < 0 || actualSize > MAX_CHAT_FILE_BYTES) return;
      groupMessage.fileSize = actualSize;
    } else if (groupMessage.kind === 'chat' && String(groupMessage.content || '').length > MAX_CHAT_TEXT_CHARS) {
      return;
    }

    const receipt = {
      kind: GROUP_RECEIPT_KIND,
      protocolVersion: GROUP_PROTOCOL_VERSION,
      groupId: group.id,
      refMessageId: groupMessage.messageId,
      senderPeerId: ownPeerIdRef.current,
      status: 'delivered',
      receivedAt: Date.now(),
    };
    void sendGroupPacketRef.current?.(fromId, receipt, {
      packetId: `receipt:${groupMessage.messageId}`,
      groupId: group.id,
      type: 'receipt',
      queue: false,
    });

    const meta = await window.bluetalk.messages.append(group.id, groupMessage);
    if (meta?.appended === false) return;
    setChatMeta((prev) => ({
      ...prev,
      [group.id]: meta?.count ? meta : {
        count: (prev[group.id]?.count || 0) + 1,
        lastMessage: groupMessage,
      },
    }));
    startTransition(() => {
      setMessages((prev) => ({
        ...prev,
        [group.id]: [...(prev[group.id] || []), groupMessage],
      }));
    });
    if (!settingsRef.current.doNotDisturb) {
      void window.bluetalk?.notify?.show?.({
        title: group.name,
        body: `${groupMessage.sender}: ${buildMessageNotificationPreview(groupMessage)}`,
      });
    }
  }
}
