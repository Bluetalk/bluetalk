import { useCallback, useEffect, useState } from 'react';

/**
 * Mehrfachauswahl von Nachrichten (Auswahlmodus) inkl. Escape-Handler und
 * Reset beim Chat-Wechsel.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert. Das Schließen des
 * Chat-Aktionen-Menüs beim Start übernimmt jetzt der ChatHeader lokal.
 */
export function useMessageSelection({ selectedPeerId, closeMessageContextMenu }) {
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState(() => new Set());

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const startSelectionMode = useCallback(() => {
    closeMessageContextMenu();
    setSelectionMode(true);
    setSelectedMessageIds(new Set());
  }, [closeMessageContextMenu]);

  const toggleSelectedMessage = useCallback((messageId) => {
    if (!messageId) return;
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!selectionMode) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') exitSelectionMode();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectionMode, exitSelectionMode]);

  // Beim Chat-Wechsel Auswahlmodus beenden (Teil des früheren Sammel-Reset-Effekts).
  useEffect(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, [selectedPeerId]);

  return {
    selectionMode,
    selectedMessageIds,
    selectedCount: selectedMessageIds.size,
    exitSelectionMode,
    startSelectionMode,
    toggleSelectedMessage,
  };
}
