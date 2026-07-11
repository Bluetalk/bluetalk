import { useEffect, useState } from 'react';
import { isAiChatPeerId } from '../../../aiChatConstants';

/**
 * Auswahl des aktiven Chats inkl. Navigation-Sync (openPeerId), Auto-Auswahl
 * des ersten Chats und Bereinigung verwaister Auswahl.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useChatSelection({ location, navigate, mainChatList, chatList, aiAgentsLoaded }) {
  const [selectedPeerId, setSelectedPeerId] = useState(null);

  const openPeerFromNav = location.state?.openPeerId;
  useEffect(() => {
    if (!openPeerFromNav) return;
    setSelectedPeerId(openPeerFromNav);
    navigate('.', { replace: true, state: {} });
  }, [openPeerFromNav, navigate]);

  useEffect(() => {
    if (openPeerFromNav) return;
    if (selectedPeerId != null) return;
    const first = mainChatList[0];
    if (first) setSelectedPeerId(first.id);
  }, [openPeerFromNav, selectedPeerId, mainChatList]);

  useEffect(() => {
    if (selectedPeerId && !chatList.find((chat) => chat.id === selectedPeerId)) {
      // KI-Agenten erst verwerfen, wenn die Agentenliste geladen ist — sonst
      // geht die Auswahl eines frisch erstellten Agenten (openPeerId aus der
      // Navigation) verloren, bevor er in chatList auftauchen kann.
      if (isAiChatPeerId(selectedPeerId) && !aiAgentsLoaded) return;
      setSelectedPeerId(null);
    }
  }, [chatList, selectedPeerId, aiAgentsLoaded]);

  return { selectedPeerId, setSelectedPeerId };
}
