import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_DRAFTS_STORE_KEY,
  getDraftText,
  normalizeDraftMap,
  setDraftInMap,
} from '../../../../shared/chat-features.js';

/**
 * Persistente Entwürfe pro Chat (Store `chatDrafts`).
 * Gerätelokal: `chatDrafts` steht bewusst nicht in SYNCED_STORE_KEYS.
 */
export function useChatDrafts(selectedPeerId) {
  const [drafts, setDrafts] = useState({});
  const draftsRef = useRef(drafts);
  const persistTimerRef = useRef(0);
  draftsRef.current = drafts;

  useEffect(() => {
    if (!window.bluetalk?.store) return undefined;
    let cancelled = false;
    window.bluetalk.store.get(CHAT_DRAFTS_STORE_KEY, {}).then((stored) => {
      if (cancelled) return;
      setDrafts(normalizeDraftMap(stored));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback((next) => {
    if (!window.bluetalk?.store) return;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      void window.bluetalk.store.set(CHAT_DRAFTS_STORE_KEY, next);
    }, 160);
  }, []);

  useEffect(() => () => window.clearTimeout(persistTimerRef.current), []);

  const saveDraft = useCallback((peerId, text) => {
    if (!peerId) return;
    setDrafts((prev) => {
      const next = setDraftInMap(prev, peerId, text);
      persist(next);
      return next;
    });
  }, [persist]);

  const clearDraft = useCallback((peerId) => {
    saveDraft(peerId, '');
  }, [saveDraft]);

  const selectedDraft = selectedPeerId ? getDraftText(drafts, selectedPeerId) : '';

  return { drafts, selectedDraft, saveDraft, clearDraft, getDraftText };
}
