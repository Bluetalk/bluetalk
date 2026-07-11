import { useCallback, useMemo } from 'react';
import { isAiChatPeerId } from '../../../aiChatConstants';
import { isPresenceStale } from '../../../../shared/game-presence.js';
import groupChat from '../../../../shared/group-chat.js';

const { isActiveGroupMember, isGroupChatId } = groupChat;

/**
 * Baut die sortierte Chatliste (Peers, Gruppen, KI-Agenten) samt Lookups.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatListData({
  contacts,
  peers,
  chatMeta,
  groups,
  ownPeerId,
  aiAgents,
  peerGamePresence,
  peerUserPresence,
}) {
  const contactById = useMemo(() => {
    const map = new Map();
    for (const c of contacts) {
      if (c?.id) map.set(c.id, c);
    }
    return map;
  }, [contacts]);

  const peerById = useMemo(() => {
    const map = new Map();
    for (const p of peers) {
      if (p?.id) map.set(p.id, p);
    }
    return map;
  }, [peers]);

  const resolveContact = useCallback(
    (peerId) => (peerId ? contactById.get(peerId) ?? null : null),
    [contactById]
  );

  const chatList = useMemo(() => {
    const ids = new Set([
      ...contacts.map((c) => c.id),
      ...peers.map((p) => p.id),
      ...Object.keys(chatMeta || {}),
    ]);
    ids.delete('self');
    for (const id of [...ids]) {
      if (isAiChatPeerId(id) || isGroupChatId(id)) ids.delete(id);
    }

    const list = [];
    for (const id of ids) {
      const peer = peerById.get(id) || null;
      const contact = contactById.get(id) || null;
      const meta = chatMeta[id] || null;
      const baseName = contact?.name || peer?.name || id;
      const profilePicture = contact?.profilePicture || peer?.profilePicture || '';
      const bio = contact?.bio ?? peer?.bio ?? '';

      list.push({
        id,
        peer,
        contact,
        displayName: contact?.nickname || baseName,
        baseName,
        profilePicture,
        bio,
        offline: !peer,
        pinned: Boolean(contact?.pinned),
        e2eePlaintextBadge: contact?.e2eeEnabled === false,
        lastMessage: meta?.lastMessage || null,
        messageCount: meta?.count || 0,
        gamePresence: peerGamePresence[id] && !isPresenceStale(peerGamePresence[id])
          ? peerGamePresence[id]
          : null,
        userPresence: peerUserPresence[id] || null,
      });
    }

    const sorted = list.sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      const aTs = a.lastMessage?.timestamp || a.contact?.addedAt || 0;
      const bTs = b.lastMessage?.timestamp || b.contact?.addedAt || 0;
      return bTs - aTs;
    });

    const aiEntries = aiAgents.map((agent) => {
      const aiMeta = chatMeta[agent.id] || null;
      return {
        id: agent.id,
        peer: null,
        contact: null,
        displayName: agent.name || 'KI-Assistent',
        baseName: agent.name || 'KI-Assistent',
        profilePicture: agent.profilePicture || '',
        bio: agent.bio || '',
        offline: false,
        pinned: false,
        isAiChat: true,
        isAgent: true,
        agentWorkDir: agent.agentWorkDir || '',
        e2eePlaintextBadge: false,
        lastMessage: aiMeta?.lastMessage || null,
        messageCount: aiMeta?.count || 0,
        createdAt: agent.createdAt || 0,
      };
    });

    const groupEntries = (groups || []).map((group) => {
      const groupMeta = chatMeta[group.id] || null;
      const activeMembers = group.members.filter((member) => member.state === 'active');
      const onlineMembers = activeMembers.filter((member) => member.peerId === ownPeerId || peerById.has(member.peerId));
      return {
        id: group.id,
        peer: null,
        contact: null,
        group,
        isGroup: true,
        displayName: group.name,
        baseName: group.name,
        profilePicture: group.image || '',
        bio: '',
        offline: onlineMembers.length <= 1,
        pinned: false,
        e2eePlaintextBadge: false,
        lastMessage: groupMeta?.lastMessage || null,
        messageCount: groupMeta?.count || 0,
        activeMemberCount: activeMembers.length,
        onlineMemberCount: onlineMembers.length,
        canSend: isActiveGroupMember(group, ownPeerId),
        createdAt: group.createdAt || 0,
      };
    });

    return [...aiEntries, ...groupEntries, ...sorted].sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      const aTs = a.lastMessage?.timestamp || a.contact?.addedAt || a.createdAt || 0;
      const bTs = b.lastMessage?.timestamp || b.contact?.addedAt || b.createdAt || 0;
      return bTs - aTs;
    });
  }, [aiAgents, chatMeta, contactById, contacts, groups, ownPeerId, peerById, peers, peerGamePresence, peerUserPresence]);

  const mainChatList = useMemo(
    () =>
      chatList.filter((chat) => {
        if (chat.isAiChat || chat.isGroup) return true;
        if (chat.contact?.pendingMessageRequest === true) return false;
        if (
          chat.messageCount === 0
          && !chat.contact?.hasOutgoing
          && !chat.contact?.blocked
          && !chat.contact?.blockedByPeer
        ) {
          return false;
        }
        return true;
      }),
    [chatList]
  );

  return { contactById, peerById, resolveContact, chatList, mainChatList };
}
