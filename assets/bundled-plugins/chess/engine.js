/**
 * BlueTalk Schach — Host-autoritative Zustandsmaschine (2 Spieler).
 *
 * createHost() kapselt Partiezustand, Uhren und Wire-Verarbeitung. Netzwerk-/
 * Host-Abhängigkeiten werden über `deps` injiziert (api, sendWire,
 * broadcastWire, isContactBlocked).
 */
import {
  START_FEN,
  clampInt,
  defaultSettings,
  sanitizeSettings,
  parseFen,
  boardToFen,
  createInitialState,
  colorForSeat,
  opponent,
} from './board.js';
import {
  isInCheck,
  applyMove,
  movesEqual,
  normalizeMove,
  getLegalMoves,
  isCheckmate,
  isStalemate,
  isInsufficientMaterial,
  isFiftyMoveDraw,
  moveToSan,
  moveToWire,
  movesToWire,
} from './rules.js';

export function createHost(deps, settings, onTick, me, restoredGame = null) {
  const { api, sendWire, broadcastWire, isContactBlocked } = deps;
  const selfId = me?.id;
  const gameId = restoredGame?.gameId || `chess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings());
  const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
  const players = [];
  let phase = restoredGame?.phase === 'playing' ? 'playing' : restoredGame?.phase === 'gameOver' ? 'gameOver' : 'lobby';
  let chessState = restoredGame?.chessState ? parseFen(restoredGame.chessState.fen || START_FEN) : createInitialState();
  if (restoredGame?.chessState?.fen) {
    chessState = parseFen(restoredGame.chessState.fen);
  }
  let lastMove = restoredGame?.lastMove || null;
  let moveHistory = Array.isArray(restoredGame?.moveHistory) ? restoredGame.moveHistory : [];
  let message = restoredGame?.message || '';
  let gameResult = restoredGame?.gameResult || null;
  let drawOffer = restoredGame?.drawOffer || null;
  let whiteMs = restoredGame?.clocks?.whiteMs ?? (cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0);
  let blackMs = restoredGame?.clocks?.blackMs ?? (cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0);
  let clockLastTick = Date.now();
  let clockTimer = null;
  let savedAt = Number(restoredGame?.savedAt) || 0;
  const invitedPeers = new Set(Array.isArray(restoredGame?.invitedPeers) ? restoredGame.invitedPeers : []);

  for (const row of restoredPlayers) {
    if (!row?.peerId || players.some((p) => p.peerId === row.peerId)) continue;
    const isSelf = row.peerId === selfId;
    players.push({
      peerId: row.peerId,
      name: String(row.name || row.peerId).slice(0, 48),
      seat: clampInt(row.seat, 0, 1, players.length),
      color: colorForSeat(clampInt(row.seat, 0, 1, players.length)),
      connected: isSelf || (api.peers() || []).some((p) => p.id === row.peerId),
    });
  }
  players.sort((a, b) => a.seat - b.seat);

  function peerIds() {
    return players.map((p) => p.peerId);
  }

  function clearClockTimer() {
    if (clockTimer) {
      api.timer.clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function tickClocks() {
    if (phase !== 'playing' || cfg.timeControlSec <= 0 || gameResult) return;
    const now = Date.now();
    const elapsed = now - clockLastTick;
    clockLastTick = now;
    if (chessState.turn === 'w') whiteMs = Math.max(0, whiteMs - elapsed);
    else blackMs = Math.max(0, blackMs - elapsed);
    if (whiteMs <= 0 || blackMs <= 0) {
      const winner = whiteMs <= 0 ? 'b' : 'w';
      endGame({ type: 'timeout', winnerColor: winner });
    }
  }

  function scheduleClockTimer() {
    clearClockTimer();
    if (phase !== 'playing' || cfg.timeControlSec <= 0) return;
    clockTimer = api.timer.setInterval(() => {
      tickClocks();
      pushState();
    }, 250);
  }

  function checkpoint(reason = 'auto') {
    savedAt = Date.now();
    const saved = {
      version: 1,
      gameId,
      savedAt,
      reason,
      phase,
      settings: { ...cfg },
      players: players.map((p) => ({
        peerId: p.peerId,
        name: p.name,
        seat: p.seat,
      })),
      chessState: { fen: boardToFen(chessState) },
      lastMove,
      moveHistory: [...moveHistory],
      gameResult,
      drawOffer,
      clocks: { whiteMs, blackMs },
      invitedPeers: [...invitedPeers],
      message,
    };
    api.storage.set('savedChessGame', saved);
    api.storage.set('chessSettings', { ...cfg });
    return saved;
  }

  function pushState() {
    tickClocks();
    const pub = publicState();
    for (const id of peerIds()) {
      if (id === selfId) continue;
      sendWire(id, {
        wire: 'state',
        gameId,
        public: pub,
        legalMoves: movesToWire(getLegalMovesForPeer(id)),
      });
    }
    onTick();
    return pub;
  }

  function publicState() {
    return {
      gameId,
      hostPeerId: selfId,
      phase,
      settings: { ...cfg },
      players: players.map((p) => ({
        peerId: p.peerId,
        name: p.name,
        seat: p.seat,
        color: p.color,
        connected: p.connected !== false,
      })),
      fen: boardToFen(chessState),
      turn: chessState.turn,
      lastMove,
      moveHistory: [...moveHistory],
      message,
      gameResult,
      drawOffer,
      inCheck: phase === 'playing' ? isInCheck(chessState, chessState.turn) : false,
      clocks: cfg.timeControlSec > 0 ? { whiteMs, blackMs, activeColor: chessState.turn } : null,
    };
  }

  function getLegalMovesForPeer(peerId) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || phase !== 'playing' || gameResult) return [];
    if (player.color !== chessState.turn) return [];
    return movesToWire(getLegalMoves(chessState, player.color));
  }

  function playerIndex(peerId) {
    return players.findIndex((p) => p.peerId === peerId);
  }

  function addPlayer(peerId, name) {
    if (players.some((p) => p.peerId === peerId)) return true;
    if (players.length >= cfg.maxPlayers) return false;
    const seat = players.length === 0 ? 0 : 1;
    players.push({
      peerId,
      name: String(name || peerId).slice(0, 48),
      seat,
      color: colorForSeat(seat),
      connected: true,
    });
    players.sort((a, b) => a.seat - b.seat);
    message = `${name || peerId} ist der Partie beigetreten (${seat === 0 ? 'Weiß' : 'Schwarz'}).`;
    checkpoint('join');
    pushState();
    return true;
  }

  function removePlayer(peerId) {
    const idx = playerIndex(peerId);
    if (idx < 0) return;
    const name = players[idx].name;
    players.splice(idx, 1);
    invitedPeers.delete(peerId);
    if (phase === 'playing' && players.length < 2) {
      endGame({ type: 'opponent_left', winnerColor: players[0]?.color || null });
    } else {
      message = `${name} hat die Partie verlassen.`;
      if (phase === 'playing') phase = 'lobby';
      clearClockTimer();
      checkpoint('leave');
      pushState();
    }
  }

  function endGame(result) {
    phase = 'gameOver';
    gameResult = result;
    drawOffer = null;
    clearClockTimer();
    if (result.type === 'checkmate') {
      message = `Schachmatt — ${result.winnerColor === 'w' ? 'Weiß' : 'Schwarz'} gewinnt.`;
    } else if (result.type === 'stalemate') {
      message = 'Patt — Remis.';
    } else if (result.type === 'draw') {
      message = result.reason || 'Remis.';
    } else if (result.type === 'resign') {
      message = `${result.loserColor === 'w' ? 'Weiß' : 'Schwarz'} gibt auf — ${result.winnerColor === 'w' ? 'Weiß' : 'Schwarz'} gewinnt.`;
    } else if (result.type === 'timeout') {
      message = `Zeit abgelaufen — ${result.winnerColor === 'w' ? 'Weiß' : 'Schwarz'} gewinnt.`;
    } else if (result.type === 'opponent_left') {
      message = result.winnerColor
        ? `Gegner offline — ${result.winnerColor === 'w' ? 'Weiß' : 'Schwarz'} gewinnt.`
        : 'Partie beendet.';
    }
    checkpoint('game_over');
    pushState();
  }

  function evaluateDrawConditions() {
    if (isFiftyMoveDraw(chessState)) {
      endGame({ type: 'draw', reason: 'Remis (50-Züge-Regel).' });
      return true;
    }
    if (isInsufficientMaterial(chessState)) {
      endGame({ type: 'draw', reason: 'Remis (unzureichendes Material).' });
      return true;
    }
    return false;
  }

  function startGame() {
    if (phase !== 'lobby') return false;
    if (players.length < 2) {
      message = 'Es werden genau 2 Spieler benötigt.';
      pushState();
      return false;
    }
    if (players.filter((p) => p.connected !== false).length < 2) {
      message = 'Beide Spieler müssen verbunden sein.';
      pushState();
      return false;
    }
    chessState = createInitialState();
    lastMove = null;
    moveHistory = [];
    gameResult = null;
    drawOffer = null;
    phase = 'playing';
    whiteMs = cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0;
    blackMs = cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0;
    clockLastTick = Date.now();
    message = 'Partie gestartet — Weiß zieht.';
    checkpoint('start');
    scheduleClockTimer();
    pushState();
    return true;
  }

  function makeMove(peerId, rawMove) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || phase !== 'playing' || gameResult) return false;
    if (player.color !== chessState.turn) return false;
    const move = normalizeMove(rawMove);
    if (!move) return false;
    const legal = getLegalMoves(chessState, player.color);
    const match = legal.find((m) => movesEqual(m, move));
    if (!match) return false;

    tickClocks();
    const prevTurn = chessState.turn;
    let san = moveToSan(chessState, match);
    chessState = applyMove(chessState, match);
    lastMove = moveToWire(match);
    const nextColor = opponent(prevTurn);
    if (isCheckmate(chessState, nextColor)) san += '#';
    else if (isInCheck(chessState, nextColor)) san += '+';
    moveHistory = [...moveHistory, { san, color: prevTurn, from: lastMove.from, to: lastMove.to }];
    drawOffer = null;
    clockLastTick = Date.now();

    // Schachmatt/Patt gehen einer Remis-Bedingung vor: eine mattsetzende
    // Schlussfigur gewinnt auch beim 100. Halbzug (50-Züge-Regel).
    const oppColor = opponent(prevTurn);
    if (isCheckmate(chessState, oppColor)) {
      endGame({ type: 'checkmate', winnerColor: prevTurn });
      return true;
    }
    if (isStalemate(chessState, oppColor)) {
      endGame({ type: 'stalemate' });
      return true;
    }
    if (evaluateDrawConditions()) return true;

    message = isInCheck(chessState, chessState.turn)
      ? `${chessState.turn === 'w' ? 'Weiß' : 'Schwarz'} ist im Schach.`
      : `${chessState.turn === 'w' ? 'Weiß' : 'Schwarz'} ist am Zug.`;
    checkpoint('move');
    pushState();
    return true;
  }

  function resign(peerId) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || phase !== 'playing' || gameResult) return false;
    const winner = opponent(player.color);
    endGame({ type: 'resign', loserColor: player.color, winnerColor: winner });
    return true;
  }

  function offerDraw(peerId) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || phase !== 'playing' || gameResult) return false;
    drawOffer = player.color;
    message = `${player.name} bietet Remis an.`;
    pushState();
    return true;
  }

  function acceptDraw(peerId) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || phase !== 'playing' || !drawOffer || drawOffer === player.color) return false;
    endGame({ type: 'draw', reason: 'Remis (vereinbart).' });
    return true;
  }

  function declineDraw(peerId) {
    const player = players.find((p) => p.peerId === peerId);
    if (!player || !drawOffer || drawOffer === player.color) return false;
    drawOffer = null;
    message = 'Remis-Angebot abgelehnt.';
    pushState();
    return true;
  }

  function applyAction(peerId, action) {
    if (!action?.type) return false;
    switch (action.type) {
      case 'move':
        return makeMove(peerId, action);
      case 'resign':
        return resign(peerId);
      case 'offerDraw':
        return offerDraw(peerId);
      case 'acceptDraw':
        return acceptDraw(peerId);
      case 'declineDraw':
        return declineDraw(peerId);
      default:
        return false;
    }
  }

  function kickPlayer(peerId) {
    if (peerId === selfId) return false;
    const idx = playerIndex(peerId);
    if (idx < 0) return false;
    const name = players[idx].name;
    sendWire(peerId, { wire: 'kicked', gameId, reason: 'Du wurdest vom Host aus der Partie entfernt.' });
    removePlayer(peerId);
    message = `${name} wurde entfernt.`;
    checkpoint('kick');
    pushState();
    return true;
  }

  function onWire(from, body) {
    if (!body?.wire) return;
    if (body.wire === 'join' && body.gameId === gameId) {
      if (phase !== 'lobby') {
        sendWire(from, { wire: 'join_reject', gameId, reason: 'Partie läuft bereits.' });
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
        : { wire: 'join_reject', gameId, reason: 'Partie voll oder Beitritt fehlgeschlagen.' });
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
    getLegalMovesForPeer,
    settings: cfg,
    updateSettings(patch) {
      if (phase !== 'lobby') {
        message = 'Einstellungen können nur in der Lobby geändert werden.';
        pushState();
        return;
      }
      Object.assign(cfg, sanitizeSettings(patch, cfg));
      whiteMs = cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0;
      blackMs = cfg.timeControlSec > 0 ? cfg.timeControlSec * 1000 : 0;
      message = 'Einstellungen aktualisiert.';
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
        checkpoint('manual');
        message = 'Partie gespeichert.';
        pushState();
        return true;
      }
      checkpoint('manual');
      message = 'Spielstand gespeichert.';
      pushState();
      return true;
    },
    invitePayload() {
      const timeLabel = cfg.timeControlSec > 0
        ? `${Math.round(cfg.timeControlSec / 60)} Min./Spieler`
        : 'Unbegrenzt';
      const sum = `Schach · 2 Spieler · ${timeLabel}`;
      return {
        kind: 'chess-invite',
        gameId,
        tableName: cfg.tableName,
        hostPeerId: selfId,
        chessSettings: { ...cfg },
        chessSettingsSummary: sum,
        lobbyAccess: cfg.lobbyAccess,
        content: `♟ ${cfg.tableName} — ${sum}`,
      };
    },
    startGame,
    onWire,
    removePlayer,
    kickPlayer,
    publicState,
    pushState,
    applyAction: (pid, a) => applyAction(pid, a),
    destroy() {
      clearClockTimer();
    },
  };
}
