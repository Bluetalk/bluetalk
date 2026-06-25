import React, { useEffect, useState } from 'react';
import { Bell, Bug, Moon, Power, Server, Sun } from 'lucide-react';
import { useApp } from '../../App';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

export default function ApplicationSettingsPage() {
  const { settings, updateSettings, theme, toggleTheme } = useApp();
  const [local, setLocal] = useState(settings);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  const change = (key, value) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
    updateSettings({ [key]: value });
  };

  return (
    <div className="page">
      <SettingsBackHeader
        title="Application"
        subtitle="Notifications, theme, startup, and debug"
        icon={Server}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Bell size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Windows-Benachrichtigungen
                </span>
                <span>System-Mitteilungen für eingehende Nachrichten. Keine Benachrichtigung, solange BlueTalk im Vordergrund ist. Mehrere in kurzer Zeit werden zu einer Zusammenfassung gruppiert.</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.windowsNotifications ?? true}
                  onChange={(e) => change('windowsNotifications', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Lesebestätigungen senden</span>
                <span>Wenn aus, sehen andere nicht, dass du ihre Nachrichten gelesen hast („Seen“).</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.sendReadReceipts ?? true}
                  onChange={(e) => change('sendReadReceipts', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Testbenachrichtigung</span>
                <span>Prüft, ob Windows eine Mitteilung anzeigen darf (nur wenn Benachrichtigungen oben aktiv sind).</span>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => window.bluetalk?.notify?.show?.({
                  title: 'BlueTalk',
                  body: 'Windows notifications are active.',
                  allowInForeground: true,
                })}
              >
                Test
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Theme</span>
                <span>Switch between light and dark mode</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={toggleTheme}>
                {theme === 'dark' ? <Sun size={15} strokeWidth={SETTINGS_ICON_STROKE} /> : <Moon size={15} strokeWidth={SETTINGS_ICON_STROKE} />}
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Minimize to Tray</span>
                <span>Keep running in the background when closed</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.minimizeToTray ?? true}
                  onChange={(e) => change('minimizeToTray', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Power size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Launch at startup
                </span>
                <span>Open BlueTalk automatically when you sign in to this computer</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.launchAtLogin ?? false}
                  onChange={(e) => change('launchAtLogin', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Bug size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Debug mode
                </span>
                <span>Show the Network section (addresses, API port, port tests, doctor, config tail)</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.debugMode ?? false}
                  onChange={(e) => change('debugMode', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
