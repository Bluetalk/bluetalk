import { useCallback, useMemo, useState } from 'react';
import { buildForwardPayload } from '../messageHelpers.jsx';

/**
 * Weiterleiten-Dialog: Zielauswahl, Senden der Weiterleitungen und die Liste
 * der erlaubten Ziel-Chats.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useForwarding({
  mainChatList,
  selectedPeer,
  sendMessage,
  toast,
  closeMessageContextMenu,
  exitSelectionMode,
}) {
  const [forwardDialog, setForwardDialog] = useState(null);
  const [forwardingMessages, setForwardingMessages] = useState(false);

  const openForwardDialog = useCallback((items) => {
    const list = Array.isArray(items) ? items.filter((m) => m?.messageId) : [];
    if (!list.length || !selectedPeer) return;
    closeMessageContextMenu();
    exitSelectionMode();
    setForwardDialog({ messages: list, sourcePeerId: selectedPeer.id });
  }, [selectedPeer, closeMessageContextMenu, exitSelectionMode]);

  const forwardableChats = useMemo(
    () =>
      mainChatList.filter(
        (chat) =>
          chat.id !== selectedPeer?.id
          && !chat.contact?.blocked
          && !chat.contact?.blockedByPeer
      ),
    [mainChatList, selectedPeer?.id]
  );

  const confirmForwardToPeer = async (targetPeerId) => {
    if (!forwardDialog?.messages?.length || !targetPeerId || forwardingMessages) return;
    setForwardingMessages(true);
    try {
      let sent = 0;
      for (const message of forwardDialog.messages) {
        const ok = await sendMessage(targetPeerId, buildForwardPayload(message));
        if (ok) sent += 1;
      }
      setForwardDialog(null);
      if (sent === forwardDialog.messages.length) {
        toast({
          variant: 'success',
          title: sent === 1 ? 'Nachricht weitergeleitet' : `${sent} Nachrichten weitergeleitet`,
        });
      } else if (sent > 0) {
        toast({
          variant: 'warning',
          title: 'Teilweise weitergeleitet',
          message: `${sent} von ${forwardDialog.messages.length} Nachrichten gesendet.`,
        });
      } else {
        toast({ variant: 'error', title: 'Weiterleitung fehlgeschlagen' });
      }
    } finally {
      setForwardingMessages(false);
    }
  };

  return {
    forwardDialog,
    setForwardDialog,
    forwardingMessages,
    forwardableChats,
    openForwardDialog,
    confirmForwardToPeer,
  };
}
