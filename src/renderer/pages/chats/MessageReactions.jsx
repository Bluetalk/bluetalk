import React from 'react';
import { reactionEntries } from '../../app/messageReactions';

/** Gesetzte Reaktionen unter der Blase. Neue Reaktionen nur über das Kontextmenü. */
export function MessageReactions({
  message,
  hidden,
  onReact,
}) {
  if (hidden || !message?.messageId || !onReact) return null;
  const entries = reactionEntries(message.reactions);
  if (!entries.length) return null;
  return (
    <div className="msg-react-chips">
      {entries.map(({ emoji, count, ids }) => {
        const mine = ids.includes('self');
        return (
          <button
            key={emoji}
            type="button"
            className={`msg-react-chip${mine ? ' is-mine' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              onReact(message, emoji);
            }}
            aria-label={`${emoji}, ${count}`}
            aria-pressed={mine}
          >
            <span aria-hidden>{emoji}</span>
            {count > 1 ? <span className="msg-react-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
