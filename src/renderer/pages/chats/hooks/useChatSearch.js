import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findSearchHits, stepSearchHit } from '../../../../shared/chat-features.js';

/**
 * In-Chat-Suche inkl. Nachladen älterer Nachrichten, bis Treffer da sind.
 */
export function useChatSearch({
  selectedPeerId,
  msgs,
  hasMoreMessages,
  loadOlderMessages,
  loadingMore,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [loadingOlderForSearch, setLoadingOlderForSearch] = useState(false);
  const inputRef = useRef(null);
  const loadAttemptRef = useRef(0);

  useEffect(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, [selectedPeerId]);

  useEffect(() => {
    if (!selectedPeerId) return undefined;
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
        && (event.key === 'f' || event.key === 'F')) {
        event.preventDefault();
        setOpen(true);
        window.setTimeout(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        }, 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedPeerId]);

  const hits = useMemo(() => findSearchHits(msgs, query), [msgs, query]);

  useEffect(() => {
    setActiveIndex((prev) => (hits.length === 0 ? 0 : Math.min(prev, hits.length - 1)));
  }, [hits.length]);

  useEffect(() => {
    if (!open || !query.trim() || hits.length > 0 || !hasMoreMessages || loadingMore) return undefined;
    let cancelled = false;
    const attempt = loadAttemptRef.current + 1;
    loadAttemptRef.current = attempt;
    setLoadingOlderForSearch(true);
    void Promise.resolve(loadOlderMessages()).finally(() => {
      if (!cancelled && loadAttemptRef.current === attempt) setLoadingOlderForSearch(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, query, hits.length, hasMoreMessages, loadingMore, loadOlderMessages]);

  const openSearch = useCallback(() => {
    setOpen(true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const closeSearch = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  const go = useCallback((direction) => {
    setActiveIndex((prev) => stepSearchHit(hits, prev, direction));
  }, [hits]);

  const activeHit = hits[activeIndex] || null;

  return {
    open,
    query,
    setQuery,
    hits,
    activeIndex,
    activeHit,
    openSearch,
    closeSearch,
    goPrev: () => go(-1),
    goNext: () => go(1),
    inputRef,
    loadingOlderForSearch,
  };
}
