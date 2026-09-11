import React from 'react';

/**
 * Rückfrage des Bots als eigene Karte über der Chatzeile (ask_user).
 * Optionen sind klickbar; Freitext läuft über den Composer darunter.
 */
export function BotActionBar({ askUser, onReply }) {
  if (!askUser?.requestId) return null;

  const options = Array.isArray(askUser.options)
    ? askUser.options.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  return (
    <div className="bot-action-bar" role="region" aria-label="Aktion nötig">
      <div className="bot-action-bar-head">
        <span className="bot-action-bar-label">Aktion nötig</span>
        <button type="button" className="bot-action-bar-skip" onClick={() => onReply?.('')}>
          Überspringen
        </button>
      </div>
      <p className="bot-action-bar-question">{askUser.question || 'Der Bot hat eine Rückfrage.'}</p>
      {options.length ? (
        <div className="bot-action-bar-options">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className="bot-action-chip"
              onClick={() => onReply?.(option)}
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
