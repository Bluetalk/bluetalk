/**
 * Vier gewinnt — Spielfeld & Grunddaten.
 *
 * Reine Datenlogik ohne Zustand: Brettmaße und Operationen (anlegen, klonen,
 * Stein einwerfen, Spalten-/Brettfüllung). Als eigenständiges ES-Modul auch in
 * Node importierbar (keine Browser-Globals).
 */

export const ROWS = 6;
export const COLS = 7;
export const MAX_PLAYERS = 2;

export function createEmptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

export function cloneBoard(board) {
  return board.map((row) => row.slice());
}

// Wirft einen Stein in die Spalte. Mutiert das übergebene Brett (der Host führt
// den autoritativen Zustand) und liefert die belegte Position zurück.
export function dropDisc(board, col, player) {
  if (col < 0 || col >= COLS || player < 1 || player > 2) return null;
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    if (board[row][col] === 0) {
      board[row][col] = player;
      return { row, col };
    }
  }
  return null;
}

export function isColumnFull(board, col) {
  return board[0][col] !== 0;
}

export function isBoardFull(board) {
  for (let col = 0; col < COLS; col += 1) {
    if (!isColumnFull(board, col)) return false;
  }
  return true;
}

/**
 * Prüft, ob ein wiederhergestelltes Brett formal zur erwarteten Größe passt
 * (6 Zeilen à 7 Spalten). Schützt Restore-Pfade vor beschädigten Spielständen.
 */
export function isValidBoardShape(board) {
  return Array.isArray(board)
    && board.length === ROWS
    && board.every((r) => Array.isArray(r) && r.length === COLS);
}
