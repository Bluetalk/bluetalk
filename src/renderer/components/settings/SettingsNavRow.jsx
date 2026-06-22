import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

const ICON_STROKE = 1.75;

export default function SettingsNavRow({ to, icon: Icon, title, subtitle }) {
  return (
    <Link to={to} className="settings-nav-row">
      <span className="settings-nav-row-icon" aria-hidden>
        <Icon size={16} strokeWidth={ICON_STROKE} />
      </span>
      <span className="settings-nav-row-copy">
        <span className="settings-nav-row-title">{title}</span>
        {subtitle ? <span className="settings-nav-row-subtitle">{subtitle}</span> : null}
      </span>
      <ChevronRight size={16} strokeWidth={ICON_STROKE} className="settings-nav-row-chevron" aria-hidden />
    </Link>
  );
}
