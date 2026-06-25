/**
 * In-app release notes: shown once per installed app version (see App.jsx).
 * When you ship a new version, add a matching key here (same as package.json version).
 */
const RELEASE_NOTES = {
  '1.1.15': {
    title: "What's new in BlueTalk 1.1.15",
    items: [
      'Neuer lokaler KI-Chat mit Ollama-Setup, Modellverwaltung, Cloud-Auswahl und optionalem Agent-Modus mit Werkzeugen.',
      'Agenten behalten Modus, Arbeitsverzeichnis und Thinking-Einstellungen beim Bearbeiten zuverlaessig bei.',
      'Agent-Dateiwerkzeuge, Web-Fetch und Tool-Schleifen wurden gegen Ausbrueche, lokale/private URLs und Endloslaeufe gehaertet.',
      'UNO, Poker und Theme Studio erhalten weitere Bedien- und Stabilitaetsverbesserungen.',
    ],
  },
  '1.1.14': {
    title: "What's new in BlueTalk 1.1.14",
    items: [
      'Alle verbleibenden Feature-Flags sind fest eingebaut: Ungelesen-Badges in der Chat-Liste, größenverstellbare Seitenleiste und Chat-Liste, Kontakt-Stummschaltung für Mitteilungen und der Settings-Hub.',
      'Das Feature-Flags-Panel in den Einstellungen entfällt; die Legacy-Einstellungsseite wurde entfernt.',
    ],
  },
  '1.1.13': {
    title: "What's new in BlueTalk 1.1.13",
    items: [
      'Hotfix: Sticker lassen sich wieder ohne Laufzeitfehler senden.',
    ],
  },
  '1.1.12': {
    title: "What's new in BlueTalk 1.1.12",
    items: [
      'Sticker-Packs, Favoriten und zuletzt verwendete Sticker inklusive strenger Bildvalidierung und Speichergrenzen.',
      'Neue Medienbibliothek, strukturierter Settings-Hub und überarbeitetes Poker-Fenster.',
      'Verbindungen wählen Endpunkte schneller, erkennen Ausfälle zuverlässig und verbinden Kontakte selbstständig mit Backoff erneut.',
      'REST-API, Electron-Fenster, Plugin-Installation, Dateitransfer und lokale Speicherung wurden umfassend abgesichert.',
      'Deutlich kleinerer Start-Bundle sowie aktualisierte Electron-, Vite- und Build-Abhängigkeiten.',
    ],
  },
  '1.1.11': {
    title: "What's new in BlueTalk 1.1.11",
    items: [
      'Geblockte Kontakte werden in Chat-Liste, Header und Profil ausgegraut dargestellt.',
      'Offline-Weichzeichner und Auto-Reconnect sind fest eingebaut (kein Feature-Flag mehr).',
      'Auto-Updates und Releases laufen über das Repository Bluetalk/bluetalk.',
    ],
  },
  '1.1.10': {
    title: "What's new in BlueTalk 1.1.10",
    items: [
      'Fixed reference error in peer connection cleanup where pendingPromise was used before initialization.',
      'Fixed non-existent autoUpdater properties (quitAndInstallCalled, installDirectory) that could cause errors.',
      'Fixed stale message cache after deleting messages or chats.',
      'Fixed API server stop callback to match Node.js server.close signature.',
      'Fixed import.meta.env access in ErrorBoundary for compatibility.',
      'Added validation for invalid base64 file data in hostFile.',
    ],
  },
  '1.1.7': {
    title: "What's new in BlueTalk 1.1.7",
    items: [
      'Poker-Plugin (Texas Hold’em): Tisch hosten, Einladungen per Chat, Spiel im eigenen Fenster; im Debug-Modus kann der Host einen Test-Bot hinzufügen.',
      'Korrektur: Eigene Peer-ID wird asynchron geladen — Host-Erkennung und Debug-Bot funktionieren zuverlässig.',
    ],
  },
  '1.1.6': {
    title: "What's new in BlueTalk 1.1.6",
    items: [
      'Mehrere bisherige Feature-Flags sind jetzt fest eingebaut: flüssiger Versand (startTransition), schnelleres Datei-Einlesen (Data-URL), ausgehende Dateien erst nach erfolgreichem Senden auf die Platte, Ende-zu-Ende-Verschlüsselung pro Kontakt ohne globalen Master-Schalter, und deckende Toasts unten rechts.',
      'E2EE-Menü und Hinweise erscheinen immer; der globale „E2EE aus (Feature-Flag)“-Zustand entfällt.',
    ],
  },
  '1.1.5': {
    title: "What's new in BlueTalk 1.1.5",
    items: [
      'Maintenance release with bug fixes and improvements.',
    ],
  },
  '1.1.4': {
    title: "What's new in BlueTalk 1.1.4",
    items: [
      'Plugin system: install plugins to add sidebar tabs, modal screens and react to realtime peer events.',
      'Plugins have access to peers, contacts, messages, E2EE-aware chat sends, notifications and per-plugin storage.',
      'New Plugins page in the sidebar to enable, disable, uninstall and rescan plugins. First launch seeds a "Hello" example plugin.',
      'Plugin APIs: events.on() for peer:connected/disconnected/message/file-offered/file-received/discovered, plus ui.registerTab, ui.registerScreen and registerCommand.',
    ],
  },
  '1.1.3': {
    title: "What's new in BlueTalk 1.1.3",
    items: [
      'Settings: Feature flags panel for optional performance and UI tweaks (smoother sends, faster large file reads, deferred attachment saves, unread list badges, solid corner toasts, resizable nav and chat list).',
      'Global toggle for outgoing end-to-end encryption in feature flags; per-chat lock control still applies when encryption is enabled.',
    ],
  },
  '1.1.2': {
    title: "What's new in BlueTalk 1.1.2",
    items: [
      'Larger chat attachments (up to 15 GB per file) with a higher transport limit for big sends.',
      'Block and unblock contacts from the chat header or list context menu; blocked peers cannot message you.',
      'End-to-end encryption for chat and file payloads between peers (AES-256-GCM over ECDH P-256).',
    ],
  },
  '1.1.0': {
    title: "What's new in BlueTalk 1.1.0",
    items: [
      'Settings: clear renderer cache to fix stuck UI or file dialogs.',
      'Settings: delete all local data or clear chat history with confirmation.',
      'Faster outgoing messages with optimistic send and clearer delivery states.',
      'Contacts reconnect automatically on startup.',
    ],
  },
};

export function getReleaseNotesForVersion(version) {
  if (!version || typeof version !== 'string') return null;
  const entry = RELEASE_NOTES[version];
  if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) return null;
  return { version, title: entry.title || `What's new in BlueTalk ${version}`, items: entry.items };
}
