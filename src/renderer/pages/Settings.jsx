import React from 'react';
import { Outlet } from 'react-router-dom';
import SettingsNavRow from '../components/settings/SettingsNavRow';
import { SETTINGS_NAV } from './settings/settingsHubNav';

export default function SettingsLayout() {
  return (
    <div className="page page-inset page-settings">
      <div className="settings-split">
        <nav className="page-shell settings-side" aria-label="Einstellungen">
          <div className="settings-side-title">Einstellungen</div>
          {SETTINGS_NAV.map((item) => (
            <SettingsNavRow
              key={item.to}
              to={item.to}
              icon={item.icon}
              title={item.title}
            />
          ))}
        </nav>
        <div className="page-shell settings-main">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
