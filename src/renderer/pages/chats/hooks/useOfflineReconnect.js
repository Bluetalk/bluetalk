import { useEffect, useMemo } from 'react';
import { peerProfileAddress } from '../messageHelpers.jsx';

/**
 * Auto-Reconnect für Offline-Peers mit gespeicherter Adresse: liefert die
 * Composer-Overlay-Flags und versucht still, die Verbindung wiederherzustellen.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useOfflineReconnect({ selectedPeer, isAiChatSelected, isGroupSelected, connectToAddress }) {
  const showOfflineComposerReconnect = Boolean(
    selectedPeer &&
      !isAiChatSelected &&
      !isGroupSelected &&
      !selectedPeer.peer &&
      !selectedPeer.contact?.blocked
  );

  const offlineReconnectAddress = useMemo(() => {
    if (!selectedPeer || selectedPeer.peer) return '';
    return (peerProfileAddress(selectedPeer) || '').trim();
  }, [selectedPeer]);

  useEffect(() => {
    if (!showOfflineComposerReconnect || !offlineReconnectAddress) return undefined;
    let cancelled = false;
    let busy = false;
    const attempt = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        await connectToAddress(offlineReconnectAddress);
      } catch {
        /* Peer weiter offline — kein Toast */
      } finally {
        if (!cancelled) {
          busy = false;
        }
      }
    };
    void attempt();
    window.addEventListener('online', attempt);
    return () => {
      cancelled = true;
      window.removeEventListener('online', attempt);
    };
  }, [showOfflineComposerReconnect, offlineReconnectAddress, connectToAddress]);

  return { showOfflineComposerReconnect, offlineReconnectAddress };
}
