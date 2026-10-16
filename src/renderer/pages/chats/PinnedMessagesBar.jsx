import React from 'react';
import { ChevronRight, Pin, X } from 'lucide-react';
import { CHAT_ICON_STROKE, getMessagePreviewText } from './messageHelpers.jsx';

/**
 * Leiste mit angehefteten Nachrichten; Klick springt zur Nachricht,
 * bei mehreren Einträgen lässt sich durchschalten.
 */
export function PinnedMessagesBar({
  pinned,
  activeIndex,
  onSelect,
  onCycle,
  onUnpin,
  debugMode,
}) {
  if (!pinned?.length) return null;
  const current = pinned[Math.max(0, Math.min(activeIndex, pinned.length - 1))] || pinned[0];
  const preview = getMessagePreviewText(current, debugMode);

  return (
    <div className="chat-pin-bar" role="status">
      <button
        type="button"
        className="chat-pin-bar-main"
        onClick={() => onSelect(current)}
        title="Zur Nachricht springen"
      >
        <Pin size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        <span className="chat-pin-bar-copy">
          <span className="chat-pin-bar-label">
            Angeheftet
            {pinned.length > 1 ? ` · ${activeIndex + 1}/${pinned.length}` : ''}
          </span>
          <span className="chat-pin-bar-preview">{preview}</span>
        </span>
      </button>
      {pinned.length > 1 ? (
        <button
          type="button"
          className="btn btn-ghost btn-icon btn-sm"
          onClick={onCycle}
          aria-label="Nächste angeheftete Nachricht"
          title="Nächste angeheftete Nachricht"
        >
          <ChevronRight size={15} strokeWidth={CHAT_ICON_STROKE} />
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={() => onUnpin(current)}
        aria-label="Anheften aufheben"
        title="Anheften aufheben"
      >
        <X size={14} strokeWidth={CHAT_ICON_STROKE} />
      </button>
    </div>
  );
}
