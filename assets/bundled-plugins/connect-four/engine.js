/**
 * Vier gewinnt — Spiel-Engine (Einstellungen + host-autoritative Partie).
 *
 * `createHost` kapselt den autoritativen Spielzustand (Sitzplätze, Phasen,
 * Brett, Checkpoints). Die Anbindung an die Außenwelt (Peer-Versand,
 * Kontaktprüfung, Speicher) wird über `deps` injiziert, damit die
 * zustandsbehaftete Orchestrierung in ui.js bleibt.
 */

import {
  ROWS,
  COLS,
  MAX_PLAYERS,
  createEmptyBoard,
  cloneBoard,
  dropDisc,
  isColumnFull,
  isBoardFull,
  isValidBoardShape,
} from './board.js';
import { checkWin } from './rules.js';

export function defaultSettings() {
  return {
    tableName: 'Vier-gewinnt-Tisch',
    maxPlayers: MAX_PLAYERS,
    lobbyAccess: 'invite',
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings()) {
  const next = { ...defaultSettings(), ...fallback, ...input };
  next.tableName = String(next.tableName || 'Vier-gewinnt-Tisch').trim().slice(0, 48) || 'Vier-gewinnt-Tisch';
  next.maxPlayers = MAX_PLAYERS;
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  return next;
}

/**
 * Erzeugt einen host-autoritativen Spielzustand.
 *
 * @param {object} deps  Injizierte Abhängigkeiten:
 *   - api: Plugin-API (storage, peers, chat)
 *   - sendWire(peerId, body)
 *   - broadcastWire(body, peerIds)
 *   - isContactBlocked(peerId)
 */
export function createHost(settings, onTick, me, restoredGame = null, deps = {}) {
  const { api, sendWire, broadcastWire, isContactBlocked } = deps;
  const selfId = me?.id;
  const gameId = restoredGame?.gameId || `cf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
  const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings());
  const players = [];
  let phase = restoredGame?.phase === 'playing' || restoredGame?.phase === 'finished'
    ? restoredGame.phase
    : 'lobby';
  // Wiederhergestelltes Brett nur übernehmen, wenn es formal passt (6×7).
  let board = isValidBoardShape(restoredGame?.board)
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
