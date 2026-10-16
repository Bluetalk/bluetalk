import { startTransition } from 'react';
import { newChatMessageId } from './appHelpers';
import {
  MESSAGE_EDIT_KIND,
  PEER_FEATURE_MESSAGE_EDIT,
  applyInboundMessageEdit,
  buildMessageEditInner,
  canEditOwnTextMessage,
  contactHasPeerFeature,
  legacyEditNotice,
  selectFeatureCapablePeerIds,
} from '../../shared/chat-features.js';
import groupChat from '../../shared/group-chat.js';

const {
  GROUP_MESSAGE_KIND,
  GROUP_PROTOCOL_VERSION,
  buildTargetedGroupRoute,
  isActiveGroupMember,
  isGroupChatId,
} = groupChat;

function contactLabel(contacts, peerId, fallback = '') {
  const contact = (contacts || []).find((entry) => entry?.id === peerId);
  return contact?.nickname || contact?.name || fallback || peerId;
}

function patchLastMessageMeta(setChatMeta, peerId, messageId, patch) {
  setChatMeta((prev) => {
    const meta = prev[peerId];
    if (!meta?.lastMessage || meta.lastMessage.messageId !== messageId) return prev;
    return {
      ...prev,
      [peerId]: { ...meta, lastMessage: { ...meta.lastMessage, ...patch } },
    };
  });
}

/**
 * Sendet ein E2EE-Message-Edit (1:1 oder Gruppe) und patched lokal.
 * Hängt keine neue Verlaufsnachricht an.
 */
export function sendMessageEdit(deps, peerId, { refMessageId, content }) {
  const {
    groupsRef,
    ownPeerIdRef,
    contactsRef,
    messageCacheRef,
    displayName,
    setMessages,
    setChatMeta,
    sendGroupPacket,
    sendPairwiseEncrypted,
    applyMessagePatch,
  } = deps;
  const contacts = contactsRef?.current || [];

  const text = String(content || '');
  const list = messageCacheRef.current[peerId] || [];
  const original = list.find((item) => item.messageId === refMessageId) || null;
  if (!canEditOwnTextMessage(original, { isSelf: original?.from === 'self' })) {
    return Promise.resolve({ ok: false, error: 'not_editable' });
  }
  const prevEdited = Number(original.editedAt) || 0;
  const inner = buildMessageEditInner({
    refMessageId,
    content: text,
    editedAt: Math.max(Date.now(), prevEdited + 1),
    sender: displayName,
    messageId: newChatMessageId(),
  });
  const applied = applyInboundMessageEdit(original, inner, { editorIsOriginalSender: true });
  if (!applied.ok || !applied.patch) {
    return Promise.resolve({ ok: false, error: applied.error || 'stale' });
  }

  const applyLocal = async () => {
    await applyMessagePatch(peerId, refMessageId, applied.patch);
    patchLastMessageMeta(setChatMeta, peerId, refMessageId, applied.patch);
    startTransition(() => {
      setMessages((prev) => {
        const current = prev[peerId] || [];
        const idx = current.findIndex((item) => item.messageId === refMessageId);
        if (idx < 0) return prev;
        const next = [...current];
        next[idx] = { ...next[idx], ...applied.patch };
        messageCacheRef.current = { ...messageCacheRef.current, [peerId]: next };
        return { ...prev, [peerId]: next };
      });
    });
  };

  if (isGroupChatId(peerId)) {
    const group = groupsRef.current.find((entry) => entry.id === peerId);
    const selfPeerId = ownPeerIdRef.current;
    if (!group || !selfPeerId || !isActiveGroupMember(group, selfPeerId)) {
      return Promise.resolve({ ok: false, error: 'not_group_member' });
    }
    const route = buildTargetedGroupRoute(group, selfPeerId, { includeInvited: false });
    const recipients = Array.from(route);
    const capable = selectFeatureCapablePeerIds(recipients, contacts, PEER_FEATURE_MESSAGE_EDIT);
    const skipped = recipients.filter((id) => !capable.includes(id));
    const envelope = {
      kind: GROUP_MESSAGE_KIND,
      protocolVersion: GROUP_PROTOCOL_VERSION,
      groupId: group.id,
      groupRevision: group.revision,
      messageId: inner.messageId,
      senderPeerId: selfPeerId,
      sender: displayName,
      timestamp: inner.editedAt,
      payload: {
        kind: MESSAGE_EDIT_KIND,
        refMessageId,
        content: text,
        editedAt: inner.editedAt,
      },
    };
    return (async () => {
      await applyLocal();
      await Promise.all(capable.map((recipientId) => sendGroupPacket(recipientId, envelope, {
        packetId: inner.messageId,
        groupId: group.id,
        type: 'control',
        queue: true,
      })));
      if (skipped.length === 0) return { ok: true };
      const one = skipped.length === 1
        ? (group.members?.find((member) => member.peerId === skipped[0])?.displayName
          || contactLabel(contacts, skipped[0]))
        : '';
      return {
        ok: true,
        localOnly: capable.length === 0,
        hint: skipped.length === 1
          ? legacyEditNotice(one)
          : 'Einige Mitglieder nutzen eine ältere BlueTalk-Version — die Änderung sieht dort nur du',
      };
    })().catch((error) => ({ ok: false, error: error?.message || 'group_edit_failed' }));
  }

  return (async () => {
    await applyLocal();
    const peerContact = contacts.find((entry) => entry?.id === peerId);
    if (!contactHasPeerFeature(peerContact, PEER_FEATURE_MESSAGE_EDIT)) {
      return {
        ok: true,
        localOnly: true,
        hint: legacyEditNotice(contactLabel(contacts, peerId)),
      };
    }
    const sent = await sendPairwiseEncrypted(peerId, inner);
    return { ok: Boolean(sent), error: sent ? undefined : 'send_failed' };
  })().catch((error) => ({ ok: false, error: error?.message || 'edit_failed' }));
}
