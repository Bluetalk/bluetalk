/**
 * Tic-Tac-Toe — Regeln: konfigurierbare n-in-einer-Reihe-Siegprüfung.
 *
 * Reine Funktionen; auf jeder Feldgröße gültig. Die Siegprüfung geht immer vom
 * zuletzt gesetzten Stein aus und zählt zusammenhängende gleiche Steine in beide
 * Richtungen — dadurch skaliert sie auch auf großen Feldern korrekt.
 */

import { applyMove, listEmptyCells } from './board.js';

export function checkWin(board, winLength, lastMove) {
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

export function findWinningMove(board, winLength, player) {
  const empties = listEmptyCells(board);
  for (const cell of empties) {
    const next = applyMove(board, cell.row, cell.col, player);
    if (next && checkWin(next, winLength, cell)) return cell;
  }
  return null;
}
