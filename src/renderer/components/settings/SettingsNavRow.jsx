import React from 'react';
import { NavLink } from 'react-router-dom';

const ICON_STROKE = 1.75;

export default function SettingsNavRow({ to, icon: Icon, title }) {
  return (
    <NavLink
      to={to}
      end
      viewTransition
      className={({ isActive }) => `settings-nav-row${isActive ? ' is-active' : ''}`}
    >
      <span className="settings-nav-row-icon" aria-hidden>
        <Icon size={16} strokeWidth={ICON_STROKE} />
      </span>
      <span className="settings-nav-row-title">{title}</span>
    </NavLink>
  );
}
