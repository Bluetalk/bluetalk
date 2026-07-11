/**
 * Live Dokumente — Plugin-Controller (Hauptfenster), Entry-Modul.
 *
 * Läuft headless im Hauptfenster: Realtime-Raum + SharedDocument leben hier,
 * damit die Sitzung weiterläuft, auch wenn das Editor-Fenster geschlossen wird.
 * Die Darstellung übernimmt das separate Editor-Fenster
 * (src/renderer/pages/DocsEditorPage.jsx), verbunden über window.bluetalk.docs
 * (pushState / onFromChild) — gleiches Muster wie die Spielfenster.
 *
 * Aufgeteilt auf Module:
 *   - bridge.js   window.bluetalk.docs-Transport + Kontakt-/Teilnehmer-Helfer
 *   - recents.js  „Zuletzt bearbeitet"-Speicher
 *   - sync.js     Sitzungs- und Realtime-Controller
 */
import { createDocsBridge } from './bridge.js';
import { createRecentsStore } from './recents.js';
import { createDocsSession } from './sync.js';

export default function activateLiveDocsPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  const bridge = createDocsBridge();
  const recents = createRecentsStore({ api });
  const session = createDocsSession({ api, bridge, recents });

  // Editor-Fenster (Kind) → Controller.
  const offChild = bridge.onFromChild((payload) => session.handleChildAction(payload));

  // ---------- Launcher & Einladungen ----------

  api.ui.registerCommand('launcherState', () => session.launcherState());
  api.ui.registerCommand('launchNew', () => session.launchNew());
  api.ui.registerCommand('openWindow', () => session.openWindow());
  // Einer Sitzung über eine Chat-Einladung beitreten (roomId + hostPeerId aus der
  // Einladungs-Nachricht). Öffnet danach den Editor.
  api.ui.registerCommand('joinInvite', (args) => session.joinInvite(args));
  // „Zuletzt bearbeitet" für die Dokumente-Seite.
  api.ui.registerCommand('listRecent', () => session.listRecent());
  api.ui.registerCommand('openRecent', (args) => session.openRecent(args));
  api.ui.registerCommand('forgetRecent', (args) => session.forgetRecent(args));

  api.realtime.on('room-invite', (invite) => session.handleRoomInvite(invite));

  api.onDeactivate(() => {
    offChild?.();
    session.leaveSession();
  });

  void session.refreshSelf().then(() => session.pushToChild());
  api.log.info('Live-Dokumente-Plugin geladen');
}
