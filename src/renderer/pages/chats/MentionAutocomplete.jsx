import React from 'react';

/**
 * Autocomplete für @Erwähnungen in Gruppen.
 */
export function MentionAutocomplete({ items, activeIndex, onSelect }) {
  if (!items?.length) return null;
  return (
    <ul className="chat-mention-menu" role="listbox" aria-label="Mitglieder erwähnen">
      {items.map((member, index) => (
        <li key={member.peerId}>
          <button
            type="button"
            className={`chat-mention-menu-item${index === activeIndex ? ' is-active' : ''}`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(member);
            }}
          >
            <span className="chat-mention-menu-name">{member.displayName || member.name || member.peerId}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
