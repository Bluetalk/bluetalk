import { useCallback, useEffect, useMemo, useState } from 'react';
import { collectSubagentsByPeer } from '../messageHelpers.jsx';

/**
 * Sub-Agenten je KI-Chat: Sammlung, Expand-Zustand in der Liste und die
 * Auswahl eines Sub-Agenten-Chats.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useSubagents({ messages, aiChatProgress, selectedPeerId, setSelectedPeerId }) {
  const [expandedAgentSubs, setExpandedAgentSubs] = useState(() => new Set());
  const [selectedSubagent, setSelectedSubagent] = useState(null);

  const subagentsByPeer = useMemo(
    () => collectSubagentsByPeer(messages, aiChatProgress),
    [messages, aiChatProgress]
  );

  const selectedSubagentSegment = useMemo(() => {
    if (!selectedSubagent) return null;
    const subs = subagentsByPeer[selectedSubagent.parentPeerId] || [];
    return subs.find((entry) => entry.id === selectedSubagent.subagentId) || null;
  }, [selectedSubagent, subagentsByPeer]);

  const openSubagentChat = useCallback((parentPeerId, subagentId) => {
    if (!parentPeerId || !subagentId) return;
    setExpandedAgentSubs((prev) => {
      const next = new Set(prev);
      next.add(parentPeerId);
      return next;
    });
    setSelectedPeerId(parentPeerId);
    setSelectedSubagent({ parentPeerId, subagentId });
  }, [setSelectedPeerId]);

  // Stabile Referenz für ChatMessage (React.memo) — eine Inline-Closure würde
  // das Memo bei jedem Render der Nachrichtenliste aushebeln.
  const openSubagentForSelectedChat = useCallback(
    (segment) => openSubagentChat(selectedPeerId, segment?.id),
    [openSubagentChat, selectedPeerId]
  );

  const closeSubagentChat = useCallback(() => {
    setSelectedSubagent(null);
  }, []);

  useEffect(() => {
    if (!selectedSubagent) return;
    if (!selectedSubagentSegment) setSelectedSubagent(null);
  }, [selectedSubagent, selectedSubagentSegment]);

  useEffect(() => {
    setExpandedAgentSubs((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const [peerId, subs] of Object.entries(subagentsByPeer)) {
        if (subs.some((seg) => seg.status === 'running') && !next.has(peerId)) {
          next.add(peerId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [subagentsByPeer]);

  const toggleAgentSubsExpanded = useCallback((peerId, event) => {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    setExpandedAgentSubs((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  }, []);

  // Beim Chat-Wechsel die Sub-Agent-Auswahl verwerfen, sofern sie nicht zum
  // neu gewählten Chat gehört (Teil des früheren Sammel-Reset-Effekts).
  useEffect(() => {
    setSelectedSubagent((prev) => {
      if (!prev) return null;
      if (prev.parentPeerId === selectedPeerId) return prev;
      return null;
    });
  }, [selectedPeerId]);

  return {
    subagentsByPeer,
    expandedAgentSubs,
    selectedSubagent,
    setSelectedSubagent,
    selectedSubagentSegment,
    openSubagentChat,
    openSubagentForSelectedChat,
    closeSubagentChat,
    toggleAgentSubsExpanded,
  };
}
