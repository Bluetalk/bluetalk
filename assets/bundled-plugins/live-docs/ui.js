/**
 * Live Dokumente — Plugin-Controller (Hauptfenster).
 *
 * Läuft headless im Hauptfenster: Realtime-Raum + SharedDocument leben hier,
 * damit die Sitzung weiterläuft, auch wenn das Editor-Fenster geschlossen wird.
 * Die Darstellung übernimmt das separate Editor-Fenster
 * (src/renderer/pages/DocsEditorPage.jsx), verbunden über window.bluetalk.docs
 * (pushState / onFromChild) — gleiches Muster wie die Spielfenster.
 *
 * Synchronisation: host-autoritatives SharedDocument (plugin-realtime).
 * Clients schicken Text-Ops (insert/delete/replace) mit baseRevision; veraltete
 * Ops lehnt der Host ab und antwortet mit einem vollständigen DOC_SYNC. Die
 * Konfliktauflösung (Diff + Merge im Editor) macht das Editor-Fenster.
 */
(function liveDocsPluginUi() {
  const api = BlueTalkPlugin;
  const MAX_PEERS = 8;
  const MAX_DOC_CHARS = 400000;
  const DOC_ID = 'main';

  let room = null;
  let doc = null;
  let fileName = 'Unbenanntes Dokument';
  let pendingInvite = null;
  let selfPeerId = '';
  let selfName = '';
  let offDocChange = null;
  let sessionDocId = '';
  let recentTimer = null;

  // „Zuletzt bearbeitet": im (persistenten) Plugin-Speicher gehalten, damit die
  // Dokumente-Seite sie auch nach dem Schließen einer Sitzung anzeigen kann.
  const RECENT_KEY = 'recentDocs';
  const RECENT_MAX = 12;
  const RECENT_HTML_MAX = 200000;
  const newDocId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  function loadRecent() {
    const list = api.storage?.get(RECENT_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  function saveRecentEntry() {
    if (!doc || !sessionDocId) return;
    const html = String(doc.getState() ?? '').slice(0, RECENT_HTML_MAX);
    const rest = loadRecent().filter((e) => e && e.id !== sessionDocId);
    rest.unshift({ id: sessionDocId, fileName, html, updatedAt: Date.now() });
    api.storage?.set(RECENT_KEY, rest.slice(0, RECENT_MAX));
  }
  function scheduleRecent() {
    if (recentTimer) return;
    recentTimer = setTimeout(() => { recentTimer = null; saveRecentEntry(); }, 4000);
  }
  function flushRecent() {
    if (recentTimer) { clearTimeout(recentTimer); recentTimer = null; }
    saveRecentEntry();
  }

  const cleanName = (value, fallback) => String(value || fallback || '').slice(0, 120) || 'Unbenanntes Dokument';
  const me = async () => api.peer.info?.().catch(() => null);
  const contactName = (peerId) => {
    const contact = api.contacts().find((c) => c.id === peerId);
    return contact?.nickname || contact?.name || peerId?.slice(0, 10) || 'Gast';
  };

  async function refreshSelf() {
    const info = await me();
    if (info?.id) {
      selfPeerId = info.id;
      selfName = info.name || '';
    }
    return selfPeerId;
  }

  function listContacts() {
    try {
      return api.contacts()
        .filter((c) => c?.id && c.blocked !== true)
        .map((c) => ({ id: c.id, name: c.nickname || c.name || c.id }))
        .slice(0, 100);
    } catch {
      return [];
    }
  }

  function listParticipants() {
    if (!room) return [];
    return room.allMemberPeerIds().map((peerId) => ({
      peerId,
      name: peerId === selfPeerId
        ? (selfName || 'Ich')
        : (room.members.get(peerId)?.name && room.members.get(peerId).name !== 'host'
          ? room.members.get(peerId).name
          : contactName(peerId)),
      isSelf: peerId === selfPeerId,
      isHost: peerId === room.hostPeerId,
    }));
  }

  function pushToChild() {
    if (!window.bluetalk?.docs?.pushState) return;
    window.bluetalk.docs.pushState({
      hasRoom: Boolean(room),
      isHost: Boolean(room?.isHost),
      roomId: room?.roomId || '',
      selfPeerId: room?.selfPeerId || selfPeerId || '',
      fileName,
      doc: doc ? { state: String(doc.getState() ?? ''), revision: doc.getRevision() } : null,
      participants: listParticipants(),
      contacts: listContacts(),
      pendingInvite: pendingInvite
        ? { roomId: pendingInvite.roomId, hostPeerId: pendingInvite.hostPeerId, name: pendingInvite.name || 'Dokument', fromName: contactName(pendingInvite.hostPeerId) }
        : null,
      at: Date.now(),
    });
  }

  async function openEditorWindow() {
    try {
      await window.bluetalk?.docs?.openGameWindow?.();
    } catch {
      /* ignore */
    }
    pushToChild();
  }

  function wireDoc() {
    offDocChange?.();
    offDocChange = doc?.on('change', () => {
      pushToChild();
      scheduleRecent();
    }) || null;
  }

  function pushPresence(payload) {
    try {
      window.bluetalk?.docs?.pushPresence?.(payload);
    } catch {
      /* ignore */
    }
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
        pushPresence({
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
      pushPresence({ peerId, gone: true });
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

  let offChild = null;
  if (window.bluetalk?.docs?.onFromChild) {
    offChild = window.bluetalk.docs.onFromChild(handleChildAction);
  }

  // ---------- Launcher & Einladungen ----------

  api.ui.registerCommand('launcherState', () => ({
    active: Boolean(room),
    hasSavedGame: false,
    tableName: room ? fileName : (pendingInvite ? 'Einladung wartet' : null),
    docId: room ? sessionDocId : '',
    fileName: room ? fileName : '',
  }));
  api.ui.registerCommand('launchNew', () => {
    void (async () => {
      if (!room && !pendingInvite) await hostSession('', undefined, newDocId());
      await openEditorWindow();
    })();
    return { ok: true };
  });
  api.ui.registerCommand('openWindow', () => {
    void openEditorWindow();
    return { ok: true };
  });
  // Einer Sitzung über eine Chat-Einladung beitreten (roomId + hostPeerId aus der
  // Einladungs-Nachricht). Öffnet danach den Editor.
  api.ui.registerCommand('joinInvite', (args) => {
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
  });
  // „Zuletzt bearbeitet" für die Dokumente-Seite.
  api.ui.registerCommand('listRecent', () => loadRecent());
  api.ui.registerCommand('openRecent', (args) => {
    const id = args && args.id;
    const entry = loadRecent().find((e) => e && e.id === id) || null;
    void (async () => {
      // Läuft bereits eine Sitzung, nur das Fenster zeigen (nicht überschreiben).
      if (!room && entry) await hostSession(entry.html || '', entry.fileName, entry.id);
      await openEditorWindow();
    })();
    return { ok: true };
  });
  api.ui.registerCommand('forgetRecent', (args) => {
    const id = args && args.id;
    if (id) api.storage?.set(RECENT_KEY, loadRecent().filter((e) => e && e.id !== id));
    return { ok: true };
  });

  api.realtime.on('room-invite', (invite) => {
    if (!room && invite?.roomId && invite?.hostPeerId) {
      pendingInvite = { ...invite };
      const name = String(invite.name || '').replace(/^Dokument: /, '');
      api.notify.toast?.({
        title: 'Live Dokumente',
        message: `${contactName(invite.hostPeerId)} lädt dich ein, „${name || 'ein Dokument'}“ mitzubearbeiten.`,
      });
      pushToChild();
    }
  });

  api.onDeactivate(() => {
    offChild?.();
    leaveSession();
  });

  void refreshSelf().then(() => pushToChild());
  api.log.info('Live-Dokumente-Plugin geladen');
})();
