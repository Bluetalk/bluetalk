import { useCallback } from 'react';
import {
  MUTE_1H_MS,
  MUTE_8H_MS,
  MUTE_24H_MS,
  downloadBase64AsFile,
  downloadJsonFile,
} from '../messageHelpers.jsx';

/**
 * Seiten-Aktionen der Chats-Seite: Speichern/Export, Kopieren,
 * Nachricht(en) löschen, Mitteilungs-Stummschaltung und Verbinden aus
 * geteiltem Kontakt. Logik 1:1 aus Chats.jsx — nur gebündelt.
 */
export function useChatActions({
  toast,
  deleteMessage,
  setContactNotificationMute,
  connectToAddress,
  setSelectedPeerId,
  closeListContextMenu,
  selectedPeer,
  selectedMessageIds,
  msgs,
  exitSelectionMode,
  openForwardDialog,
}) {
  const saveAttachmentToDisk = async (fileName, base64) => {
    if (!base64) return;
    const name = fileName || 'download';

    if (window.bluetalk?.file?.saveAs) {
      try {
        const res = await window.bluetalk.file.saveAs({
          defaultFilename: name,
          base64,
        });
        if (res?.ok) {
          toast({ variant: 'success', title: 'Datei gespeichert' });
          return;
        }
        if (res && !res.canceled && res.error) {
          toast({ variant: 'error', title: 'Speichern fehlgeschlagen', message: res.error });
          return;
        }
        if (res?.canceled) return;
      } catch (e) {
        const msg = e?.message || '';
        if (!/no handler registered|ERR_HANDLER_NOT_REGISTERED/i.test(msg)) {
          toast({ variant: 'error', title: 'Speichern fehlgeschlagen', message: msg });
          return;
        }
        /* Main-Prozess oft veraltet (Dev ohne vollständigen Neustart): Fallback-Download */
      }
    }

    try {
      downloadBase64AsFile(name, base64);
      toast({
        variant: 'success',
        title: 'Download gestartet',
        message: window.bluetalk?.file?.saveAs
          ? 'Vollständigen Electron-Neustart ausführen, damit „Speichern unter“ wieder den Systemdialog nutzt.'
          : undefined,
      });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Download fehlgeschlagen',
        message: e?.message || 'Unbekannter Fehler.',
      });
    }
  };

  const saveFileMessage = (message) => {
    if (!message?.fileData) return;
    saveAttachmentToDisk(message.fileName || 'download', message.fileData);
  };

  const handleDeleteMessage = async (peerId, messageId) => {
    if (!peerId || !messageId) return;
    const ok = await deleteMessage(peerId, messageId);
    if (ok) {
      toast({ variant: 'success', title: 'Nachricht gelöscht' });
    } else {
      toast({ variant: 'error', title: 'Nachricht konnte nicht gelöscht werden' });
    }
  };

  const deleteSelectedMessages = async () => {
    if (!selectedPeer || selectedMessageIds.size === 0) return;
    const ids = [...selectedMessageIds];
    let deleted = 0;
    for (const messageId of ids) {
      const ok = await deleteMessage(selectedPeer.id, messageId);
      if (ok) deleted += 1;
    }
    exitSelectionMode();
    if (deleted === ids.length) {
      toast({
        variant: 'success',
        title: deleted === 1 ? 'Nachricht gelöscht' : `${deleted} Nachrichten gelöscht`,
      });
    } else if (deleted > 0) {
      toast({
        variant: 'warning',
        title: 'Teilweise gelöscht',
        message: `${deleted} von ${ids.length} Nachrichten entfernt.`,
      });
    } else {
      toast({ variant: 'error', title: 'Löschen fehlgeschlagen' });
    }
  };

  const forwardSelectedMessages = () => {
    if (!selectedPeer || selectedMessageIds.size === 0) return;
    const selected = msgs.filter((m) => m.messageId && selectedMessageIds.has(m.messageId));
    openForwardDialog(selected);
  };

  const connectFromSharedContact = useCallback(async (address, peerId) => {
    if (!address?.trim()) return;
    try {
      const peerInfo = await connectToAddress(address.trim());
      if (peerId) setSelectedPeerId(peerId);
      else if (peerInfo?.id) setSelectedPeerId(peerInfo.id);
      toast({ variant: 'success', title: 'Verbunden' });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Verbindung fehlgeschlagen',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  }, [connectToAddress, setSelectedPeerId, toast]);

  const exportPeerChat = async (chat) => {
    if (!chat?.id || !window.bluetalk) return;
    try {
      const total = chat.messageCount || 0;
      const batch = await window.bluetalk.messages.getBatch(chat.id, {
        skip: 0,
        limit: Math.max(total, 1),
      });
      const safeName = (chat.displayName || chat.id).replace(/[^\w\-]+/g, '_').slice(0, 48);
      downloadJsonFile(`bluetalk-${safeName}-${Date.now()}.json`, {
        exportedAt: new Date().toISOString(),
        peerId: chat.id,
        displayName: chat.displayName,
        messages: batch.messages || [],
        messageCount: batch.total || 0,
      });
      toast({ variant: 'success', title: 'Chat exportiert', message: 'Der Verlauf wurde als JSON gespeichert.' });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Export fehlgeschlagen',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  };

  const copyPeerIdFromMenu = async (peerId) => {
    try {
      await navigator.clipboard.writeText(peerId);
      toast({ variant: 'success', title: 'Peer-ID kopiert' });
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen' });
    }
    closeListContextMenu();
  };

  const copyToClipboard = async (text, successTitle) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ variant: 'success', title: successTitle });
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen' });
    }
  };

  const applyNotificationMute = useCallback(
    (contactId, mode) => {
      if (!contactId) return;
      if (mode === 'off') {
        setContactNotificationMute(contactId, { clear: true });
        toast({
          variant: 'success',
          title: 'Mitteilungen ein',
          message: 'Neue Nachrichten erscheinen wieder in Windows-Mitteilungen.',
        });
        return;
      }
      if (mode === 'manual') {
        setContactNotificationMute(contactId, { manual: true });
        toast({
          variant: 'success',
          title: 'Stumm bis Aufheben',
          message: 'Mitteilungen bleiben aus, bis du „Mitteilungen ein“ wählst.',
        });
        return;
      }
      const ms = mode === '1h' ? MUTE_1H_MS : mode === '8h' ? MUTE_8H_MS : MUTE_24H_MS;
      setContactNotificationMute(contactId, { until: Date.now() + ms });
      toast({
        variant: 'success',
        title: mode === '1h' ? 'Stumm (1 Std.)' : mode === '8h' ? 'Stumm (8 Std.)' : 'Stumm (24 Std.)',
        message: 'Nur Windows-Mitteilungen sind betroffen; Chat und Nachrichten bleiben normal.',
      });
    },
    [setContactNotificationMute, toast]
  );

  return {
    saveAttachmentToDisk,
    saveFileMessage,
    handleDeleteMessage,
    deleteSelectedMessages,
    forwardSelectedMessages,
    connectFromSharedContact,
    exportPeerChat,
    copyPeerIdFromMenu,
    copyToClipboard,
    applyNotificationMute,
  };
}
