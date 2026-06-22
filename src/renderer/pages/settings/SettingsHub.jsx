import React from 'react';
import { Settings2 } from 'lucide-react';
import SettingsNavRow from '../../components/settings/SettingsNavRow';
import { SETTINGS_HUB_NAV } from './settingsHubNav';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

export default function SettingsHub() {
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title-row">
          <span className="page-title-icon" aria-hidden>
            <Settings2 size={18} strokeWidth={SETTINGS_ICON_STROKE} />
          </span>
          Settings
        </h1>
        <p>Configure your BlueTalk instance</p>
      </div>

      <div className="page-body">
        <section className="settings-section">
          <div className="settings-nav-list">
            {SETTINGS_HUB_NAV.map((item) => (
              <div key={item.to} className="card settings-nav-card">
                <SettingsNavRow
                  to={item.to}
                  icon={item.icon}
                  title={item.title}
                  subtitle={item.subtitle}
                />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
