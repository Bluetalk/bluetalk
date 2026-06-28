/**
 * BlueTalk Tic-Tac-Toe — Solo vs Algorithmus, Online P2P, konfigurierbares Feld.
 */
(function ticTacToePluginUi() {
  const api = BlueTalkPlugin;

  const AI_PEER_ID = '__ttt_ai__';
  const BOARD_SIZES = [3, 5, 7];
  const WIN_LENGTHS = [3, 4, 5];
  const PLAYER_MARKS = ['X', 'O', '△', '□'];

  function defaultSettings() {
    return {
      tableName: 'Tic-Tac-Toe',
      playMode: 'solo',
      boardSize: 3,
      winLength: 3,
      maxPlayers: 2,
      aiDifficulty: 'medium',
      lobbyAccess: 'invite',
    };
  }

  function sanitizeSettings(input = {}, fallback = defaultSettings()) {
    const next = { ...defaultSettings(), ...fallback, ...input };
    next.tableName = String(next.tableName || 'Tic-Tac-Toe').trim().slice(0, 48) || 'Tic-Tac-Toe';
    next.playMode = next.playMode === 'online' ? 'online' : 'solo';
    next.boardSize = BOARD_SIZES.includes(Number(next.boardSize)) ? Number(next.boardSize) : 3;
    next.winLength = WIN_LENGTHS.includes(Number(next.winLength))
      ? Math.min(Number(next.winLength), next.boardSize)
      : Math.min(3, next.boardSize);
    next.maxPlayers = next.playMode === 'solo'
      ? 2
      : Math.min(4, Math.max(2, Math.round(Number(next.maxPlayers) || 2)));
    next.aiDifficulty = ['easy', 'medium', 'hard'].includes(next.aiDifficulty)
      ? next.aiDifficulty
      : 'medium';
    next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
    return next;
  }

  function createEmptyBoard(size) {
    const n = Number(size) || 3;
    return Array.from({ length: n }, () => Array(n).fill(0));
  }

  function cloneBoard(board) {
    return board.map((row) => row.slice());
  }

  function applyMove(board, row, col, player) {
    const size = board.length;
    const r = Math.round(Number(row));
    const c = Math.round(Number(col));
    const p = Math.round(Number(player));
    if (!Number.isFinite(r) || !Number.isFinite(c) || r < 0 || c < 0 || r >= size || c >= size) return null;
    if (board[r][c] !== 0 || p < 1 || p > 4) return null;
    const next = cloneBoard(board);
    next[r][c] = p;
    return next;
  }

  function checkWin(board, winLength, lastMove) {
    if (!lastMove || !board?.length) return null;
    const { row, col } = lastMove;
    const player = board[row]?.[col];
    if (!player) return null;
    const size = board.length;
    const need = Math.max(2, Number(winLength) || 3);
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
      const cells = [{ row, col }];
      for (const sign of [-1, 1]) {
        let r = row + dr * sign;
        let c = col + dc * sign;
        while (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) {
          cells.push({ row: r, col: c });
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (cells.length >= need) {
        return { winner: player, cells: cells.slice(0, need) };
      }
    }
    return null;
  }

  function isBoardFull(board) {
    for (let r = 0; r < board.length; r += 1) {
      for (let c = 0; c < board[r].length; c += 1) {
        if (board[r][c] === 0) return false;
      }
    }
    return true;
  }

  function listEmptyCells(board) {
    const cells = [];
    for (let r = 0; r < board.length; r += 1) {
      for (let c = 0; c < board[r].length; c += 1) {
        if (board[r][c] === 0) cells.push({ row: r, col: c });
      }
    }
    return cells;
  }

  function settingsSummary(cfg) {
    const mode = cfg.playMode === 'solo' ? 'Solo vs Algorithmus' : `Online · max. ${cfg.maxPlayers}`;
    return `${cfg.boardSize}×${cfg.boardSize} · ${cfg.winLength} in einer Reihe · ${mode}`;
  }

  function findWinningMove(board, winLength, player) {
    const empties = listEmptyCells(board);
    for (const cell of empties) {
      const next = applyMove(board, cell.row, cell.col, player);
      if (next && checkWin(next, winLength, cell)) return cell;
    }
    return null;
  }

  function scoreLine(board, winLength, player, opponent) {
    let score = 0;
    const size = board.length;
    const lines = [];
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) lines.push({ dr: 0, dc: 1, row: r, col: c });
    }
    for (let c = 0; c < size; c += 1) {
      for (let r = 0; r < size; r += 1) lines.push({ dr: 1, dc: 0, row: r, col: c });
    }
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        lines.push({ dr: 1, dc: 1, row: r, col: c });
        lines.push({ dr: 1, dc: -1, row: r, col: c });
      }
    }
    const need = Math.max(2, winLength);
    for (const line of lines) {
      let mine = 0;
      let theirs = 0;
      let empty = 0;
      for (let i = 0; i < need; i += 1) {
        const r = line.row + line.dr * i;
        const c = line.col + line.dc * i;
        if (r < 0 || c < 0 || r >= size || c >= size) {
          mine = -1;
          break;
        }
        const cell = board[r][c];
        if (cell === player) mine += 1;
        else if (cell === opponent) theirs += 1;
        else if (cell === 0) empty += 1;
        else {
          mine = -1;
          break;
        }
      }
      if (mine < 0) continue;
      if (theirs === 0 && mine > 0) score += 10 ** mine;
      if (mine === 0 && theirs > 0) score -= 10 ** theirs;
      void empty;
    }
    return score;
  }

  function minimax(board, winLength, depth, maximizing, player, opponent, alpha, beta, maxDepth) {
    const lastMoves = listEmptyCells(board);
    if (depth >= maxDepth || isBoardFull(board)) {
      return { score: scoreLine(board, winLength, player, opponent) };
    }

    let bestScore = maximizing ? -Infinity : Infinity;
    let bestMove = null;

    for (const cell of lastMoves) {
      const next = applyMove(board, cell.row, cell.col, maximizing ? player : opponent);
      if (!next) continue;
      const result = checkWin(next, winLength, cell);
      if (result?.winner === player && maximizing) {
        return { score: 100000 - depth, move: cell };
      }
      if (result?.winner === opponent && !maximizing) {
        return { score: -100000 + depth, move: cell };
      }
      const child = minimax(next, winLength, depth + 1, !maximizing, player, opponent, alpha, beta, maxDepth);
      const score = child.score;
      if (maximizing) {
        if (score > bestScore) {
          bestScore = score;
          bestMove = cell;
        }
        alpha = Math.max(alpha, score);
      } else {
        if (score < bestScore) {
          bestScore = score;
          bestMove = cell;
        }
        beta = Math.min(beta, score);
      }
      if (beta <= alpha) break;
    }

    return { score: bestScore, move: bestMove };
  }

  function aiSearchDepth(boardSize, difficulty) {
    if (boardSize === 3 && difficulty === 'hard') return 9;
    if (difficulty === 'easy') return 1;
    if (difficulty === 'medium') return boardSize === 3 ? 4 : 2;
    if (boardSize === 3) return 9;
    if (boardSize === 5) return 3;
    return 2;
  }

  function chooseAiMove(board, winLength, aiDisc, humanDisc, difficulty) {
    const empties = listEmptyCells(board);
    if (!empties.length) return null;

    if (difficulty === 'easy' && Math.random() < 0.3) {
      return empties[Math.floor(Math.random() * empties.length)];
    }

    const winMove = findWinningMove(board, winLength, aiDisc);
    if (winMove) return winMove;

    const blockMove = findWinningMove(board, winLength, humanDisc);
    if (blockMove) return blockMove;

    if (difficulty === 'easy') {
      const center = Math.floor(board.length / 2);
      if (board[center][center] === 0) return { row: center, col: center };
      return empties[Math.floor(Math.random() * empties.length)];
    }

    const depth = aiSearchDepth(board.length, difficulty);
    const result = minimax(
      board,
      winLength,
      0,
      true,
      aiDisc,
      humanDisc,
      -Infinity,
      Infinity,
      depth
    );
    if (result?.move) return result.move;

    const center = Math.floor(board.length / 2);
    if (board[center][center] === 0) return { row: center, col: center };
    return empties[0];
  }

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || peerId === AI_PEER_ID || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'tic-tac-toe', ticTacToe: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isTttLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  function createHost(settings, onTick, me, restoredGame = null) {
    const selfId = me?.id;
    const gameId = restoredGame?.gameId || `ttt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
    const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings());
    const players = [];
    let phase = restoredGame?.phase === 'playing' || restoredGame?.phase === 'finished'
      ? restoredGame.phase
      : 'lobby';
    let board = Array.isArray(restoredGame?.board) && restoredGame.board.length === cfg.boardSize
      ? restoredGame.board.map((row) => row.slice())
      : createEmptyBoard(cfg.boardSize);
    let toActIdx = Number.isInteger(restoredGame?.toActIdx) ? restoredGame.toActIdx : 0;
    let winnerPeerId = restoredGame?.winnerPeerId || null;
    let winnerDisc = restoredGame?.winnerDisc || null;
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
        isAi: row.peerId === AI_PEER_ID || row.isAi === true,
        connected: row.connected !== false,
      });
    }
    players.sort((a, b) => a.seat - b.seat);

    function playerIndex(peerId) {
      return players.findIndex((p) => p.peerId === peerId);
    }

    function peerIds() {
      return players.map((p) => p.peerId).filter((id) => id && id !== AI_PEER_ID);
    }

    function resetBoard() {
      board = createEmptyBoard(cfg.boardSize);
    }

    function checkpoint(reason) {
      savedAt = Date.now();
      api.storage.set('savedTicTacToeGame', {
        gameId,
        settings: { ...cfg },
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          isAi: p.isAi === true,
          connected: p.connected !== false,
        })),
        phase,
        board: cloneBoard(board),
        toActIdx,
        winnerPeerId,
        winnerDisc,
        winCells,
        message,
        savedAt,
        invitedPeers: [...invitedPeers],
      });
      api.storage.set('ticTacToeSettings', { ...cfg });
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
        winnerDisc,
        winCells: winCells ? winCells.map((c) => ({ ...c })) : null,
        savedAt,
        message,
        settings: { ...cfg },
        playerMarks: PLAYER_MARKS,
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          disc: p.disc,
          mark: PLAYER_MARKS[(p.disc || 1) - 1] || '?',
          isAi: p.isAi === true,
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

    function ensureAiPlayer() {
      if (cfg.playMode !== 'solo') return;
      if (players.some((p) => p.peerId === AI_PEER_ID)) return;
      const seat = players.length > 0 ? 1 : 0;
      players.push({
        peerId: AI_PEER_ID,
        name: 'Algorithmus',
        seat,
        disc: seat + 1,
        isAi: true,
        connected: true,
      });
      players.sort((a, b) => a.seat - b.seat);
    }

    function addPlayer(peerId, name) {
      if (cfg.playMode === 'solo' && peerId !== selfId) return false;
      const existing = players.find((p) => p.peerId === peerId);
      if (existing) {
        existing.connected = true;
        existing.name = String(name || existing.name).slice(0, 48);
        pushState();
        return true;
      }
      if (players.filter((p) => !p.isAi).length >= cfg.maxPlayers) return false;
      if (players.length >= cfg.maxPlayers) return false;
      const seat = findSeat();
      if (seat < 0) return false;
      players.push({
        peerId,
        name: String(name || peerId).slice(0, 48),
        seat,
        disc: seat + 1,
        isAi: false,
        connected: true,
      });
      players.sort((a, b) => a.seat - b.seat);
      checkpoint('join');
      pushState();
      return true;
    }

    function removePlayer(peerId) {
      if (peerId === AI_PEER_ID) return;
      const idx = playerIndex(peerId);
      if (idx < 0) return;
      if (peerId === selfId) return;
      if (idx < toActIdx) toActIdx -= 1;
      players.splice(idx, 1);
      if (toActIdx >= players.length) toActIdx = 0;
      if (phase === 'playing' && players.filter((p) => !p.isAi).length < 2 && cfg.playMode === 'online') {
        phase = 'lobby';
        resetBoard();
        winnerPeerId = null;
        winnerDisc = null;
        winCells = null;
        message = 'Zu wenige Spieler — zurück in die Lobby.';
      }
      checkpoint('leave');
      pushState();
    }

    function kickPlayer(peerId) {
      if (peerId === selfId || peerId === AI_PEER_ID) return false;
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

    function minPlayersToStart() {
      return cfg.playMode === 'solo' ? 1 : 2;
    }

    function startGame() {
      if (phase !== 'lobby') return false;
      ensureAiPlayer();
      const activeCount = players.filter((p) => !p.isAi).length;
      if (activeCount < minPlayersToStart()) {
        message = cfg.playMode === 'solo'
          ? 'Solo-Spiel konnte nicht starten.'
          : `Mindestens ${minPlayersToStart()} Spieler nötig.`;
        pushState();
        return false;
      }
      if (cfg.playMode === 'online' && players.filter((p) => !p.isAi).length < 2) {
        message = 'Mindestens 2 Spieler für Online-Partie nötig.';
        pushState();
        return false;
      }
      resetBoard();
      toActIdx = 0;
      winnerPeerId = null;
      winnerDisc = null;
      winCells = null;
      phase = 'playing';
      message = `${players[toActIdx]?.name || 'Spieler 1'} beginnt (${PLAYER_MARKS[(players[toActIdx]?.disc || 1) - 1]}).`;
      checkpoint('start');
      pushState();
      maybeAiMove();
      return true;
    }

    function rematch() {
      if (phase !== 'finished') return false;
      resetBoard();
      toActIdx = 0;
      winnerPeerId = null;
      winnerDisc = null;
      winCells = null;
      phase = 'playing';
      message = `Revanche — ${players[toActIdx]?.name || 'Spieler 1'} beginnt.`;
      checkpoint('rematch');
      pushState();
      maybeAiMove();
      return true;
    }

    function advanceTurn() {
      if (!players.length) return;
      toActIdx = (toActIdx + 1) % players.length;
    }

    function finishWithWin(peerId, disc, cells, label) {
      winnerPeerId = peerId;
      winnerDisc = disc;
      winCells = cells;
      phase = 'finished';
      message = label;
      checkpoint('win');
      pushState();
    }

    function finishDraw() {
      winnerPeerId = null;
      winnerDisc = null;
      winCells = null;
      phase = 'finished';
      message = 'Unentschieden — das Feld ist voll.';
      checkpoint('draw');
      pushState();
    }

    function place(peerId, row, col) {
      const idx = playerIndex(peerId);
      if (idx < 0 || toActIdx !== idx || phase !== 'playing') return false;
      const player = players[idx];
      if (player.isAi && peerId !== AI_PEER_ID) return false;
      if (peerId === AI_PEER_ID && player.peerId !== AI_PEER_ID) return false;

      const nextBoard = applyMove(board, row, col, player.disc);
      if (!nextBoard) return false;
      board = nextBoard;
      const move = { row: Math.round(Number(row)), col: Math.round(Number(col)) };
      const win = checkWin(board, cfg.winLength, move);
      if (win) {
        finishWithWin(
          player.peerId,
          player.disc,
          win.cells,
          `${player.name} gewinnt!`
        );
        return true;
      }
      if (isBoardFull(board)) {
        finishDraw();
        return true;
      }
      advanceTurn();
      message = `${players[toActIdx]?.name || 'Spieler'} ist am Zug (${PLAYER_MARKS[(players[toActIdx]?.disc || 1) - 1]}).`;
      checkpoint('move');
      pushState();
      maybeAiMove();
      return true;
    }

    function maybeAiMove() {
      if (cfg.playMode !== 'solo' || phase !== 'playing') return;
      const actor = players[toActIdx];
      if (!actor?.isAi) return;
      const human = players.find((p) => !p.isAi);
      if (!human) return;
      queueMicrotask(() => {
        const move = chooseAiMove(
          board,
          cfg.winLength,
          actor.disc,
          human.disc,
          cfg.aiDifficulty
        );
        if (move) place(AI_PEER_ID, move.row, move.col);
      });
    }

    function applyAction(peerId, action) {
      if (!action?.type) return false;
      switch (action.type) {
        case 'place':
          return place(peerId, action.row, action.col);
        case 'rematch':
          return rematch();
        default:
          return false;
      }
    }

    function onWire(from, body) {
      if (!body?.wire) return;
      if (body.wire === 'join' && body.gameId === gameId) {
        if (cfg.playMode === 'solo') {
          sendWire(from, { wire: 'join_reject', gameId, reason: 'Solo-Spiel — kein Online-Beitritt.' });
          return;
        }
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
      ensureAiPlayer();
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
        if (phase !== 'lobby') {
          message = 'Einstellungen können nur in der Lobby geändert werden.';
          pushState();
          return;
        }
        Object.assign(cfg, sanitizeSettings(patch, cfg));
        if (cfg.playMode === 'solo') {
          ensureAiPlayer();
          while (players.filter((p) => !p.isAi).length > 1) {
            const extra = players.find((p) => !p.isAi && p.peerId !== selfId);
            if (!extra) break;
            removePlayer(extra.peerId);
          }
        } else {
          const aiIdx = players.findIndex((p) => p.peerId === AI_PEER_ID);
          if (aiIdx >= 0) players.splice(aiIdx, 1);
        }
        resetBoard();
        message = 'Einstellungen aktualisiert.';
        checkpoint('settings');
        pushState();
      },
      invitePeer(peerId) {
        if (cfg.playMode === 'solo') return false;
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
        const sum = settingsSummary(cfg);
        return {
          kind: 'tic-tac-toe-invite',
          gameId,
          tableName: cfg.tableName,
          hostPeerId: selfId,
          ticTacToeSettings: { ...cfg },
          ticTacToeSettingsSummary: sum,
          lobbyAccess: cfg.lobbyAccess,
          content: `✕ ${cfg.tableName} — ${sum}`,
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

  window.__BLUETALK_TICTACTOE_TEST_HOOKS__ = window.__BLUETALK_TICTACTOE_TEST_HOOKS__ || {};
  Object.assign(window.__BLUETALK_TICTACTOE_TEST_HOOKS__, {
    AI_PEER_ID,
    PLAYER_MARKS,
    createEmptyBoard,
    applyMove,
    checkWin,
    isBoardFull,
    listEmptyCells,
    chooseAiMove,
    sanitizeSettings,
    settingsSummary,
    createHost,
  });

  let host = null;
  let hostRef = null;
  let tttSelfPeerId = '';
  let tttSelfPeerName = '';
  let clientState = null;
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'tic-tac-toe',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !tttSelfPeerId || pub.settings?.playMode === 'solo') {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).filter((p) => !p.isAi).length;
    const maxPlayers = pub.settings?.maxPlayers || 2;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isTttLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'tic-tac-toe',
      sessionId,
      tableName: pub.settings?.tableName || 'Tic-Tac-Toe',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || tttSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      tttSelfPeerId = i?.id || '';
      tttSelfPeerName = i?.name || '';
    } catch {
      tttSelfPeerId = '';
      tttSelfPeerName = '';
    }
    return tttSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.ticTacToe?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.ticTacToe.pushState(null);
      clearGamePresence();
      return;
    }
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = pub.settings?.playMode === 'solo'
      ? []
      : (api.contacts() || [])
        .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
        .map((contact) => ({
          peerId: contact.id,
          name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
        }));
    window.bluetalk.ticTacToe.pushState({ public: pub, inviteCandidates });
    syncGamePresence();
  }

  async function pumpStateToWindow() {
    tryPump();
    for (const delayMs of [150, 400, 900]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      tryPump();
    }
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.ticTacToe?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'tic-tac-toe' || !msg.ticTacToe) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.ticTacToe;
    const selfId = tttSelfPeerId;

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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: w.reason || 'Beitritt abgelehnt.' });
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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: w.reason || 'Du wurdest aus dem Spiel entfernt.' });
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.ticTacToe?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.ticTacToe.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.ticTacToe.pendingJoin');
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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    tttSelfPeerId = peerInfo.id;
    tttSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('ticTacToeSettings', defaultSettings());
    host = createHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    await openGameWindowIfNeeded();
    await pumpStateToWindow();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedTicTacToeGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Tic-Tac-Toe',
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
        settings: sanitizeSettings(pending.ticTacToeSettings || {}),
        message: 'Verbindung zum Tisch wird hergestellt…',
      };
      sendWire(pending.hostPeerId, {
        wire: 'join',
        gameId: pending.gameId,
        name: tttSelfPeerName || 'Spieler',
      });
      await openGameWindowIfNeeded();
      tryPump();
      notifyLauncherRefresh();
    }
  }

  const offMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'tic-tac-toe' || !msg.ticTacToe || isContactBlocked(msg.from)) return;
    if (host && msg.from !== tttSelfPeerId) host.onWire(msg.from, msg.ticTacToe);
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
        name: tttSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChild = null;
  if (window.bluetalk?.ticTacToe?.onFromChild) {
    offChild = window.bluetalk.ticTacToe.onFromChild((payload) => {
      if (!payload) return;
      const pid = tttSelfPeerId;

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
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedTicTacToeGame', null)));
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

  api.log.info('Tic-Tac-Toe-Plugin UI geladen');
})();
