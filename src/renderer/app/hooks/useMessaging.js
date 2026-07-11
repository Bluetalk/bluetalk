// sendMessage (Direkt-Pfad; Gruppen-/KI-Zweig in eigenen Modulen), Receipts
// und Lösch-Aktionen, 1:1 aus App.jsx ausgelagert.
import { useCallback, startTransition } from 'react';
import { encryptChatPayload } from '../../chatCrypto';
import { waitForE2eeIdentity, waitForE2eeSession } from '../e2eePersistence';
import { newChatMessageId, contactWantsOutgoingE2ee } from '../appHelpers';
import { isAiChatPeerId } from '../../aiChatConstants';
import { sendGroupChatMessage } from '../sendGroupChatMessage';
import { sendAiChatMessage } from '../sendAiChatMessage';
import groupChat from '../../../shared/group-chat.js';

const {
  GROUP_PROTOCOL_VERSION,
  GROUP_RECEIPT_KIND,
  isActiveGroupMember,
  isGroupChatId,
} = groupChat;

export function useMessaging({
  settings,
  setMessages,
  setChatMeta,
  setLoadedChats,
  setPeerReadReceipts,
  setChatLastViewedPeerTs,
  setAiChatProgress,
  setAiChatPendingPeerId,
  contactsRef,
  settingsRef,
  groupsRef,
  ownPeerIdRef,
  messageCacheRef,
  deliveryTimersRef,
  inboundToastRef,
  activeAiChatRequestRef,
  sendMessageRef,
  e2eeSessionsRef,
  e2eeReadyPeersRef,
  ownEcdhPublicSpkiRef,
  groupOutboxRef,
  upsertContact,
  applyMessagePatch,
  sendE2eeHandshake,
  sendGroupPacket,
  removeContact,
  leaveGroupChat,
  removeGroup,
  persistGroupOutbox,
}) {
  const sendMessage = useCallback((peerId, payload) => {
    if (!window.bluetalk || !peerId) return Promise.resolve(false);

    if (isGroupChatId(peerId)) {
      return sendGroupChatMessage({
        groupsRef,
        ownPeerIdRef,
        messageCacheRef,
        displayName: settings.displayName,
        setMessages,
        setChatMeta,
        sendGroupPacket,
        applyMessagePatch,
      }, peerId, payload);
    }

    if (isAiChatPeerId(peerId)) {
      return sendAiChatMessage({
        displayName: settings.displayName,
        activeAiChatRequestRef,
        setMessages,
        setChatMeta,
        applyMessagePatch,
        setAiChatPendingPeerId,
        setAiChatProgress,
      }, peerId, payload);
    }

    if (contactsRef.current.some((c) => {
      if (c?.id !== peerId) return false;
      return c.blocked === true || c.blockedByPeer === true || c.chatDeletedByPeer === true;
    })) {
      return Promise.resolve(false);
    }

    const outgoing = typeof payload === 'string'
      ? { kind: 'chat', content: payload }
      : { kind: 'chat', ...payload };

    const localPreviewUrl =
      outgoing.kind === 'file' || outgoing.kind === 'sticker' ? outgoing.localPreviewUrl : undefined;
    const fileDataB64 =
      outgoing.kind === 'file' || outgoing.kind === 'sticker' ? outgoing.fileData : undefined;

    const payloadForCrypto = { ...outgoing };
    delete payloadForCrypto.localPreviewUrl;

    const messageId = newChatMessageId();
    const createdAt = Date.now();

    const innerPlain = {
      ...payloadForCrypto,
      sender: settings.displayName,
      messageId,
      timestamp: createdAt,
    };

    const selfMessageLight =
      innerPlain.kind === 'file' || innerPlain.kind === 'sticker'
        ? {
            ...innerPlain,
            fileData: undefined,
            localPreviewUrl,
            from: 'self',
            deliveryStatus: 'pending',
          }
        : {
            ...innerPlain,
            from: 'self',
            deliveryStatus: 'pending',
          };

    const selfMessageFull = {
      ...innerPlain,
      from: 'self',
      deliveryStatus: 'pending',
    };

    const flushOptimistic = () => {
      setMessages((prev) => ({
        ...prev,
        [peerId]: [...(prev[peerId] || []), selfMessageLight],
      }));

      setChatMeta((prev) => ({
        ...prev,
        [peerId]: {
          count: (prev[peerId]?.count || 0) + 1,
          lastMessage: selfMessageLight,
        },
      }));

      upsertContact({ id: peerId, hasOutgoing: true, pendingMessageRequest: false });
    };

    startTransition(flushOptimistic);

    const sendPromise = (async () => {
      const revokePreview = () => {
        if (localPreviewUrl) {
          try {
            URL.revokeObjectURL(localPreviewUrl);
          } catch {
            /* ignore */
          }
        }
      };

      const failScheduled = () => {
        revokePreview();
        void applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled', localPreviewUrl: undefined });
      };

      let wirePayload = innerPlain;
      if (
        contactWantsOutgoingE2ee(contactsRef, peerId)
        && (innerPlain.kind === 'chat' || innerPlain.kind === 'file' || innerPlain.kind === 'contact-share' || innerPlain.kind === 'sticker')
      ) {
        await waitForE2eeIdentity(ownEcdhPublicSpkiRef);
        let session = e2eeSessionsRef.current[peerId];
        const ready = e2eeReadyPeersRef.current.has(peerId);
        if (!session?.aesKey || !session.keyId || !ready || session.keyChanged === true) {
          await sendE2eeHandshake(peerId, { force: true, requestReply: true });
          session = await waitForE2eeSession(
            e2eeSessionsRef,
            e2eeReadyPeersRef,
            peerId,
            '',
            8000
          );
        }

        if (!session?.aesKey || !session.keyId || session.keyChanged === true) {
          inboundToastRef.current?.({
            variant: 'error',
            title: 'E2EE nicht bereit',
            message: 'Die Nachricht wurde nicht als Klartext gesendet. Prüfe die Verbindung oder bestätige einen erwarteten Schlüsselwechsel, indem du E2EE aus- und wieder einschaltest.',
          });
          failScheduled();
          return false;
        }

        try {
          wirePayload = await encryptChatPayload(session.aesKey, innerPlain, {
            keyId: session.keyId,
            version: session.e2eeVersion === 2 ? 2 : 1,
          });
        } catch (e) {
          console.error('E2EE encrypt failed:', e);
          failScheduled();
          return false;
        }
      }

      const wire = {
        ...wirePayload,
        sender: settingsRef.current.displayName,
        messageId,
        timestamp: createdAt,
      };

      const isFile = innerPlain.kind === 'file' || innerPlain.kind === 'sticker';
      const deferDisk = isFile;

      try {
        let sent;
        let meta;

        if (isFile && deferDisk) {
          sent = await window.bluetalk.peer.send(peerId, wire);
          if (!sent) {
            failScheduled();
            return false;
          }
          meta = await window.bluetalk.messages.append(peerId, selfMessageFull);
        } else {
          const pair = await Promise.all([
            window.bluetalk.peer.send(peerId, wire),
            window.bluetalk.messages.append(peerId, selfMessageFull),
          ]);
          sent = pair[0];
          meta = pair[1];
          if (!sent) {
            failScheduled();
            return false;
          }
        }

        if (isFile && fileDataB64) {
          await applyMessagePatch(peerId, messageId, { fileData: fileDataB64, localPreviewUrl: undefined });
          revokePreview();
        }

        if (meta?.count) {
          setChatMeta((prev) => ({ ...prev, [peerId]: meta }));
        }

        const t = setTimeout(() => {
          deliveryTimersRef.current.delete(messageId);
          void applyMessagePatch(peerId, messageId, { deliveryStatus: 'scheduled' });
        }, 8000);
        deliveryTimersRef.current.set(messageId, t);

        return true;
      } catch {
        failScheduled();
        return false;
      }
    })();

    return sendPromise;
  }, [settings.displayName, upsertContact, applyMessagePatch, sendE2eeHandshake, sendGroupPacket]);

  sendMessageRef.current = sendMessage;

  const sendReadReceipt = useCallback(async (peerId, lastReadMessageId) => {
    if (!window.bluetalk || !peerId || !lastReadMessageId) return;
    if (isGroupChatId(peerId)) {
      if (!settings.sendReadReceipts) return;
      const group = groupsRef.current.find((entry) => entry.id === peerId);
      const message = (messageCacheRef.current[peerId] || []).find((entry) => entry.messageId === lastReadMessageId);
      if (!group || !message?.senderPeerId || message.from === 'self') return;
      const receipt = {
        kind: GROUP_RECEIPT_KIND,
        protocolVersion: GROUP_PROTOCOL_VERSION,
        groupId: peerId,
        refMessageId: lastReadMessageId,
        senderPeerId: ownPeerIdRef.current,
        status: 'seen',
        receivedAt: Date.now(),
      };
      await sendGroupPacket(message.senderPeerId, receipt, {
        packetId: `seen:${lastReadMessageId}`,
        groupId: peerId,
        type: 'receipt',
        queue: false,
      });
      return;
    }
    if (contactsRef.current.some((c) => c?.id === peerId && c.blocked === true)) return;
    if (!settings.sendReadReceipts) return;
    try {
      const sent = await window.bluetalk.peer.send(peerId, {
        kind: 'read-receipt',
        lastReadMessageId,
        sender: settings.displayName,
      });
      if (!sent) {
        console.warn('[App] Read receipt failed to send to', peerId);
      }
    } catch (err) {
      console.warn('[App] Read receipt error:', err.message);
    }
  }, [settings.displayName, settings.sendReadReceipts, sendGroupPacket]);

  const deleteMessage = useCallback(async (peerId, messageId) => {
    if (!window.bluetalk || !peerId || !messageId) return false;
    const deleted = await window.bluetalk.messages.deleteMessage(peerId, messageId);
    if (!deleted) return false;

    setMessages((prev) => {
      const list = prev[peerId] || [];
      const updated = list.filter((m) => m.messageId !== messageId);
      messageCacheRef.current = { ...messageCacheRef.current, [peerId]: updated };
      return { ...prev, [peerId]: updated };
    });

    setChatMeta((prev) => {
      const meta = prev[peerId];
      if (!meta) return prev;
      const newCount = Math.max(0, (meta.count || 1) - 1);
      return {
        ...prev,
        [peerId]: {
          ...meta,
          count: newCount,
          lastMessage: meta.lastMessage?.messageId === messageId ? null : meta.lastMessage,
        },
      };
    });

    return true;
  }, []);

  const deleteChat = useCallback(async (peerId) => {
    if (!window.bluetalk || !peerId) return false;

    if (!isAiChatPeerId(peerId) && !isGroupChatId(peerId)) {
      try {
        await window.bluetalk.peer.send(peerId, {
          kind: 'chat-deleted',
          sender: settingsRef.current.displayName,
        });
      } catch {
        /* Peer evtl. offline */
      }
    }

    await window.bluetalk.messages.deleteChat(peerId);
    setPeerReadReceipts((prev) => {
      const next = { ...prev };
      delete next[peerId];
      if (window.bluetalk) window.bluetalk.store.set('chatReadReceipts', next);
      return next;
    });
    setChatLastViewedPeerTs((prev) => {
      const next = { ...prev };
      delete next[peerId];
      if (window.bluetalk) window.bluetalk.store.set('chatLastViewedPeerTs', next);
      return next;
    });
    setMessages((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      messageCacheRef.current = updated;
      return updated;
    });
    setChatMeta((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    setLoadedChats((prev) => {
      const updated = { ...prev };
      delete updated[peerId];
      return updated;
    });
    if (isAiChatPeerId(peerId)) {
      const agents = await window.bluetalk.store.get('aiChat.agents', []);
      if (Array.isArray(agents)) {
        await window.bluetalk.store.set('aiChat.agents', agents.filter((agent) => agent?.id !== peerId));
      }
    } else if (!isGroupChatId(peerId)) {
      removeContact(peerId);
    }
    return true;
  }, [removeContact]);

  const deleteGroupChat = useCallback(async (groupId) => {
    if (!window.bluetalk || !groupId || !isGroupChatId(groupId)) return false;

    const current = groupsRef.current.find((group) => group.id === groupId);
    if (current && isActiveGroupMember(current, ownPeerIdRef.current)) {
      try {
        await leaveGroupChat(groupId);
      } catch {
        /* Austritt konnte nicht gemeldet werden – lokales Löschen trotzdem fortsetzen */
      }
    }

    removeGroup(groupId);
    persistGroupOutbox(groupOutboxRef.current.filter((entry) => entry.groupId !== groupId));
    await deleteChat(groupId);
    return true;
  }, [leaveGroupChat, removeGroup, persistGroupOutbox, deleteChat]);

  return {
    sendMessage,
    sendReadReceipt,
    deleteMessage,
    deleteChat,
    deleteGroupChat,
  };
}
