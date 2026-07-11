/**
 * Vier gewinnt — Regeln: Vier-in-einer-Reihe-Siegprüfung.
 *
 * Reine Funktion; geht vom zuletzt gesetzten Stein aus und zählt
 * zusammenhängende gleiche Steine in alle vier Achsen.
 */

import { ROWS, COLS } from './board.js';

export function checkWin(board, row, col, player) {
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
