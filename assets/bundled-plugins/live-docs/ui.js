/**
 * Live Dokumente — Plugin-Controller (Hauptfenster).
 *
 * Läuft headless im Hauptfenster: Realtime-Raum + SharedDocument leben hier,
 * damit die Sitzung weiterläuft, auch wenn das Editor-Fenster geschlossen wird.
 * Die Darstellung übernimmt das separate Editor-Fenster
 * (src/renderer/pages/DocsEditorPage.jsx), verbunden über window.bluetalk.docs
 * (pushState / onFromChild) — gleiches Muster wie das 3D-Autorennen.
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
    offDocChange = doc?.on('change', () => pushToChild()) || null;
  }

  function wireRoom() {
    if (!room) return;
    room.on('message', ({ payload }) => {
      if (payload?.type === 'meta' && typeof payload.fileName === 'string') {
        fileName = cleanName(payload.fileName, fileName);
        pushToChild();
      }
    });
    room.on('peer-joined', ({ peerId, name }) => {
      api.notify.toast?.({ title: 'Live Dokumente', message: `${name || contactName(peerId)} arbeitet jetzt mit.` });
      pushToChild();
    });
    room.on('peer-left', () => pushToChild());
    room.on('closed', () => {
      if (!room) return;
      api.notify.toast?.({ title: 'Live Dokumente', message: 'Die Sitzung wurde beendet.' });
      resetSession();
    });
  }

  function resetSession() {
    offDocChange?.();
    offDocChange = null;
    doc = null;
    room = null;
    pushToChild();
  }

  async function hostSession(initialText = '', name) {
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
    wireRoom();
    doc = room.createDocument({ docId: DOC_ID, initial: String(initialText || '').slice(0, MAX_DOC_CHARS) });
    wireDoc();
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
        if (!room) void hostSession('', payload.fileName);
        break;
      case 'import_text': {
        const text = String(payload.text || '').slice(0, MAX_DOC_CHARS);
        if (!room) {
          void hostSession(text, payload.fileName);
        } else if (doc) {
          fileName = cleanName(payload.fileName, fileName);
          if (room.isHost) doc.setState(text);
          else doc.applyOp({ type: 'replace', value: text });
          room.broadcast({ type: 'meta', fileName });
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
      case 'set_filename':
        fileName = cleanName(payload.fileName, fileName);
        room?.broadcast({ type: 'meta', fileName });
        pushToChild();
        break;
      case 'invite':
        if (payload.peerId) {
          const doInvite = () => {
            if (room?.invite(payload.peerId)) {
              api.notify.toast?.({ title: 'Live Dokumente', message: `${contactName(payload.peerId)} wurde eingeladen.` });
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
  }));
  api.ui.registerCommand('launchNew', () => {
    void (async () => {
      if (!room && !pendingInvite) await hostSession('');
      await openEditorWindow();
    })();
    return { ok: true };
  });
  api.ui.registerCommand('openWindow', () => {
    void openEditorWindow();
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
