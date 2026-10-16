import React from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { CHAT_ICON_STROKE } from './messageHelpers.jsx';

/**
 * In-Chat-Suche (Strg+F): Trefferanzahl und Vor/Zurück.
 */
export function ChatSearchBar({
  query,
  onQueryChange,
  hitCount,
  activeIndex,
  onPrev,
  onNext,
  onClose,
  inputRef,
}) {
  const label = hitCount === 0
    ? 'Keine Treffer'
    : `${Math.min(activeIndex + 1, hitCount)} / ${hitCount}`;

  return (
    <div className="chat-search-bar" role="search">
      <Search size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      <input
        ref={inputRef}
        className="input chat-search-bar-input"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Im Chat suchen…"
        aria-label="Im Chat suchen"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && event.shiftKey) {
            event.preventDefault();
            onPrev();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            onNext();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="chat-search-bar-count" aria-live="polite">{query.trim() ? label : ''}</span>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={onPrev}
        disabled={hitCount === 0}
        aria-label="Vorheriger Treffer"
        title="Vorheriger Treffer"
      >
        <ChevronUp size={15} strokeWidth={CHAT_ICON_STROKE} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={onNext}
        disabled={hitCount === 0}
        aria-label="Nächster Treffer"
        title="Nächster Treffer"
      >
        <ChevronDown size={15} strokeWidth={CHAT_ICON_STROKE} />
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={onClose}
        aria-label="Suche schließen"
        title="Suche schließen"
      >
        <X size={15} strokeWidth={CHAT_ICON_STROKE} />
      </button>
    </div>
  );
}
