import React from 'react';
import { ChevronDown } from 'lucide-react';
import { CHAT_ICON_STROKE } from './messageHelpers.jsx';

/**
 * „Nach unten“-Knopf mit Zähler neuer Nachrichten, sobald man hochgescrollt hat.
 */
export function JumpToLatestButton({ visible, count = 0, onClick }) {
  if (!visible) return null;
  const n = Number(count) || 0;
  const label = n <= 0
    ? 'Nach unten'
    : (n === 1 ? '1 neue Nachricht — nach unten' : `${n} neue Nachrichten — nach unten`);
  return (
    <button
      type="button"
      className="chat-jump-latest"
      onClick={onClick}
      aria-label={label}
    >
      <ChevronDown size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      {n > 0 ? <span>{n > 99 ? '99+' : n} neu</span> : <span>Nach unten</span>}
    </button>
  );
}
