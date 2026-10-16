import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { CHAT_ICON_STROKE } from './messageHelpers.jsx';

/** Zurück zur Chatliste im Ein-Spalten-Layout. */
export function ChatBackButton({ onBack, label = 'Zurück zur Chatliste' }) {
  if (!onBack) return null;
  return (
    <button
      type="button"
      className="chat-header-back"
      onClick={onBack}
      aria-label={label}
      title={label}
    >
      <ChevronLeft size={22} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
    </button>
  );
}
