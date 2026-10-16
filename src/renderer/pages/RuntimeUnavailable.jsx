import React from 'react';
import { PlugZap } from 'lucide-react';

export default function RuntimeUnavailablePage() {
  return (
    <div className="error-page">
      <div className="error-page-card animate-scale">
        <div className="error-page-icon" aria-hidden>
          <PlugZap size={28} strokeWidth={1.75} />
        </div>
        <h1 className="error-page-title">BlueTalk ist hier nicht verfügbar</h1>
        <p className="error-page-lead text-muted">
          Diese Ansicht läuft nur in der BlueTalk-Desktop-App. Öffne die installierte App oder starte die Tauri-Dev-Sitzung,
          damit die sichere Verbindung zu Nachrichten und Speicher aktiv ist.
        </p>
      </div>
    </div>
  );
}
