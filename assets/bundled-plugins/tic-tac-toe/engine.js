/**
 * Tic-Tac-Toe — Spiel-Engine (Einstellungen + host-autoritative Partie).
 *
 * `createHost` kapselt den gesamten autoritativen Spielzustand (Sitzplätze,
 * Phasen, Brett, Checkpoints, KI-Training). Die Anbindung an die Außenwelt
 * (Peer-Versand, Kontaktprüfung, Speicher, Timer) wird über `deps` injiziert,
 * damit die zustandsbehaftete Orchestrierung in ui.js bleibt.
 */

import {
  AI_PEER_ID,
  PLAYER_MARKS,
  createEmptyBoard,
  cloneBoard,
  applyMove,
  isBoardFull,
  isValidBoardShape,
} from './board.js';
import { checkWin } from './rules.js';
import {
  chooseAiMove,
  emptyModel,
  modelKey,
  chooseTrainedMove,
  isTrainableBoard,
  trainSelfPlay,
  learnFromGame,
  TRAIN_MAX_GAMES,
} from './ai.js';

const BOARD_SIZES = [3, 5, 7];
const WIN_LENGTHS = [3, 4, 5];

export function defaultSettings() {
  return {
    tableName: 'Tic-Tac-Toe',
    playMode: 'solo',
    boardSize: 3,
    winLength: 3,
    maxPlayers: 2,
    aiDifficulty: 'medium',
    aiAutoplay: false,
    lobbyAccess: 'invite',
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings()) {
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
  // Online-Autopilot: die trainierte KI übernimmt online den Host-Platz und
  // tritt gegen einen verbundenen Kontakt an. Nur als klassisches 2-Spieler-
  // 3×3, damit das gelernte Modell passt.
  next.aiAutoplay = next.aiAutoplay === true;
  if (next.playMode === 'solo') next.aiAutoplay = false;
  if (next.playMode === 'online' && next.aiAutoplay) {
    next.boardSize = 3;
    next.winLength = 3;
    next.maxPlayers = 2;
  }
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  return next;
}

export function settingsSummary(cfg) {
  const mode = cfg.playMode === 'solo' ? 'Solo vs Algorithmus' : `Online · max. ${cfg.maxPlayers}`;
  return `${cfg.boardSize}×${cfg.boardSize} · ${cfg.winLength} in einer Reihe · ${mode}`;
}

/**
 * Erzeugt einen host-autoritativen Spielzustand.
 *
 * @param {object} deps  Injizierte Abhängigkeiten:
 *   - api: Plugin-API (storage, timer, peers, chat)
 *   - sendWire(peerId, body)
 *   - broadcastWire(body, peerIds)
 *   - isContactBlocked(peerId)
 */
export function createHost(settings, onTick, me, restoredGame = null, deps = {}) {
  const { api, sendWire, broadcastWire, isContactBlocked } = deps;
  const selfId = me?.id;
  const gameId = restoredGame?.gameId || `ttt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
  const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings());
  const players = [];
  let phase = restoredGame?.phase === 'playing' || restoredGame?.phase === 'finished'
    ? restoredGame.phase
    : 'lobby';
  // Wiederhergestelltes Brett nur übernehmen, wenn es formal zur Feldgröße passt
  // (jede Zeile korrekt lang) — schützt große Felder vor beschädigten Ständen.
  let board = isValidBoardShape(restoredGame?.board, cfg.boardSize)
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

  // Eine „Lernpartie" ist ein 2-Spieler-3×3-Spiel, in dem die trainierte KI
  // beteiligt ist — solo als Gegner oder online als Autopilot des Hosts.
  function isLearningGame() {
    if (cfg.boardSize !== 3 || cfg.winLength !== 3) return false;
    if (players.length !== 2) return false;
    if (cfg.playMode === 'solo') return cfg.aiDifficulty === 'trained';
    if (cfg.playMode === 'online') return cfg.aiAutoplay === true;
    return false;
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
      aiModel: aiModelSummary(),
      players: players.map((p) => {
        const botControlled = cfg.playMode === 'online'
          && cfg.aiAutoplay === true
          && p.peerId === selfId;
        return {
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          disc: p.disc,
          mark: PLAYER_MARKS[(p.disc || 1) - 1] || '?',
          isAi: p.isAi === true,
          botControlled,
          connected: p.connected !== false,
        };
      }),
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
    if (!isLearningGame()) return;
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

    // Zug zuerst validieren. Erst danach die Lernhistorie fortschreiben — sonst
    // hinterlässt ein abgelehnter (ungültiger) Zug einen Geistereintrag, der das
    // spätere Lernen verfälscht. applyMove mutiert `board` nicht, daher steht
    // hier noch der Zustand VOR dem Zug für den modelKey bereit.
    const nextBoard = applyMove(board, row, col, player.disc);
    if (!nextBoard) return false;

    // Trainierte KI lernt aus der echten Partie (solo oder Online-Autopilot):
    // Zustand vor dem Zug aus Sicht des Ziehenden merken.
    if (isLearningGame()) {
      ensureModel();
      const other = players.find((p) => p.disc !== player.disc);
      if (other) moveHistory.push({ key: modelKey(board, player.disc, other.disc), disc: player.disc });
    }

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
    if (phase !== 'playing') return;
    const actor = players[toActIdx];
    if (!actor) return;

    // Solo: der KI-Sitzplatz zieht. Online: die trainierte KI übernimmt als
    // Autopilot den Host-Platz und spielt gegen den verbundenen Gegner.
    const soloAi = cfg.playMode === 'solo' && actor.isAi;
    const onlineAutopilot = cfg.playMode === 'online'
      && cfg.aiAutoplay === true
      && actor.peerId === selfId
      && isTrainableBoard(board, cfg.winLength)
      && players.length === 2;
    if (!soloAi && !onlineAutopilot) return;

    const opponent = players.find((p) => p.disc !== actor.disc);
    if (!opponent) return;

    const difficulty = onlineAutopilot ? 'trained' : cfg.aiDifficulty;
    if (difficulty === 'trained') ensureModel();
    const moverPeerId = soloAi ? AI_PEER_ID : actor.peerId;

    queueMicrotask(() => {
      const move = chooseAiMove(
        board,
        cfg.winLength,
        actor.disc,
        opponent.disc,
        difficulty,
        difficulty === 'trained' ? aiModel : null
      );
      if (move) place(moverPeerId, move.row, move.col);
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
