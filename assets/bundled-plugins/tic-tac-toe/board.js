/**
 * Tic-Tac-Toe — Spielfeld & Grunddaten.
 *
 * Reine Datenlogik ohne Zustand: Feldgrößen, Spielermarken und Operationen auf
 * dem Brett (anlegen, klonen, Zug anwenden, freie Felder). Als eigenständiges
 * ES-Modul auch in Node importierbar (keine Browser-Globals).
 */

// Kennung des lokalen KI-Sitzplatzes (Solo gegen den Algorithmus).
export const AI_PEER_ID = '__ttt_ai__';

// Unterstützte quadratische Feldgrößen und wählbare Gewinnlängen.
export const BOARD_SIZES = [3, 5, 7];
export const WIN_LENGTHS = [3, 4, 5];

// Marken für bis zu vier Sitzplätze (disc 1..4).
export const PLAYER_MARKS = ['X', 'O', '△', '□'];

export function createEmptyBoard(size) {
  const n = Number(size) || 3;
  return Array.from({ length: n }, () => Array(n).fill(0));
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

export function applyMove(board, row, col, player) {
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

export function isBoardFull(board) {
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      if (board[r][c] === 0) return false;
    }
  }
  return true;
}

export function listEmptyCells(board) {
  const cells = [];
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      if (board[r][c] === 0) cells.push({ row: r, col: c });
    }
  }
  return cells;
}

/**
 * Prüft, ob ein wiederhergestelltes Brett zur erwarteten quadratischen Größe
 * passt (jede Zeile exakt so lang wie die Feldgröße). Schützt Restore-Pfade auf
 * großen Feldern vor beschädigten Spielständen.
 */
export function isValidBoardShape(board, size) {
  const n = Number(size) || 0;
  return Array.isArray(board)
    && board.length === n
    && board.every((r) => Array.isArray(r) && r.length === n);
}
