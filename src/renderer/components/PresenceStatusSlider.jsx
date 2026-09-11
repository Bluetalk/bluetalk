import React from 'react';
import { useApp } from '../App';
import {
  USER_PRESENCE_OPTIONS,
  presenceSettingsPatch,
  resolveUserPresenceStatus,
} from '../../shared/user-presence.js';

export default function PresenceStatusSlider({ compactLabels = false }) {
  const { settings, updateSettings } = useApp();
  const status = resolveUserPresenceStatus(settings);
  const index = Math.max(0, USER_PRESENCE_OPTIONS.findIndex((option) => option.id === status));
  const active = USER_PRESENCE_OPTIONS[index];

  return (
    <div className="presence-slider-block">
      <div
        className="presence-slider"
        role="radiogroup"
        aria-label="Status"
        style={{ '--presence-index': String(index) }}
      >
        <span className="presence-slider-thumb" aria-hidden />
        {USER_PRESENCE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={status === option.id}
            className={`presence-slider-opt${status === option.id ? ' is-active' : ''}`}
            onClick={() => updateSettings(presenceSettingsPatch(option.id))}
          >
            <span className={`presence-slider-dot is-${option.id}`} aria-hidden />
            <span>
              {compactLabels && option.id === 'dnd' ? 'Stören' : option.label}
            </span>
          </button>
        ))}
      </div>
      {active?.hint ? <p className="presence-slider-hint">{active.hint}</p> : null}
    </div>
  );
}
