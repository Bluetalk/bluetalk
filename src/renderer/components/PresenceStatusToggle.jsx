import React from 'react';
import { Bell, BellOff } from 'lucide-react';
import { useApp } from '../App';

export default function PresenceStatusToggle() {
  const { settings, updateSettings } = useApp();
  const active = settings.doNotDisturb === true;

  return (
    <button
      type="button"
      className={`presence-toggle${active ? ' presence-toggle--dnd' : ''}`}
      onClick={() => updateSettings({ doNotDisturb: !active })}
      title={
        active
          ? 'Nicht stören aktiv — keine Benachrichtigungen. Klicken zum Deaktivieren.'
          : 'Nicht stören aktivieren — unterdrückt Benachrichtigungen für dich.'
      }
      aria-pressed={active}
      aria-label={active ? 'Nicht stören aktiv' : 'Verfügbar'}
    >
      {active ? (
        <BellOff size={18} strokeWidth={2} aria-hidden />
      ) : (
        <Bell size={18} strokeWidth={2} aria-hidden />
      )}
      <span className="presence-toggle-label">
        {active ? 'Nicht stören' : 'Verfügbar'}
      </span>
    </button>
  );
}
