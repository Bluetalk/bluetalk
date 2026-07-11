import React, { useEffect, useState } from 'react';
import { Bell, BellOff, Bug, Moon, Power, Server, Sun } from 'lucide-react';
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
        title="Anwendung"
        subtitle="Benachrichtigungen, Design, Autostart und Debug"
        icon={Server}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <BellOff size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Nicht stören (Presence)
                </span>
                <span>
                  Unterdrückt Windows-Benachrichtigungen für dich und zeigt Kontakten „Nicht stören“.
                  Du kannst den Status auch unten links in der Seitenleiste umschalten.
                </span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.doNotDisturb ?? false}
                  onChange={(e) => change('doNotDisturb', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

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
                  body: 'Windows-Benachrichtigungen sind aktiv.',
                  allowInForeground: true,
                })}
              >
                Test
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Design</span>
                <span>Zwischen hellem und dunklem Modus wechseln</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={toggleTheme}>
                {theme === 'dark' ? <Sun size={15} strokeWidth={SETTINGS_ICON_STROKE} /> : <Moon size={15} strokeWidth={SETTINGS_ICON_STROKE} />}
                {theme === 'dark' ? 'Hell' : 'Dunkel'}
              </button>
            </div>

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
                <span>BlueTalk automatisch öffnen, wenn du dich an diesem Computer anmeldest</span>
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
                <span>Zeigt den Netzwerk-Bereich (Adressen, API-Port, Porttests, Diagnose, Konfigurationsauszug)</span>
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
