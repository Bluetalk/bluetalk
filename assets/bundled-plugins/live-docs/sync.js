/**
 * Live Dokumente — Sitzungs- und Realtime-Controller.
 *
 * Hält den Realtime-Raum + das host-autoritative SharedDocument und die
 * gesamte Sitzungslogik (Hosten, Beitreten, Text-Ops, Einladungen). Läuft
 * headless im Hauptfenster; die Darstellung übernimmt das Editor-Fenster
 * über die Brücke (bridge.js). Kein DOM.
 */
import { contactName as resolveContactName, listContacts, listParticipants } from './bridge.js';

const MAX_PEERS = 8;
const MAX_DOC_CHARS = 400000;
const DOC_ID = 'main';
const RECENT_DEBOUNCE_MS = 4000;

const newDocId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const cleanName = (value, fallback) => String(value || fallback || '').slice(0, 120) || 'Unbenanntes Dokument';

export function createDocsSession({ api, bridge, recents }) {
  let room = null;
  let doc = null;
  let fileName = 'Unbenanntes Dokument';
  let pendingInvite = null;
  let selfPeerId = '';
  let selfName = '';
  let offDocChange = null;
  let sessionDocId = '';
  let recentTimer = null;

  const contactName = (peerId) => resolveContactName(api, peerId);
  const me = async () => api.peer.info?.().catch(() => null);

  async function refreshSelf() {
    const info = await me();
    if (info?.id) {
      selfPeerId = info.id;
      selfName = info.name || '';
    }
    return selfPeerId;
  }

  // ---------- „Zuletzt bearbeitet" ----------

  function saveRecentEntry() {
    if (!doc || !sessionDocId) return;
    recents.save({
      id: sessionDocId,
      fileName,
      html: String(doc.getState() ?? ''),
    });
  }
  function scheduleRecent() {
    if (recentTimer) return;
    recentTimer = setTimeout(() => { recentTimer = null; saveRecentEntry(); }, RECENT_DEBOUNCE_MS);
  }
  function flushRecent() {
    if (recentTimer) { clearTimeout(recentTimer); recentTimer = null; }
    saveRecentEntry();
  }

  // ---------- Brücke zum Editor-Fenster ----------

  function pushToChild() {
    if (!bridge.canPush()) return;
    bridge.pushState({
      hasRoom: Boolean(room),
      isHost: Boolean(room?.isHost),
      roomId: room?.roomId || '',
      selfPeerId: room?.selfPeerId || selfPeerId || '',
      fileName,
      doc: doc ? { state: String(doc.getState() ?? ''), revision: doc.getRevision() } : null,
      participants: listParticipants({ room, selfPeerId, selfName, resolveName: contactName }),
      contacts: listContacts(api),
      pendingInvite: pendingInvite
        ? { roomId: pendingInvite.roomId, hostPeerId: pendingInvite.hostPeerId, name: pendingInvite.name || 'Dokument', fromName: contactName(pendingInvite.hostPeerId) }
        : null,
      at: Date.now(),
    });
  }

  async function openEditorWindow() {
    await bridge.openWindow();
    pushToChild();
  }

  function wireDoc() {
    offDocChange?.();
    offDocChange = doc?.on('change', () => {
      pushToChild();
      scheduleRecent();
    }) || null;
  }

  // Einladung zusätzlich als Chat-Nachricht schicken (wie bei den Spielen), damit
  // sie im Gespräch sichtbar ist und mit einem Klick beigetreten werden kann.
  function sendChatInvite(peerId) {
    if (!room || !peerId) return;
    const name = fileName || 'Dokument';
    try {
      void api.chat?.send?.(peerId, {
        kind: 'live-docs-invite',
        roomId: room.roomId,
        hostPeerId: room.hostPeerId || selfPeerId,
        docId: sessionDocId,
        tableName: name,
        fileName: name,
        content: `📝 Einladung: „${name}“ gemeinsam bearbeiten`,
      });
    } catch {
      /* ignore */
    }
  }

  function wireRoom() {
    if (!room) return;
    room.on('message', ({ from, payload }) => {
      if (payload?.type === 'meta' && typeof payload.fileName === 'string') {
        fileName = cleanName(payload.fileName, fileName);
        pushToChild();
      } else if (payload?.type === 'cursor') {
        // Ephemerer Fremd-Cursor: direkt (ohne pushToChild) ans Editor-Fenster.
        bridge.pushPresence({
          peerId: from,
          name: typeof payload.name === 'string' ? payload.name.slice(0, 60) : '',
          caret: payload.caret || null,
        });
      }
    });
    room.on('peer-joined', ({ peerId, name }) => {
      api.notify.toast?.({ title: 'Live Dokumente', message: `${name || contactName(peerId)} arbeitet jetzt mit.` });
      pushToChild();
    });
    room.on('peer-left', ({ peerId }) => {
      bridge.pushPresence({ peerId, gone: true });
      pushToChild();
    });
    room.on('closed', () => {
      if (!room) return;
      api.notify.toast?.({ title: 'Live Dokumente', message: 'Die Sitzung wurde beendet.' });
      resetSession();
    });
  }

  function resetSession() {
    flushRecent();
    offDocChange?.();
    offDocChange = null;
    doc = null;
    room = null;
    sessionDocId = '';
    pushToChild();
  }

  async function hostSession(initialText = '', name, docId) {
    if (room) return false;
    await refreshSelf();
    if (room) return false;
    fileName = cleanName(name, fileName);
    room = api.realtime.createRoom({ name: `Dokument: ${fileName}`.slice(0, 64), access: 'invite', maxPeers: MAX_PEERS });
    if (!room) {
      api.notify.toast?.({ title: 'Live Dokumente', message: 'Sitzung konnte nicht gestartet werden.' });
      pushToChild();
      return false;
    }
    sessionDocId = docId || newDocId();
    wireRoom();
    doc = room.createDocument({ docId: DOC_ID, initial: String(initialText || '').slice(0, MAX_DOC_CHARS) });
    wireDoc();
    saveRecentEntry(); // sofort in „Zuletzt bearbeitet" aufnehmen
    pushToChild();
    return true;
  }

  async function joinSession(hostPeerId, roomId, name) {
    if (room || !hostPeerId || !roomId) return false;
    await refreshSelf();
    const joined = await api.realtime.joinRoom({ hostPeerId, roomId, name: selfName || contactName(selfPeerId) });
    if (!joined) {
      api.notify.toast?.({ title: 'Live Dokumente', message: 'Beitritt fehlgeschlagen.' });
      pushToChild();
      return false;
    }
    room = joined;
    sessionDocId = newDocId();
    fileName = cleanName(name, fileName);
    wireRoom();
    // Sofort (synchron) anlegen, damit der DOC_SYNC des Hosts direkt nach dem
    // JOIN_OK im frischen Dokument landet.
    doc = room.createDocument({ docId: DOC_ID });
    wireDoc();
    pendingInvite = null;
    pushToChild();
    return true;
  }

  function leaveSession() {
    try {
      room?.leave?.();
    } catch {
      /* ignore */
    }
    resetSession();
  }

  function handleChildAction(payload) {
    if (!payload?.type) return;
    switch (payload.type) {
      case 'request_state':
        pushToChild();
        break;
      case 'new_doc':
        if (!room) void hostSession('', payload.fileName, newDocId());
        break;
      case 'import_text': {
        const text = String(payload.text || '').slice(0, MAX_DOC_CHARS);
        if (!room) {
          void hostSession(text, payload.fileName, newDocId());
        } else if (doc) {
          fileName = cleanName(payload.fileName, fileName);
          if (room.isHost) doc.setState(text);
          else doc.applyOp({ type: 'replace', value: text });
          room.broadcast({ type: 'meta', fileName });
          flushRecent();
          pushToChild();
        }
        break;
      }
      case 'apply_op':
        if (doc && payload.op && typeof payload.op === 'object'
          && Number(payload.baseRevision) === doc.getRevision()) {
          const next = payload.op.type === 'insert' || payload.op.type === 'replace'
            ? (payload.op.text?.length || payload.op.value?.length || 0)
            : 0;
          if (String(doc.getState() ?? '').length + next <= MAX_DOC_CHARS) {
            doc.applyOp(payload.op);
          }
        } else {
          // Revision passt nicht mehr — Editor bekommt den aktuellen Stand.
          pushToChild();
        }
        break;
      case 'cursor':
        // Eigene Cursor-/Auswahlposition an alle Mit-Bearbeiter (ephemer).
        room?.broadcast({ type: 'cursor', caret: payload.caret || null, name: selfName || '' });
        break;
      case 'set_filename':
        fileName = cleanName(payload.fileName, fileName);
        room?.broadcast({ type: 'meta', fileName });
        saveRecentEntry();
        pushToChild();
        break;
      case 'invite':
        if (payload.peerId) {
          const doInvite = () => {
            if (room?.invite(payload.peerId)) {
              sendChatInvite(payload.peerId);
              api.notify.toast?.({ title: 'Live Dokumente', message: `${contactName(payload.peerId)} wurde im Chat eingeladen.` });
            }
          };
          if (room) doInvite();
          else void hostSession('').then((ok) => { if (ok) doInvite(); pushToChild(); });
        }
        break;
      case 'join_pending':
        if (pendingInvite) void joinSession(pendingInvite.hostPeerId, pendingInvite.roomId, pendingInvite.name);
        break;
      case 'dismiss_pending':
        pendingInvite = null;
        pushToChild();
        break;
      case 'leave':
        leaveSession();
        break;
      default:
        break;
    }
  }

  // ---------- Launcher-Kommandos (für die Dokumente-Seite) ----------

  function launcherState() {
    return {
      active: Boolean(room),
      hasSavedGame: false,
      tableName: room ? fileName : (pendingInvite ? 'Einladung wartet' : null),
      docId: room ? sessionDocId : '',
      fileName: room ? fileName : '',
    };
  }

  function launchNew() {
    void (async () => {
      if (!room && !pendingInvite) await hostSession('', undefined, newDocId());
      await openEditorWindow();
    })();
    return { ok: true };
  }

  function openWindow() {
    void openEditorWindow();
    return { ok: true };
  }

  function joinInvite(args) {
    const roomId = args && args.roomId;
    const hostPeerId = args && args.hostPeerId;
    const name = (args && args.fileName) || 'Dokument';
    void (async () => {
      if (!room && roomId && hostPeerId) {
        pendingInvite = null;
        await joinSession(hostPeerId, roomId, name);
      }
      await openEditorWindow();
    })();
    return { ok: true };
  }

  function listRecent() {
    return recents.load();
  }

  function openRecent(args) {
    const id = args && args.id;
    const entry = recents.load().find((e) => e && e.id === id) || null;
    void (async () => {
      // Läuft bereits eine Sitzung, nur das Fenster zeigen (nicht überschreiben).
      if (!room && entry) await hostSession(entry.html || '', entry.fileName, entry.id);
      await openEditorWindow();
    })();
    return { ok: true };
  }

  function forgetRecent(args) {
    recents.remove(args && args.id);
    return { ok: true };
  }

  function handleRoomInvite(invite) {
    if (!room && invite?.roomId && invite?.hostPeerId) {
      pendingInvite = { ...invite };
      const name = String(invite.name || '').replace(/^Dokument: /, '');
      api.notify.toast?.({
        title: 'Live Dokumente',
        message: `${contactName(invite.hostPeerId)} lädt dich ein, „${name || 'ein Dokument'}“ mitzubearbeiten.`,
      });
      pushToChild();
    }
  }

  return {
    refreshSelf,
    pushToChild,
    handleChildAction,
    handleRoomInvite,
    leaveSession,
    launcherState,
    launchNew,
    openWindow,
    joinInvite,
    listRecent,
    openRecent,
    forgetRecent,
  };
}
