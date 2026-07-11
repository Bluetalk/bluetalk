import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AI_CHAT_PEER_ID, isAiChatPeerId } from '../../../aiChatConstants';
import { normalizeAiAgent } from '../messageHelpers.jsx';

/**
 * Lädt und pflegt die KI-Agenten-Liste (Store `aiChat.agents`).
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useAiAgents(chatMeta) {
  const [aiAgents, setAiAgents] = useState([]);
  const [aiAgentsLoaded, setAiAgentsLoaded] = useState(false);

  const chatMetaRef = useRef(chatMeta);
  useEffect(() => {
    chatMetaRef.current = chatMeta;
  }, [chatMeta]);

  // chatMeta ändert sich bei jeder Nachricht in irgendeinem Chat. Für die
  // Agentenliste ist aber nur relevant, welche KI-Chat-Einträge existieren —
  // sonst würde jeder Tastendruck/jede Nachricht einen Store-Reload auslösen.
  const aiAgentMetaSignal = useMemo(() => {
    const ids = Object.keys(chatMeta || {}).filter((id) => isAiChatPeerId(id)).sort();
    const legacyHasMessages = (chatMeta?.[AI_CHAT_PEER_ID]?.count || 0) > 0;
    return `${legacyHasMessages ? '1' : '0'}:${ids.join('|')}`;
  }, [chatMeta]);

  useEffect(() => {
    if (!window.bluetalk?.store) {
      setAiAgentsLoaded(true);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const stored = await window.bluetalk.store.get('aiChat.agents', []);
      if (cancelled) return;
      const meta = chatMetaRef.current || {};
      const normalized = Array.isArray(stored)
        ? stored
            .filter((agent) => agent?.id && isAiChatPeerId(agent.id))
            .map(normalizeAiAgent)
        : [];

      if (normalized.length === 0 && meta[AI_CHAT_PEER_ID]?.count > 0) {
        const legacyAgent = {
          id: AI_CHAT_PEER_ID,
          name: 'KI-Assistent',
          createdAt: meta[AI_CHAT_PEER_ID]?.lastMessage?.timestamp || Date.now(),
        };
        await window.bluetalk.store.set('aiChat.agents', [legacyAgent]);
        if (!cancelled) {
          setAiAgents([legacyAgent]);
          setAiAgentsLoaded(true);
        }
        return;
      }

      // Identische Payloads nicht neu setzen — sonst invalidieren frische
      // Array-Referenzen unnötig das chatList-Memo.
      setAiAgents((prev) => (
        prev.length === normalized.length && JSON.stringify(prev) === JSON.stringify(normalized)
          ? prev
          : normalized
      ));
      setAiAgentsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [aiAgentMetaSignal]);

  const updateAiAgent = useCallback(async (agentId, patch) => {
    setAiAgents((prev) => {
      const next = prev.map((agent) => {
        if (agent.id !== agentId) return agent;
        return normalizeAiAgent({ ...agent, ...patch });
      });
      if (window.bluetalk?.store) {
        void window.bluetalk.store.set('aiChat.agents', next);
      }
      return next;
    });
  }, []);

  return { aiAgents, setAiAgents, aiAgentsLoaded, updateAiAgent };
}
