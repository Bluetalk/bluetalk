// Der große `peer:message`-Handler, 1:1 aus dem useLayoutEffect in App.jsx
// ausgelagert. Alle Abhängigkeiten (Refs, Setter, Callbacks) kommen über `deps`.
import { startTransition } from 'react';
import {
  importPeerPublicFromSpki,
  deriveSharedAesKey,
  decryptChatPayload,
  computeE2eeKeyId,
} from '../chatCrypto';
import { MAX_CHAT_FILE_BYTES, MAX_CHAT_TEXT_CHARS } from './chatConstants';
import { persistE2eeSessionsMap, waitForE2eeSession } from './e2eePersistence';
import { newChatMessageId } from './appHelpers';
import { base64ByteLength, validateStickerData } from '../stickers/stickerStore';
import { isContactNotificationMuted } from '../contactNotificationMute';
import { buildMessageNotificationPreview } from '../utils/messageNotificationPreview';
import {
  GAME_PRESENCE_CLEAR_KIND,
  GAME_PRESENCE_KIND,
  gameInviteKey,
} from '../../shared/game-presence.js';
import { USER_PRESENCE_KIND } from '../../shared/user-presence.js';
import { REALTIME_KIND } from '../../shared/plugin-realtime.mjs';
import { GROUP_PROTOCOL_KINDS, handleGroupProtocolFrame } from './groupInboundHandler';

// Eingehende Inhalte, die eine Desktop-Benachrichtigung auslösen sollen.
const NOTIFYABLE_KINDS = new Set([
  'chat',
  'file',
  'sticker',
  'contact-share',
]);

// Einladungen laufen an Chatverlauf vorbei in den Spiele- bzw. Dokumente-Tab.
const INVITE_KINDS = new Set([
  'poker-invite',
  'uno-invite',
  'connect-four-invite',
  'chess-invite',
  'tic-tac-toe-invite',
  'live-docs-invite',
]);

