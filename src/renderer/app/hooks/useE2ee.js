// E2EE-Identity/Session-Aufbau, Handshake und paarweise Verschlüsselung,
// 1:1 aus App.jsx ausgelagert.
import { useEffect, useCallback } from 'react';
import {
  generateEcdhKeyPair,
  exportSpkiPublic,
  importPeerPublicFromSpki,
  deriveSharedAesKey,
  encryptChatPayload,
  importAesKeyFromRawB64,
  computeE2eeKeyId,
} from '../../chatCrypto';
import {
  persistE2eeSessionsMap,
  waitForE2eeIdentity,
  waitForE2eeSession,
} from '../e2eePersistence';
import { newChatMessageId } from '../appHelpers';

export function useE2ee({
  e2eeBootNonce,
  contactsRef,
  settingsRef,
  ownEcdhPrivateRef,
  ownEcdhPublicSpkiRef,
  e2eeSessionsRef,
  e2eeReadyPeersRef,
  e2eeHandshakeSentRef,
  e2eeHandshakePromisesRef,
  upsertContact,
}) {
  const sendE2eeHandshake = useCallback(async (peerId, options = {}) => {
    if (!window.bluetalk?.peer || !peerId || !ownEcdhPublicSpkiRef.current) return false;
    if (!options.force && e2eeHandshakeSentRef.current.has(peerId)) return true;
    const pending = e2eeHandshakePromisesRef.current.get(peerId);
    if (pending) {
      if (!options.force) return pending;
      await pending;
      return sendE2eeHandshake(peerId, options);
    }

    e2eeHandshakeSentRef.current.add(peerId);
    const promise = (async () => {
      try {
        const sent = await window.bluetalk.peer.send(peerId, {
          kind: 'e2ee-key-handshake',
          publicSpkiB64: ownEcdhPublicSpkiRef.current,
          e2eeVersions: [1, 2],
          requestReply: options.requestReply !== false,
          sender: settingsRef.current.displayName,
        });
        if (!sent) e2eeHandshakeSentRef.current.delete(peerId);
        return Boolean(sent);
      } catch {
        e2eeHandshakeSentRef.current.delete(peerId);
        return false;
      } finally {
        e2eeHandshakePromisesRef.current.delete(peerId);
      }
    })();
    e2eeHandshakePromisesRef.current.set(peerId, promise);
    return promise;
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.store) return undefined;
    let cancelled = false;

    (async () => {
      try {
        let identity = await window.bluetalk.store.get('e2eeIdentity', null);
        if (!identity?.privateJwk || !identity?.publicSpkiB64) {
          const pair = await generateEcdhKeyPair();
          const jwkPrivate = await crypto.subtle.exportKey('jwk', pair.privateKey);
          const publicSpkiB64 = await exportSpkiPublic(pair.publicKey);
          identity = { privateJwk: jwkPrivate, publicSpkiB64 };
          await window.bluetalk.store.set('e2eeIdentity', identity);
        }
        const storedContactsForE2ee = await window.bluetalk.store.get('contacts', []);
        if (cancelled) return;
        if (Array.isArray(storedContactsForE2ee)) {
          contactsRef.current = storedContactsForE2ee;
        }
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          identity.privateJwk,
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveBits']
        );
        ownEcdhPrivateRef.current = privateKey;
        ownEcdhPublicSpkiRef.current = identity.publicSpkiB64;

        const storedSessions = await window.bluetalk.store.get('e2eeSessions', {});
        const next = {};
        if (storedSessions && typeof storedSessions === 'object') {
          for (const [pid, row] of Object.entries(storedSessions)) {
            if (row?.peerPublicSpkiB64) {
              try {
                const peerPublic = await importPeerPublicFromSpki(row.peerPublicSpkiB64);
                const aesKey = await deriveSharedAesKey(privateKey, peerPublic);
                const keyId = row.keyId || await computeE2eeKeyId(identity.publicSpkiB64, row.peerPublicSpkiB64);
                next[pid] = {
                  aesKey,
                  keyId,
                  peerPublicSpkiB64: row.peerPublicSpkiB64,
                  pendingPeerPublicSpkiB64: row.pendingPeerPublicSpkiB64 || '',
                  keyChanged: row.keyChanged === true,
                };
              } catch {
                /* skip corrupt row */
              }
            } else if (row?.aesKeyB64) {
              try {
                next[pid] = { aesKey: await importAesKeyFromRawB64(row.aesKeyB64) };
              } catch {
                /* skip corrupt row */
              }
            }
          }
        }
        if (!cancelled) {
          // A live handshake may finish while sessions are loading; never overwrite that fresher key.
          e2eeSessionsRef.current = { ...next, ...e2eeSessionsRef.current };
        }

        if (!cancelled && window.bluetalk?.peer?.getPeers && ownEcdhPublicSpkiRef.current) {
          try {
            const peerList = await window.bluetalk.peer.getPeers();
            for (const p of peerList || []) {
              if (!p?.id) continue;
              if (contactsRef.current.some((c) => c?.id === p.id && c.blocked === true)) continue;
              void sendE2eeHandshake(p.id);
            }
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        console.error('E2EE bootstrap failed:', e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [e2eeBootNonce, sendE2eeHandshake]);

  const sendPairwiseEncrypted = useCallback(async (peerId, innerPayload) => {
    if (!window.bluetalk?.peer || !peerId || !innerPayload) return false;
    await waitForE2eeIdentity(ownEcdhPublicSpkiRef);
    let session = e2eeSessionsRef.current[peerId];
    const ready = e2eeReadyPeersRef.current.has(peerId);
    if (!session?.aesKey || !session.keyId || !ready || session.keyChanged === true) {
      await sendE2eeHandshake(peerId, { force: true, requestReply: true });
      session = await waitForE2eeSession(e2eeSessionsRef, e2eeReadyPeersRef, peerId, '', 8000);
    }
    if (!session?.aesKey || !session.keyId || session.keyChanged === true) return false;
    try {
      const encrypted = await encryptChatPayload(session.aesKey, innerPayload, {
        keyId: session.keyId,
        version: session.e2eeVersion === 2 ? 2 : 1,
      });
      return Boolean(await window.bluetalk.peer.send(peerId, {
        ...encrypted,
        sender: settingsRef.current.displayName,
        messageId: innerPayload.messageId || innerPayload.eventId || innerPayload.refMessageId || newChatMessageId(),
        timestamp: Number.isFinite(innerPayload.timestamp) ? innerPayload.timestamp : Date.now(),
      }));
    } catch (error) {
      console.warn('Pairwise encrypted send failed:', peerId, error?.message);
      return false;
    }
  }, [sendE2eeHandshake]);

  /**
   * Verwirft die E2EE-Sitzung eines Kontakts und startet einen frischen
   * Handshake — z. B. um einen erwarteten Schlüsselwechsel zu bestätigen.
   * (Ersetzt den früheren Klartext-Toggle; ausgehend ist immer E2EE.)
   */
  const resetE2eeSession = useCallback((contactId) => {
    if (!contactId) return;
    const next = { ...e2eeSessionsRef.current };
    delete next[contactId];
    e2eeSessionsRef.current = next;
    e2eeReadyPeersRef.current.delete(contactId);
    e2eeHandshakeSentRef.current.delete(contactId);
    void persistE2eeSessionsMap(e2eeSessionsRef);
    void sendE2eeHandshake(contactId, { force: true });
  }, [sendE2eeHandshake]);

  const setContactBlocked = useCallback((contactId, blocked) => {
    if (!contactId) return;
    upsertContact({ id: contactId, blocked: Boolean(blocked) });
    if (window.bluetalk) {
      void window.bluetalk.peer.send(contactId, {
        kind: 'contact-blocked',
        blocked: Boolean(blocked),
        sender: settingsRef.current.displayName,
      }).catch(() => {});
    }
    if (blocked) {
      const next = { ...e2eeSessionsRef.current };
      delete next[contactId];
      e2eeSessionsRef.current = next;
      e2eeReadyPeersRef.current.delete(contactId);
      e2eeHandshakeSentRef.current.delete(contactId);
      e2eeHandshakePromisesRef.current.delete(contactId);
      void persistE2eeSessionsMap(e2eeSessionsRef);
    } else if (window.bluetalk && ownEcdhPublicSpkiRef.current) {
      e2eeHandshakeSentRef.current.delete(contactId);
      void sendE2eeHandshake(contactId, { force: true });
    }
  }, [upsertContact, sendE2eeHandshake]);

  return {
    sendE2eeHandshake,
    sendPairwiseEncrypted,
    resetE2eeSession,
    setContactBlocked,
  };
}
