// E2EE-Persistenz-/Warte-Helfer, ausgelagert aus App.jsx.
// Reine Funktionen: Refs werden als Parameter übergeben (keine Closure über
// Komponenten-State). Verhalten identisch zur ursprünglichen Inline-Version.

import { exportAesKeyToB64 } from '../chatCrypto';

// Modul-weite serialisierte Schreibqueue (ein Singleton wie zuvor in App.jsx).
let e2eePersistQueue = Promise.resolve();

export function persistE2eeSessionsMap(sessionsRef) {
  if (!window.bluetalk) return Promise.resolve();
  const snapshot = Object.entries(sessionsRef.current || {});
  e2eePersistQueue = e2eePersistQueue.catch(() => {}).then(async () => {
    const out = {};
    for (const [peerId, row] of snapshot) {
      if (!row?.aesKey) continue;
      if (row.peerPublicSpkiB64) {
        out[peerId] = {
          peerPublicSpkiB64: row.peerPublicSpkiB64,
          keyId: row.keyId || '',
          pendingPeerPublicSpkiB64: row.pendingPeerPublicSpkiB64 || '',
          keyChanged: row.keyChanged === true,
        };
      } else {
        // Legacy migration: keep the old raw key only until the next completed key exchange.
        out[peerId] = { aesKeyB64: await exportAesKeyToB64(row.aesKey) };
      }
    }
    await window.bluetalk.store.set('e2eeSessions', out);
  });
  return e2eePersistQueue;
}

export async function waitForE2eeIdentity(publicKeyRef, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!publicKeyRef.current && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return publicKeyRef.current || '';
}

export async function waitForE2eeSession(sessionsRef, readyPeersRef, peerId, expectedKeyId = '', timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const session = sessionsRef.current[peerId];
    const keyMatches = !expectedKeyId || session?.keyId === expectedKeyId;
    if (session?.aesKey && keyMatches && readyPeersRef.current.has(peerId) && session.keyChanged !== true) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}
