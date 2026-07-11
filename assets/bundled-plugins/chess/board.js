/**
 * BlueTalk Schach — Brett-Setup, Feld-Notation & Einstellungen.
 * Reine Logik ohne Host-/Netzwerk-Bezug.
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];
export const TIME_CONTROL_OPTIONS = [0, 60, 180, 300, 600, 900, 1800];

export function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function defaultSettings() {
  return {
    tableName: 'Schach-Partie',
    maxPlayers: 2,
    lobbyAccess: 'invite',
    timeControlSec: 0,
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings()) {
  const next = { ...defaultSettings(), ...fallback, ...input };
  next.tableName = String(next.tableName || 'Schach-Partie').trim().slice(0, 48) || 'Schach-Partie';
  next.maxPlayers = 2;
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  const tc = clampInt(next.timeControlSec, 0, 7200, fallback.timeControlSec || 0);
  next.timeControlSec = TIME_CONTROL_OPTIONS.includes(tc) ? tc : (tc > 0 ? tc : 0);
  return next;
}

export function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

export function cloneBoard(board) {
  return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
}

export function sq(r, c) {
  return { r, c };
}

export function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

export function sqEqual(a, b) {
  return a && b && a.r === b.r && a.c === b.c;
}

export function sqToAlg({ r, c }) {
  return `${String.fromCharCode(97 + c)}${8 - r}`;
}

export function algToSq(alg) {
  if (!alg || alg.length < 2) return null;
  const c = alg.charCodeAt(0) - 97;
  const rank = Number(alg.slice(1));
  if (!inBounds(8 - rank, c)) return null;
  return sq(8 - rank, c);
}

export function findKing(board, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.color === color && p.type === 'K') return sq(r, c);
    }
  }
  return null;
}

export function opponent(color) {
  return color === 'w' ? 'b' : 'w';
}

export function createInitialState() {
  return parseFen(START_FEN);
}

export function parseFen(fen) {
  const parts = String(fen || START_FEN).trim().split(/\s+/);
  const rows = (parts[0] || START_FEN.split(/\s+/)[0]).split('/');
  const board = emptyBoard();
  for (let r = 0; r < 8; r++) {
    let c = 0;
    for (const ch of rows[r] || '') {
      if (ch >= '1' && ch <= '8') {
        c += Number(ch);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        const type = ch.toUpperCase();
        board[r][c] = { color, type };
        c += 1;
      }
    }
  }
  const turn = parts[1] === 'b' ? 'b' : 'w';
  const castlingStr = parts[2] || 'KQkq';
  const castling = {
    wK: castlingStr.includes('K'),
    wQ: castlingStr.includes('Q'),
    bK: castlingStr.includes('k'),
    bQ: castlingStr.includes('q'),
  };
  let enPassant = null;
  if (parts[3] && parts[3] !== '-') {
    enPassant = algToSq(parts[3]);
  }
  const halfMoveClock = clampInt(parts[4], 0, 1000, 0);
  const fullMoveNumber = clampInt(parts[5], 1, 100000, 1);
  return { board, turn, castling, enPassant, halfMoveClock, fullMoveNumber };
}

export function boardToFen(state) {
  const { board, turn, castling, enPassant, halfMoveClock, fullMoveNumber } = state;
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p) {
        empty += 1;
      } else {
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        const ch = p.type;
        row += p.color === 'w' ? ch : ch.toLowerCase();
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  let castle = '';
  if (castling.wK) castle += 'K';
  if (castling.wQ) castle += 'Q';
  if (castling.bK) castle += 'k';
  if (castling.bQ) castle += 'q';
  if (!castle) castle = '-';
  const ep = enPassant ? sqToAlg(enPassant) : '-';
  return `${rows.join('/') } ${turn} ${castle} ${ep} ${halfMoveClock} ${fullMoveNumber}`;
}

export function colorForSeat(seat) {
  return seat === 0 ? 'w' : 'b';
}

export function seatForColor(players, color) {
  const seat = color === 'w' ? 0 : 1;
  return players.find((p) => p.seat === seat) || null;
}
