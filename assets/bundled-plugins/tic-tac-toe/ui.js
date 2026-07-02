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
    next.aiDifficulty = ['easy', 'medium', 'hard', 'trained'].includes(next.aiDifficulty)
      ? next.aiDifficulty
      : 'medium';
    // Die trainierbare KI arbeitet nur auf dem klassischen 3×3-Feld.
    if (next.playMode === 'solo' && next.aiDifficulty === 'trained') {
      next.boardSize = 3;
      next.winLength = 3;
    }
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

  // Suchtiefe je Schwierigkeit. „hard" spielt auf 3×3 perfekt, „medium" bewusst
  // flacher, „easy" verzichtet ganz auf die Vorausberechnung.
  function aiSearchDepth(boardSize, difficulty) {
    if (difficulty === 'hard') {
      if (boardSize === 3) return 9;
      if (boardSize === 5) return 4;
      return 3;
    }
    if (difficulty === 'medium') {
      if (boardSize === 3) return 3;
      return 2;
    }
    return 1;
  }

  function randomCell(empties) {
    return empties[Math.floor(Math.random() * empties.length)];
  }

  function chooseAiMove(board, winLength, aiDisc, humanDisc, difficulty, model = null) {
    const empties = listEmptyCells(board);
    if (!empties.length) return null;

    // Trainierte KI: gelerntes Modell befragen, sonst auf „medium" zurückfallen.
    let level = difficulty;
    if (level === 'trained') {
      const learned = chooseTrainedMove(board, winLength, aiDisc, humanDisc, model);
      if (learned) return learned;
      level = 'medium';
    }

    // Leicht: absichtlich schwach — viel Zufall, verpasst öfter Sieg und Konter.
    if (level === 'easy') {
      const winMove = findWinningMove(board, winLength, aiDisc);
      if (winMove && Math.random() < 0.7) return winMove;
      if (Math.random() < 0.5) return randomCell(empties);
      const blockMove = findWinningMove(board, winLength, humanDisc);
      if (blockMove && Math.random() < 0.5) return blockMove;
      const center = Math.floor(board.length / 2);
      if (board[center][center] === 0 && Math.random() < 0.5) return { row: center, col: center };
      return randomCell(empties);
    }

    // Mittel & Schwer: Sieg und Konter immer erkennen, dann Suche.
    const winMove = findWinningMove(board, winLength, aiDisc);
    if (winMove) return winMove;

    const blockMove = findWinningMove(board, winLength, humanDisc);
    if (blockMove) return blockMove;

    const depth = aiSearchDepth(board.length, level);
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
    if (result?.move) {
      // Mittel spielt nicht perfekt: gelegentlich ein zufälliger Zug für Varianz.
      if (level === 'medium' && Math.random() < 0.15) return randomCell(empties);
      return result.move;
    }

    const center = Math.floor(board.length / 2);
    if (board[center][center] === 0) return { row: center, col: center };
    return empties[0];
  }

  // ----- Trainierbare KI (Selbstlern-Modell für klassisches 3×3) -----------
  // Das Modell speichert Zustandswerte V[key] aus Sicht des Spielers am Zug
  // (eigene Steine = '2', gegnerische = '1', leer = '0'). Gelernt wird per
  // Monte-Carlo-Rückführung des Partieergebnisses (+1 Sieg, −1 Niederlage,
  // 0 Remis). Die Zugwahl erfolgt negamax-artig: mein Wert eines Zuges ist der
  // negierte Wert der Folgestellung aus Gegnersicht.
  const TRAIN_MAX_GAMES = 20000;

  function emptyModel() {
    return { version: 1, V: {}, games: 0, wins: 0, losses: 0, draws: 0, updatedAt: 0 };
  }

  function isTrainableBoard(board, winLength) {
    return board.length === 3 && Number(winLength) === 3;
  }

  function modelKey(board, moverDisc, oppDisc) {
    let s = '';
    for (let r = 0; r < board.length; r += 1) {
      for (let c = 0; c < board[r].length; c += 1) {
        const v = board[r][c];
        s += v === moverDisc ? '2' : v === oppDisc ? '1' : '0';
      }
    }
    return s;
  }

  function chooseTrainedMove(board, winLength, aiDisc, humanDisc, model, epsilon = 0) {
    if (!model || !model.V) return null;
    if (!isTrainableBoard(board, winLength)) return null;
    const empties = listEmptyCells(board);
    if (!empties.length) return null;

    // Einen sofortigen Sieg nimmt die KI immer mit.
    const winMove = findWinningMove(board, winLength, aiDisc);
    if (winMove) return winMove;

    if (epsilon > 0 && Math.random() < epsilon) return randomCell(empties);

    let best = null;
    let bestScore = -Infinity;
    let known = false;
    for (const cell of empties) {
      const next = applyMove(board, cell.row, cell.col, aiDisc);
      if (!next) continue;
      let score;
      if (checkWin(next, winLength, cell)) {
        score = 1;
      } else if (isBoardFull(next)) {
        score = 0;
      } else {
        // Danach ist der Gegner am Zug — Wert aus dessen Sicht, negiert.
        const v = model.V[modelKey(next, humanDisc, aiDisc)];
        if (typeof v === 'number') known = true;
        score = -(typeof v === 'number' ? v : 0);
      }
      if (score > bestScore) {
        bestScore = score;
        best = cell;
      }
    }
    // Kennt das Modell die Stellung überhaupt nicht, überlassen wir dem
    // Aufrufer die Heuristik statt blind das erste Feld zu nehmen.
    if (!known) return null;
    return best;
  }

  function trainingFallbackMove(board, winLength, moverDisc, oppDisc) {
    const winMove = findWinningMove(board, winLength, moverDisc);
    if (winMove) return winMove;
    const blockMove = findWinningMove(board, winLength, oppDisc);
    if (blockMove && Math.random() < 0.7) return blockMove;
    return randomCell(listEmptyCells(board));
  }

  // Trainiert das Modell per Selbstspiel. Läuft rein synchron; der Aufrufer
  // stückelt größere Läufe in Häppchen, damit die UI reagierbar bleibt.
  function trainSelfPlay(model, games, opts = {}) {
    const m = model && model.V ? model : emptyModel();
    const alpha = typeof opts.alpha === 'number' ? opts.alpha : 0.1;
    const epsilon = typeof opts.epsilon === 'number' ? opts.epsilon : 0.25;
    const rounds = Math.max(0, Math.round(Number(games) || 0));
    const P1 = 1;
    const P2 = 2;
    for (let g = 0; g < rounds; g += 1) {
      let board = createEmptyBoard(3);
      let mover = P1;
      const visited = [];
      let winnerDisc = null;
      for (let ply = 0; ply < 9; ply += 1) {
        const opp = mover === P1 ? P2 : P1;
        // Zustand vor dem Zug aus Sicht des Ziehenden merken.
        visited.push({ key: modelKey(board, mover, opp), disc: mover });
        const move = chooseTrainedMove(board, 3, mover, opp, m, epsilon)
          || trainingFallbackMove(board, 3, mover, opp);
        const next = applyMove(board, move.row, move.col, mover);
        if (!next) break;
        board = next;
        if (checkWin(board, 3, move)) {
          winnerDisc = mover;
          break;
        }
        if (isBoardFull(board)) break;
        mover = opp;
      }
      for (const step of visited) {
        const z = winnerDisc == null ? 0 : (step.disc === winnerDisc ? 1 : -1);
        const cur = typeof m.V[step.key] === 'number' ? m.V[step.key] : 0;
        m.V[step.key] = cur + alpha * (z - cur);
      }
      m.games += 1;
      if (winnerDisc == null) m.draws += 1;
      else if (winnerDisc === P1) m.wins += 1;
      else m.losses += 1;
    }
    m.updatedAt = 0;
    return m;
  }

  // Rückführung einer real gespielten Partie (Mensch gegen trainierte KI).
  // history: [{ key, disc }] in Zugreihenfolge, winnerDisc = Siegerscheibe|null.
  function learnFromGame(model, history, winnerDisc, alpha = 0.15) {
    if (!model || !model.V || !Array.isArray(history) || !history.length) return model;
    for (const step of history) {
      if (!step || typeof step.key !== 'string') continue;
      const z = winnerDisc == null ? 0 : (step.disc === winnerDisc ? 1 : -1);
      const cur = typeof model.V[step.key] === 'number' ? model.V[step.key] : 0;
      model.V[step.key] = cur + alpha * (z - cur);
    }
    model.games += 1;
    if (winnerDisc == null) model.draws += 1;
    return model;
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

    // Trainierbare KI: gelerntes Modell + Trainings-/Lernzustand.
    let aiModel = null;
    let moveHistory = [];
    let training = false;
    let trainingTarget = 0;
    let trainingDone = 0;
    let trainingTimer = null;

    function ensureModel() {
      if (!aiModel || !aiModel.V) {
        const stored = api.storage.get('savedTicTacToeModel', null);
        aiModel = stored && stored.V ? stored : emptyModel();
      }
      return aiModel;
    }

    function saveModel() {
      if (!aiModel) return;
      aiModel.updatedAt = Date.now();
      api.storage.set('savedTicTacToeModel', aiModel);
    }

    function aiModelSummary() {
      const m = aiModel || api.storage.get('savedTicTacToeModel', null);
      const states = m && m.V ? Object.keys(m.V).length : 0;
      return {
        available: states > 0,
        games: m?.games || 0,
        states,
        wins: m?.wins || 0,
        losses: m?.losses || 0,
        draws: m?.draws || 0,
        training,
        progress: trainingTarget > 0 ? Math.min(1, trainingDone / trainingTarget) : 0,
      };
    }

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
        aiModel: cfg.playMode === 'solo' ? aiModelSummary() : null,
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
      moveHistory = [];
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
      moveHistory = [];
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

    function absorbGameIntoModel(resultDisc) {
      if (cfg.playMode !== 'solo' || cfg.aiDifficulty !== 'trained') return;
      if (!moveHistory.length) return;
      ensureModel();
      learnFromGame(aiModel, moveHistory, resultDisc);
      moveHistory = [];
      saveModel();
    }

    function finishWithWin(peerId, disc, cells, label) {
      winnerPeerId = peerId;
      winnerDisc = disc;
      winCells = cells;
      phase = 'finished';
      message = label;
      absorbGameIntoModel(disc);
      checkpoint('win');
      pushState();
    }

    function finishDraw() {
      winnerPeerId = null;
      winnerDisc = null;
      winCells = null;
      phase = 'finished';
      message = 'Unentschieden — das Feld ist voll.';
      absorbGameIntoModel(null);
      checkpoint('draw');
      pushState();
    }

    function place(peerId, row, col) {
      const idx = playerIndex(peerId);
      if (idx < 0 || toActIdx !== idx || phase !== 'playing') return false;
      const player = players[idx];
      if (player.isAi && peerId !== AI_PEER_ID) return false;
      if (peerId === AI_PEER_ID && player.peerId !== AI_PEER_ID) return false;

      // Trainierte Solo-KI lernt aus der echten Partie: Zustand vor dem Zug
      // aus Sicht des Ziehenden merken.
      if (cfg.playMode === 'solo' && cfg.aiDifficulty === 'trained' && isTrainableBoard(board, cfg.winLength)) {
        ensureModel();
        const other = players.find((p) => p.disc !== player.disc);
        if (other) moveHistory.push({ key: modelKey(board, player.disc, other.disc), disc: player.disc });
      }

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
      if (cfg.aiDifficulty === 'trained') ensureModel();
      queueMicrotask(() => {
        const move = chooseAiMove(
          board,
          cfg.winLength,
          actor.disc,
          human.disc,
          cfg.aiDifficulty,
          cfg.aiDifficulty === 'trained' ? aiModel : null
        );
        if (move) place(AI_PEER_ID, move.row, move.col);
      });
    }

    function trainingEpsilon() {
      if (trainingTarget <= 0) return 0.25;
      const frac = trainingDone / trainingTarget;
      return Math.max(0.08, 0.35 - 0.27 * frac);
    }

    function runTrainingChunk() {
      trainingTimer = null;
      if (!training) return;
      const CHUNK = 400;
      const batch = Math.min(CHUNK, trainingTarget - trainingDone);
      trainSelfPlay(aiModel, batch, { epsilon: trainingEpsilon() });
      trainingDone += batch;
      if (trainingDone >= trainingTarget) {
        training = false;
        saveModel();
        message = `KI-Training abgeschlossen — ${aiModel.games} Partien gespielt, ${Object.keys(aiModel.V).length} Stellungen gelernt.`;
        checkpoint('train_done');
        pushState();
        return;
      }
      saveModel();
      pushState();
      trainingTimer = api.timer.setTimeout(runTrainingChunk, 0);
    }

    function trainAi(gamesRequested) {
      if (cfg.playMode !== 'solo') {
        message = 'KI-Training ist nur im Solo-Modus möglich.';
        pushState();
        return false;
      }
      if (phase === 'playing') {
        message = 'KI-Training nur in der Lobby oder nach der Partie möglich.';
        pushState();
        return false;
      }
      if (training) return false;
      const games = Math.max(1, Math.min(TRAIN_MAX_GAMES, Math.round(Number(gamesRequested) || 0)));
      ensureModel();
      training = true;
      trainingTarget = games;
      trainingDone = 0;
      message = `KI-Training läuft (${games} Partien Selbstspiel)…`;
      pushState();
      trainingTimer = api.timer.setTimeout(runTrainingChunk, 0);
      return true;
    }

    function resetAiModel() {
      if (training) return false;
      aiModel = emptyModel();
      moveHistory = [];
      saveModel();
      message = 'KI-Modell wurde zurückgesetzt.';
      pushState();
      return true;
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
      trainAi,
      resetAiModel,
      onWire,
      removePlayer,
      kickPlayer,
      publicState,
      pushState,
      applyAction: (pid, a) => applyAction(pid, a),
      destroy() {
        training = false;
        if (trainingTimer != null) {
          api.timer.clearTimeout(trainingTimer);
          trainingTimer = null;
        }
      },
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
    emptyModel,
    modelKey,
    chooseTrainedMove,
    trainSelfPlay,
    learnFromGame,
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

  async function joinGame(pending) {
    await refreshSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige Tic-Tac-Toe-Einladung.' };
    }
    if (!tttSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einem anderen Tic-Tac-Toe-Spiel.';
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message });
      return { ok: false, message };
    }
    if (sameGame) {
      await openGameWindowIfNeeded();
      tryPump();
      return { ok: true };
    }

    clientState = {
      gameId: pending.gameId,
      hostPeerId: pending.hostPeerId,
      phase: 'lobby',
      players: [],
      settings: sanitizeSettings(pending.ticTacToeSettings || {}),
      message: 'Verbindung zum Tisch wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      gameId: pending.gameId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: tttSelfPeerName || 'Spieler',
    });
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function bootstrapPendingJoin() {
    const pending = tryConsumePendingJoin();
    if (pending) await joinGame(pending);
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
      } else if (payload.type === 'train_ai') {
        hostRef?.trainAi(payload.games);
      } else if (payload.type === 'reset_ai_model') {
        hostRef?.resetAiModel();
      }
    });
  }

  void refreshSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedTicTacToeGame', null)));
  api.ui.registerCommand('join', (pending) => joinGame(pending));
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