export function createPeerMessageHandler(deps) {
  const {
    contactsRef,
    settingsRef,
    deliveryTimersRef,
    inboundToastRef,
    e2eeSessionsRef,
    e2eeReadyPeersRef,
    e2eeHandshakeSentRef,
    ownEcdhPrivateRef,
    ownEcdhPublicSpkiRef,
    upsertContact,
    applyContactPatch,
    applyMessagePatch,
    sendE2eeHandshake,
    setPeerReadReceipts,
    setPeerUserPresence,
    setPeerGamePresence,
    setGameInviteKeys,
    setDocInvites,
    setChatMeta,
    setMessages,
    setContacts,
  } = deps;

  return async (msg) => {
    const fromId = msg.from;
    const isBlocked = fromId && contactsRef.current.some((c) => c?.id === fromId && c.blocked === true);

    if (msg.kind === 'contact-blocked' && fromId) {
      // Von uns blockierte Kontakte dürfen keine Status-Frames mehr auslösen
      if (isBlocked) return;
      const blocked = msg.blocked === true;
      upsertContact({ id: fromId, blockedByPeer: blocked });
      inboundToastRef.current?.({
        variant: blocked ? 'warning' : 'success',
        title: blocked ? 'Du wurdest blockiert' : 'Blockierung aufgehoben',
        message: blocked
          ? `${msg.sender || fromId} hat dich blockiert. Du kannst keine Nachrichten senden, bis du entblockt wirst.`
          : `${msg.sender || fromId} hat die Blockierung aufgehoben. Du kannst wieder Nachrichten senden.`,
      });
      return;
    }

    if (msg.kind === 'chat-deleted' && fromId) {
      if (isBlocked) return;
      upsertContact({ id: fromId, chatDeletedByPeer: true });
      inboundToastRef.current?.({
        variant: 'info',
        title: 'Chat gelöscht',
        message: `${msg.sender || fromId} hat den Chat gelöscht. Du kannst den Verlauf exportieren oder lokal entfernen.`,
      });
      return;
    }

    if (msg.kind === 'messaging-blocked' && msg.refMessageId && fromId) {
      if (isBlocked) return;
      const tid = deliveryTimersRef.current.get(msg.refMessageId);
      if (tid) clearTimeout(tid);
      deliveryTimersRef.current.delete(msg.refMessageId);
      await applyMessagePatch(fromId, msg.refMessageId, { deliveryStatus: 'blocked' });
      upsertContact({ id: fromId, blockedByPeer: true });
      inboundToastRef.current?.({
        variant: 'warning',
        title: 'Nachricht nicht zugestellt',
        message: 'Dieser Kontakt hat dich blockiert.',
      });
      return;
    }

    if (msg.kind === 'profile' && fromId) {
      if (isBlocked) return;
      upsertContact({
        id: fromId,
        name: msg.displayName || msg.sender || fromId,
        bio: msg.bio,
        profilePicture: msg.profilePicture,
      });
      return;
    }

    if (msg.kind === 'e2ee-key-handshake' && fromId && msg.publicSpkiB64 && ownEcdhPrivateRef.current) {
      if (isBlocked) return;
      try {
        const previous = e2eeSessionsRef.current[fromId];
        if (previous?.peerPublicSpkiB64 && previous.peerPublicSpkiB64 !== msg.publicSpkiB64) {
          e2eeReadyPeersRef.current.delete(fromId);
          e2eeSessionsRef.current = {
            ...e2eeSessionsRef.current,
            [fromId]: {
              ...previous,
              pendingPeerPublicSpkiB64: msg.publicSpkiB64,
              keyChanged: true,
            },
          };
          await persistE2eeSessionsMap(e2eeSessionsRef);
          inboundToastRef.current?.({
            variant: 'warning',
            title: 'E2EE-Sicherheitsschlüssel geändert',
            message: 'Die verschlüsselte Sitzung wurde angehalten. Wähle im Chat-Menü „Verschlüsselung erneuern“, wenn die Änderung erwartet war.',
          });
          return;
        }

        const peerPub = await importPeerPublicFromSpki(msg.publicSpkiB64);
        const aesKey = await deriveSharedAesKey(ownEcdhPrivateRef.current, peerPub);
        const keyId = await computeE2eeKeyId(ownEcdhPublicSpkiRef.current, msg.publicSpkiB64);
        e2eeSessionsRef.current = {
          ...e2eeSessionsRef.current,
          [fromId]: {
            aesKey,
            keyId,
            peerPublicSpkiB64: msg.publicSpkiB64,
            pendingPeerPublicSpkiB64: '',
            keyChanged: false,
            e2eeVersion: Array.isArray(msg.e2eeVersions) && msg.e2eeVersions.includes(2) ? 2 : 1,
          },
        };
        e2eeReadyPeersRef.current.add(fromId);
        await persistE2eeSessionsMap(e2eeSessionsRef);
        if (msg.requestReply === true || !e2eeHandshakeSentRef.current.has(fromId)) {
          void sendE2eeHandshake(fromId, { force: msg.requestReply === true, requestReply: false });
        }
      } catch (e) {
        console.error('E2EE handshake failed:', e);
      }
      return;
    }

    if (msg.kind === 'delivery-receipt' && msg.refMessageId && fromId) {
      if (isBlocked) return;
      const tid = deliveryTimersRef.current.get(msg.refMessageId);
      if (tid) clearTimeout(tid);
      deliveryTimersRef.current.delete(msg.refMessageId);
      await applyMessagePatch(fromId, msg.refMessageId, {
        deliveryStatus: 'delivered',
        deliveredAt: typeof msg.receivedAt === 'number' ? msg.receivedAt : Date.now(),
      });
      upsertContact({ id: fromId, blockedByPeer: false });
      return;
    }

    if (msg.kind === 'read-receipt' && msg.lastReadMessageId && fromId) {
      if (isBlocked) return;
      setPeerReadReceipts((prev) => {
        const next = { ...prev, [fromId]: msg.lastReadMessageId };
        if (window.bluetalk) window.bluetalk.store.set('chatReadReceipts', next);
        return next;
      });
      return;
    }

    // Poker-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
    if (msg.kind === 'poker' && fromId) {
      if (isBlocked) return;
      return;
    }

    // UNO-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
    if (msg.kind === 'uno' && fromId) {
      if (isBlocked) return;
      return;
    }

    // Vier-gewinnt-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
    if (msg.kind === 'connect-four' && fromId) {
      if (isBlocked) return;
      return;
    }

    // Schach-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
    if (msg.kind === 'chess' && fromId) {
      if (isBlocked) return;
      return;
    }

    // Tic-Tac-Toe-Spielprotokoll (Wire) — nicht im Chatverlauf speichern
    if (msg.kind === 'tic-tac-toe' && fromId) {
      if (isBlocked) return;
      return;
    }

    // Plugin-Realtime-Protokoll — nicht im Chatverlauf speichern
    if (msg.kind === REALTIME_KIND && fromId) {
      if (isBlocked) return;
      return;
    }

    if (msg.kind === USER_PRESENCE_KIND && fromId) {
      if (isBlocked) return;
      setPeerUserPresence((prev) => ({
        ...prev,
        [fromId]: {
          status: msg.status === 'dnd' ? 'dnd' : 'online',
          updatedAt: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        },
      }));
      return;
    }

    if (msg.kind === GAME_PRESENCE_KIND && fromId) {
      if (isBlocked) return;
      setPeerGamePresence((prev) => ({
        ...prev,
        [fromId]: {
          ...msg,
          peerId: fromId,
          updatedAt: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
        },
      }));
      return;
    }

    if (msg.kind === GAME_PRESENCE_CLEAR_KIND && fromId) {
      setPeerGamePresence((prev) => {
        const current = prev[fromId];
        if (!current) return prev;
        if (msg.sessionId && current.sessionId !== msg.sessionId) return prev;
        const next = { ...prev };
        delete next[fromId];
        return next;
      });
      return;
    }

    if (isBlocked) {
      const k = msg.kind;
      const blockable =
        k === 'chat' || k === 'file' || k === 'sticker' || k === 'encrypted-chat-e2ee' || k === 'poker-invite' || k === 'uno-invite' || k === 'connect-four-invite' || k === 'chess-invite' || k === 'tic-tac-toe-invite' || k === 'live-docs-invite' || k === 'contact-share';
      if (blockable && fromId && msg.messageId) {
        void window.bluetalk.peer.send(fromId, {
          kind: 'messaging-blocked',
          refMessageId: msg.messageId,
          sender: settingsRef.current.displayName,
        });
      }
      return;
    }

    let normalized = {
      ...msg,
      messageId: msg.messageId || newChatMessageId(),
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
    };
    let wasPairwiseEncrypted = false;

    if (msg.kind === 'encrypted-chat-e2ee' && fromId) {
      const expectedKeyId = Number(msg.e2eeV || 1) === 2 ? String(msg.keyId || '') : '';
      let session = e2eeSessionsRef.current[fromId];
      const ready = e2eeReadyPeersRef.current.has(fromId);
      if (!session?.aesKey || !ready || (expectedKeyId && session.keyId !== expectedKeyId)) {
        await sendE2eeHandshake(fromId, { force: true, requestReply: true });
        session = await waitForE2eeSession(
          e2eeSessionsRef,
          e2eeReadyPeersRef,
          fromId,
          expectedKeyId,
          5000
        );
      }
      if (!session?.aesKey) {
        console.warn('E2EE message held because no current session is available:', fromId);
        return;
      }
      try {
        const inner = await decryptChatPayload(session.aesKey, msg, { keyId: session.keyId || '' });
        normalized = {
          ...inner,
          messageId: inner.messageId || normalized.messageId,
          timestamp: typeof inner.timestamp === 'number' ? inner.timestamp : normalized.timestamp,
          from: fromId,
        };
        wasPairwiseEncrypted = true;
      } catch (e) {
        console.error('E2EE decrypt failed:', e);
        return;
      }
    }

    if (GROUP_PROTOCOL_KINDS.includes(normalized.kind)) {
      await handleGroupProtocolFrame(deps, normalized, fromId, wasPairwiseEncrypted);
      return;
    }

    if (normalized.kind === 'sticker') {
      try {
        normalized = { ...normalized, ...validateStickerData(normalized) };
      } catch {
        console.warn('Rejected invalid sticker payload from peer:', fromId);
        return;
      }
    } else if (normalized.kind === 'file' && normalized.fileData) {
      const actualSize = base64ByteLength(normalized.fileData);
      if (actualSize < 0 || actualSize > MAX_CHAT_FILE_BYTES) {
        console.warn('Rejected oversized or invalid file payload from peer:', fromId);
        return;
      }
      normalized = { ...normalized, fileSize: actualSize };
    } else if (normalized.kind === 'chat' && String(normalized.content || '').length > MAX_CHAT_TEXT_CHARS) {
      console.warn('Rejected oversized chat message from peer:', fromId);
      return;
    }

    // Spiel- und Dokument-Einladungen landen nicht mehr im Chatverlauf:
    // sie werden registriert (Spiele-Tab bzw. Dokumente-Tab zeigen sie an),
    // lösen eine Benachrichtigung aus und sind damit abgehandelt.
    if (INVITE_KINDS.has(normalized.kind) && fromId) {
      if (normalized.kind === 'live-docs-invite') {
        const roomId = String(normalized.roomId || '');
        const hostPeerId = normalized.hostPeerId || fromId;
        if (roomId && hostPeerId) {
          setDocInvites?.((prev) => {
            const list = Array.isArray(prev) ? prev : [];
            if (list.some((entry) => entry?.roomId === roomId)) return list;
            const next = [
              {
                roomId,
                hostPeerId,
                fileName: String(normalized.fileName || ''),
                sender: String(normalized.sender || ''),
                receivedAt: Date.now(),
              },
              ...list,
            ].slice(0, 20);
            void window.bluetalk?.store?.set?.('liveDocsInvites', next);
            return next;
          });
        }
      } else {
        const game = normalized.kind === 'poker-invite'
          ? 'poker'
          : normalized.kind === 'uno-invite'
            ? 'uno'
            : normalized.kind === 'chess-invite'
              ? 'chess'
              : normalized.kind === 'tic-tac-toe-invite'
                ? 'tic-tac-toe'
                : 'connect-four';
        const sessionId = game === 'poker' ? normalized.tableId : normalized.gameId;
        const hostPeerId = normalized.hostPeerId || fromId;
        if (sessionId && hostPeerId) {
          const key = gameInviteKey(game, hostPeerId, sessionId);
          setGameInviteKeys((prev) => {
            if (prev.has(key)) return prev;
            const next = new Set(prev);
            next.add(key);
            void window.bluetalk?.store?.set?.('gameInviteKeys', [...next]);
            return next;
          });
        }
      }
      const inviteContact = contactsRef.current.find((entry) => entry?.id === fromId);
      if (!settingsRef.current.doNotDisturb && !isContactNotificationMuted(inviteContact)) {
        void window.bluetalk?.notify?.show?.({
          title: inviteContact?.nickname || inviteContact?.name || normalized.sender || fromId,
          body: buildMessageNotificationPreview(normalized),
        });
      }
      return;
    }

    if ((normalized.kind === 'chat' || normalized.kind === 'file' || normalized.kind === 'sticker' || normalized.kind === 'contact-share') && normalized.messageId && fromId) {
      void window.bluetalk.peer.send(fromId, {
        kind: 'delivery-receipt',
        refMessageId: normalized.messageId,
        receivedAt: Date.now(),
        sender: settingsRef.current.displayName,
      });
    }

    const meta = await window.bluetalk.messages.append(fromId, normalized);
    if (meta?.appended === false) return;

    // Benachrichtigen erst nach erfolgreichem Append (keine Duplikate) und
    // unabhängig davon, ob die Nachricht verschlüsselt ankam.
    if (NOTIFYABLE_KINDS.has(normalized.kind) && fromId) {
      const notifyContact = contactsRef.current.find((entry) => entry?.id === fromId);
      if (!settingsRef.current.doNotDisturb && !isContactNotificationMuted(notifyContact)) {
        void window.bluetalk?.notify?.show?.({
          title: notifyContact?.nickname || notifyContact?.name || normalized.sender || fromId,
          body: buildMessageNotificationPreview(normalized),
        });
      }
    }

    if (normalized.kind === 'contact-share' && normalized.sharedContact?.id) {
      const shared = normalized.sharedContact;
      upsertContact({
        id: shared.id,
        name: shared.displayName || shared.name || shared.id,
        bio: shared.bio,
        profilePicture: shared.profilePicture,
        address: shared.address,
      });
    }

    setChatMeta((prev) => ({
      ...prev,
      [fromId]: meta?.count ? meta : {
        count: (prev[fromId]?.count || 0) + 1,
        lastMessage: normalized,
      },
    }));

    startTransition(() => {
      setMessages((prev) => ({
        ...prev,
        [fromId]: [...(prev[fromId] || []), normalized],
      }));
    });

    if (fromId) {
      setContacts((prev) => {
        const existing = prev.find((c) => c?.id === fromId) || null;
        const hasOutgoing = existing?.hasOutgoing === true;
        const requestCleared = existing?.pendingMessageRequest === false;
        const updated = applyContactPatch(prev, {
          id: fromId,
          blockedByPeer: false,
          chatDeletedByPeer: false,
          name: normalized.sender || existing?.name || fromId,
          pendingMessageRequest: hasOutgoing || requestCleared ? false : true,
        });
        if (window.bluetalk) void window.bluetalk.store.set('contacts', updated);
        return updated;
      });
    }
  };
}
