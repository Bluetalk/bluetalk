import React, { useEffect, useState } from 'react';
import { Bell, Bug, Moon, Power, Sun } from 'lucide-react';
import { useApp } from '../../App';
import SettingsPage from '../../components/settings/SettingsPage';
import PresenceStatusSlider from '../../components/PresenceStatusSlider';
import { SETTINGS_ICON_STROKE } from './settingsUtils';
import UpdatesPanel from './UpdatesPanel';

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
    <SettingsPage title="App">
      <section className="settings-section">
        <h3 className="settings-section-title">Chat</h3>
        <div className="card">
          <div className="toggle-row toggle-row--stack">
            <div className="toggle-row-info">
              <span>Status</span>
              <span>Sichtbar für Kontakte. Nicht stören und Offline unterdrücken Mitteilungen.</span>
            </div>
            <PresenceStatusSlider />
          </div>

          <div className="toggle-row">
            <div className="toggle-row-info">
              <span className="toggle-row-label-with-icon">
                <Bell size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Windows-Benachrichtigungen
              </span>
              <span>Nur wenn BlueTalk im Hintergrund ist. Mehrere Nachrichten werden zusammengefasst.</span>
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
              <span>Lesebestätigungen</span>
              <span>Andere sehen, dass du ihre Nachrichten gelesen hast.</span>
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
              <span>Prüft, ob Windows Mitteilungen anzeigen darf.</span>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => window.bluetalk?.notify?.show?.({
                title: 'BlueTalk',
                body: 'Windows-Benachrichtigungen sind aktiv.',
                allowInForeground: true,
              })}
            >
              Test
            </button>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">Darstellung</h3>
        <div className="card">
          <div className="toggle-row">
            <div className="toggle-row-info">
              <span>Erscheinungsbild</span>
              <span>Hell oder dunkel für die ganze App</span>
            </div>
            <div className="theme-switch" role="group" aria-label="Erscheinungsbild">
              <button
                type="button"
                className={`theme-switch-btn${theme === 'light' ? ' is-active' : ''}`}
                onClick={() => { if (theme !== 'light') toggleTheme(); }}
                aria-pressed={theme === 'light'}
              >
                <Sun size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Hell
              </button>
              <button
                type="button"
                className={`theme-switch-btn${theme === 'dark' ? ' is-active' : ''}`}
                onClick={() => { if (theme !== 'dark') toggleTheme(); }}
                aria-pressed={theme === 'dark'}
              >
                <Moon size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Dunkel
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3 className="settings-section-title">System</h3>
        <div className="card">
          <div className="toggle-row">
            <div className="toggle-row-info">
              <span>In den Infobereich minimieren</span>
              <span>Läuft beim Schließen im Hintergrund weiter</span>
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
                Beim Anmelden starten
              </span>
              <span>BlueTalk öffnen, wenn du dich anmeldest</span>
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
                Debug-Modus
              </span>
              <span>Zusätzliche Netzwerk- und Diagnose-Optionen</span>
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

      <UpdatesPanel />
    </SettingsPage>
  );
}
