/**
 * BlueTalk Vier gewinnt — Host-autoritativ, P2P, 2 Spieler.
 */
(function connectFourPluginUi() {
  const api = BlueTalkPlugin;

  const ROWS = 6;
  const COLS = 7;
  const MAX_PLAYERS = 2;

  function defaultSettings() {
    return {
      tableName: 'Vier-gewinnt-Tisch',
      maxPlayers: MAX_PLAYERS,
      lobbyAccess: 'invite',
    };
  }

  function sanitizeSettings(input = {}, fallback = defaultSettings()) {
    const next = { ...defaultSettings(), ...fallback, ...input };
    next.tableName = String(next.tableName || 'Vier-gewinnt-Tisch').trim().slice(0, 48) || 'Vier-gewinnt-Tisch';
    next.maxPlayers = MAX_PLAYERS;
    next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
    return next;
  }

  function createEmptyBoard() {
    return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function dropDisc(board, col, player) {
    if (col < 0 || col >= COLS || player < 1 || player > 2) return null;
    for (let row = ROWS - 1; row >= 0; row -= 1) {
      if (board[row][col] === 0) {
        board[row][col] = player;
        return { row, col };
      }
    }
    return null;
  }

  function isColumnFull(board, col) {
    return board[0][col] !== 0;
  }

  function checkWin(board, row, col, player) {
    const directions = [
      [0, 1],
      [1, 0],
      [1, 1],
      [1, -1],
    ];
    for (const [dr, dc] of directions) {
      const cells = [{ row, col }];
      for (const sign of [-1, 1]) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
          cells.push({ row: r, col: c });
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (cells.length >= 4) return cells;
    }
    return null;
  }

  function isBoardFull(board) {
    for (let col = 0; col < COLS; col += 1) {
      if (!isColumnFull(board, col)) return false;
    }
    return true;
  }

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'connect-four', connectFour: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isConnectFourLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  function createHost(settings, onTick, me, restoredGame = null) {
    const selfId = me?.id;
    const gameId = restoredGame?.gameId || `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
    const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings());
    const players = [];
    let phase = restoredGame?.phase === 'playing' || restoredGame?.phase === 'finished'
      ? restoredGame.phase
      : 'lobby';
    let board = Array.isArray(restoredGame?.board) && restoredGame.board.length === ROWS
      ? restoredGame.board.map((row) => row.slice())
      : createEmptyBoard();
    let toActIdx = Number.isInteger(restoredGame?.toActIdx) ? restoredGame.toActIdx : 0;
    let winnerPeerId = restoredGame?.winnerPeerId || null;
    let winCells = Array.isArray(restoredGame?.winCells) ? restoredGame.winCells : null;
    let message = String(restoredGame?.message || '');
    let savedAt = Number(restoredGame?.savedAt) || 0;
    const invitedPeers = new Set(Array.isArray(restoredGame?.invitedPeers) ? restoredGame.invitedPeers : []);

    for (const row of restoredPlayers) {
      if (!row?.peerId || players.some((p) => p.peerId === row.peerId)) continue;
      players.push({
        peerId: row.peerId,
        name: String(row.name || row.peerId).slice(0, 48),
        seat: Number(row.seat) || players.length,
        disc: (Number(row.seat) || players.length) + 1,
        connected: row.connected !== false,
      });
    }
    players.sort((a, b) => a.seat - b.seat);

    function playerIndex(peerId) {
      return players.findIndex((p) => p.peerId === peerId);
    }

    function peerIds() {
      return players.map((p) => p.peerId).filter(Boolean);
    }

    function checkpoint(reason) {
      savedAt = Date.now();
      api.storage.set('savedConnectFourGame', {
        gameId,
        settings: { ...cfg },
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          connected: p.connected !== false,
        })),
        phase,
        board: cloneBoard(board),
        toActIdx,
        winnerPeerId,
        winCells,
        message,
        savedAt,
        invitedPeers: [...invitedPeers],
      });
      api.storage.set('connectFourSettings', { ...cfg });
      void reason;
    }

    function publicState() {
      const actor = toActIdx >= 0 && toActIdx < players.length ? players[toActIdx] : null;
      return {
        gameId,
        hostPeerId: selfId,
        phase,
        board: cloneBoard(board),
        toAct: actor?.peerId || null,
        winnerPeerId,
        winCells: winCells ? winCells.map((c) => ({ ...c })) : null,
        savedAt,
        message,
        settings: { ...cfg },
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          disc: p.disc,
          connected: p.connected !== false,
        })),
      };
    }

    function pushState() {
      broadcastWire({ wire: 'state', gameId, public: publicState() }, peerIds());
      onTick?.();
    }

    function findSeat() {
      const taken = new Set(players.map((p) => p.seat));
      for (let s = 0; s < cfg.maxPlayers; s += 1) {
        if (!taken.has(s)) return s;
      }
      return -1;
    }

    function addPlayer(peerId, name) {
      const existing = players.find((p) => p.peerId === peerId);
      if (existing) {
        existing.connected = true;
        existing.name = String(name || existing.name).slice(0, 48);
        pushState();
        return true;
      }
      if (players.length >= cfg.maxPlayers) return false;
      const seat = findSeat();
      if (seat < 0) return false;
      players.push({
        peerId,
        name: String(name || peerId).slice(0, 48),
        seat,
        disc: seat + 1,
        connected: true,
      });
      players.sort((a, b) => a.seat - b.seat);
      checkpoint('join');
      pushState();
      return true;
    }

    function removePlayer(peerId) {
      const idx = playerIndex(peerId);
      if (idx < 0) return;
      if (peerId === selfId) return;
      if (idx < toActIdx) toActIdx -= 1;
      players.splice(idx, 1);
      if (toActIdx >= players.length) toActIdx = 0;
      if (phase === 'playing' && players.length < 2) {
        phase = 'lobby';
        board = createEmptyBoard();
        winnerPeerId = null;
        winCells = null;
        message = 'Zu wenige Spieler — zurück in die Lobby.';
      }
      checkpoint('leave');
      pushState();
    }

    function kickPlayer(peerId) {
      if (peerId === selfId) return false;
      const idx = playerIndex(peerId);
      if (idx < 0) return false;
      const name = players[idx].name;
      sendWire(peerId, { wire: 'kicked', gameId, reason: 'Du wurdest vom Host aus dem Spiel entfernt.' });
      removePlayer(peerId);
      message = `${name} wurde vom Host entfernt.`;
      checkpoint('kick');
      pushState();
      return true;
    }

    function startGame() {
      if (phase !== 'lobby') return false;
      if (players.length < 2) {
        message = 'Genau 2 Spieler nötig.';
        pushState();
        return false;
      }
      board = createEmptyBoard();
      toActIdx = 0;
      winnerPeerId = null;
      winCells = null;
      phase = 'playing';
      message = `${players[toActIdx]?.name || 'Spieler 1'} beginnt (Rot).`;
      checkpoint('start');
      pushState();
      return true;
    }

    function rematch() {
      if (phase !== 'finished') return false;
      board = createEmptyBoard();
      toActIdx = 0;
      winnerPeerId = null;
      winCells = null;
      phase = 'playing';
      message = `Revanche — ${players[toActIdx]?.name || 'Spieler 1'} beginnt.`;
      checkpoint('rematch');
      pushState();
      return true;
    }

    function drop(peerId, column) {
      const idx = playerIndex(peerId);
      if (idx < 0 || toActIdx !== idx || phase !== 'playing') return false;
      const col = Math.round(Number(column));
      if (!Number.isFinite(col) || col < 0 || col >= COLS) return false;
      if (isColumnFull(board, col)) return false;

      const player = players[idx];
      const placed = dropDisc(board, col, player.disc);
      if (!placed) return false;

      const win = checkWin(board, placed.row, placed.col, player.disc);
      if (win) {
        winnerPeerId = peerId;
        winCells = win;
        phase = 'finished';
        message = `${player.name} gewinnt!`;
        checkpoint('win');
        pushState();
        return true;
      }

      if (isBoardFull(board)) {
        winnerPeerId = null;
        winCells = null;
        phase = 'finished';
        message = 'Unentschieden — das Brett ist voll.';
        checkpoint('draw');
        pushState();
        return true;
      }

      toActIdx = toActIdx === 0 ? 1 : 0;
      message = `${players[toActIdx]?.name || 'Spieler'} ist am Zug.`;
      checkpoint('move');
      pushState();
      return true;
    }

    function applyAction(peerId, action) {
      if (!action?.type) return false;
      switch (action.type) {
        case 'drop':
          return drop(peerId, action.column);
        case 'rematch':
          return rematch();
        default:
          return false;
      }
    }

    function onWire(from, body) {
      if (!body?.wire) return;
      if (body.wire === 'join' && body.gameId === gameId) {
        if (phase !== 'lobby') {
          sendWire(from, { wire: 'join_reject', gameId, reason: 'Spiel läuft bereits.' });
          return;
        }
        if (cfg.lobbyAccess !== 'public' && from !== selfId && !invitedPeers.has(from)) {
          sendWire(from, {
            wire: 'join_reject',
            gameId,
            reason: 'Nur auf Einladung — bitte zuerst eine Einladung im Chat erhalten.',
          });
          return;
        }
        const ok = addPlayer(from, body.name);
        sendWire(from, ok
          ? { wire: 'join_ok', gameId, public: publicState() }
          : { wire: 'join_reject', gameId, reason: 'Tisch voll oder Beitritt fehlgeschlagen.' });
        return;
      }
      if (body.wire === 'leave') {
        removePlayer(from);
        return;
      }
      if (body.wire === 'action' && body.gameId === gameId) {
        applyAction(from, body.action || {});
      }
    }

    function bootstrapHost() {
      addPlayer(selfId, me?.name || 'Host');
      checkpoint(restoredGame ? 'resumed' : 'game_created');
    }

    return {
      gameId,
      cfg,
      bootstrapHost,
      get settings() {
        return cfg;
      },
      updateSettings(patch) {
        Object.assign(cfg, sanitizeSettings(patch, cfg));
        message = phase === 'lobby'
          ? 'Einstellungen aktualisiert.'
          : 'Einstellungen gespeichert — gelten ab der nächsten Partie.';
        checkpoint('settings');
        pushState();
      },
      invitePeer(peerId) {
        if (!peerId || players.some((p) => p.peerId === peerId)) return false;
        const connected = (api.peers() || []).some((p) => p.id === peerId);
        if (!connected || isContactBlocked(peerId)) return false;
        invitedPeers.add(peerId);
        void api.chat.send(peerId, this.invitePayload());
        message = 'Einladung wurde im Chat gesendet.';
        pushState();
        return true;
      },
      saveNow() {
        if (phase === 'playing') {
          message = 'Während einer laufenden Partie wird automatisch gespeichert.';
          pushState();
          return false;
        }
        checkpoint('manual');
        message = 'Spielstand gespeichert.';
        pushState();
        return true;
      },
      invitePayload() {
        const sum = 'Vier gewinnt · 2 Spieler';
        return {
          kind: 'connect-four-invite',
          gameId,
          tableName: cfg.tableName,
          hostPeerId: selfId,
          connectFourSettings: { ...cfg },
          connectFourSettingsSummary: sum,
          lobbyAccess: cfg.lobbyAccess,
          content: `🔴 ${cfg.tableName} — ${sum}`,
        };
      },
      startGame,
      rematch,
      onWire,
      removePlayer,
      kickPlayer,
      publicState,
      pushState,
      applyAction: (pid, a) => applyAction(pid, a),
      destroy() {},
    };
  }

  window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__ = window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__ || {};
  Object.assign(window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__, {
    ROWS,
    COLS,
    createEmptyBoard,
    dropDisc,
    checkWin,
    isBoardFull,
    isColumnFull,
    sanitizeSettings,
    createHost,
  });

  let host = null;
  let hostRef = null;
  let cfSelfPeerId = '';
  let cfSelfPeerName = '';
  let clientState = null;
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'connect-four',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !cfSelfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).length;
    const maxPlayers = pub.settings?.maxPlayers || MAX_PLAYERS;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isConnectFourLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'connect-four',
      sessionId,
      tableName: pub.settings?.tableName || 'Vier-gewinnt-Tisch',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || cfSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      cfSelfPeerId = i?.id || '';
      cfSelfPeerName = i?.name || '';
    } catch {
      cfSelfPeerId = '';
      cfSelfPeerName = '';
    }
    return cfSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.connectFour?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.connectFour.pushState(null);
      clearGamePresence();
      return;
    }
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.connectFour.pushState({ public: pub, inviteCandidates });
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.connectFour?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'connect-four' || !msg.connectFour) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.connectFour;
    const selfId = cfSelfPeerId;

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      if (w.public) {
        clientState = w.public;
        tryPump();
        void openGameWindowIfNeeded();
      }
      api.notify.toast?.({ title: 'Vier gewinnt', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Vier gewinnt', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'Vier gewinnt', message: w.reason || 'Du wurdest aus dem Spiel entfernt.' });
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.connectFour?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.connectFour.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.connectFour.pendingJoin');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function notifyLauncherRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('bt:games-launcher-refresh'));
    } catch {
      /* ignore */
    }
  }

  async function launchHostGame(saved = null) {
    const peerInfo = await window.bluetalk?.peer?.getInfo?.();
    if (!peerInfo?.id) {
      api.notify.toast?.({ title: 'Vier gewinnt', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    cfSelfPeerId = peerInfo.id;
    cfSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('connectFourSettings', defaultSettings());
    host = createHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedConnectFourGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Vier-gewinnt-Tisch',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function bootstrapPendingJoin() {
    await refreshSelfId();
    const pending = tryConsumePendingJoin();
    if (pending?.hostPeerId && pending?.gameId && !host && !clientState) {
      clientState = {
        gameId: pending.gameId,
        hostPeerId: pending.hostPeerId,
        phase: 'lobby',
        players: [],
        settings: sanitizeSettings(pending.connectFourSettings || {}),
        message: 'Verbindung zum Tisch wird hergestellt…',
      };
      sendWire(pending.hostPeerId, {
        wire: 'join',
        gameId: pending.gameId,
        name: cfSelfPeerName || 'Spieler',
      });
      await openGameWindowIfNeeded();
      tryPump();
      notifyLauncherRefresh();
    }
  }

  const offMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'connect-four' || !msg.connectFour || isContactBlocked(msg.from)) return;
    if (host && msg.from !== cfSelfPeerId) host.onWire(msg.from, msg.connectFour);
    handleWire(msg);
  });
  const offDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: cfSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChild = null;
  if (window.bluetalk?.connectFour?.onFromChild) {
    offChild = window.bluetalk.connectFour.onFromChild((payload) => {
      if (!payload) return;
      const pid = cfSelfPeerId;

      if (payload.type === 'request_state') {
        tryPump();
      } else if (payload.type === 'action' && payload.action) {
        if (hostRef) {
          hostRef.applyAction(pid, payload.action);
        } else if (clientState?.hostPeerId && clientState?.gameId) {
          sendWire(clientState.hostPeerId, {
            wire: 'action',
            gameId: clientState.gameId,
            action: payload.action,
          });
        }
      } else if (payload.type === 'host_start') {
        if (hostRef) hostRef.startGame();
      } else if (payload.type === 'leave') {
        if (hostRef) {
          broadcastWire({ wire: 'leave', gameId: hostRef.gameId }, hostRef.publicState().players.map((p) => p.peerId));
          hostRef.destroy();
          hostRef = null;
          host = null;
        } else if (clientState?.hostPeerId) {
          sendWire(clientState.hostPeerId, { wire: 'leave', gameId: clientState.gameId });
        }
        clearGamePresence();
        clientState = null;
        tryPump();
        notifyLauncherRefresh();
      } else if (payload.type === 'update_settings' && payload.settings) {
        hostRef?.updateSettings(payload.settings);
      } else if (payload.type === 'invite' && payload.peerId) {
        hostRef?.invitePeer(payload.peerId);
      } else if (payload.type === 'save_game') {
        hostRef?.saveNow();
      } else if (payload.type === 'kick_player' && payload.peerId) {
        hostRef?.kickPlayer(payload.peerId);
      }
    });
  }

  void refreshSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedConnectFourGame', null)));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offChild?.();
    offMessage?.();
    offDisconnect?.();
    offConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
  });

  api.log.info('Vier-gewinnt-Plugin UI geladen');
})();
