/**
 * Tic-Tac-Toe — Künstliche Intelligenz.
 *
 * Enthält den klassischen Algorithmus (Leicht / Mittel / Schwer, Minimax mit
 * Alpha-Beta + Heuristik) sowie die selbsttrainierte KI (Selbstlern-Modell für
 * das klassische 3×3-Feld). Alles reine Funktionen ohne Zustand oder Host-Bezug.
 */

import {
  applyMove,
  isBoardFull,
  listEmptyCells,
} from './board.js';
import { checkWin, findWinningMove } from './rules.js';

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
export function aiSearchDepth(boardSize, difficulty) {
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

export function randomCell(empties) {
  return empties[Math.floor(Math.random() * empties.length)];
}

export function chooseAiMove(board, winLength, aiDisc, humanDisc, difficulty, model = null) {
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
// 0 Remis) — ausschließlich aus Partien, die der Spieler selbst gegen das
// Modell spielt (learnFromGame); ein Selbstspiel-Training gibt es nicht.
// Die Zugwahl erfolgt negamax-artig: mein Wert eines Zuges ist der
// negierte Wert der Folgestellung aus Gegnersicht.

export function emptyModel() {
  return { version: 1, V: {}, games: 0, wins: 0, losses: 0, draws: 0, updatedAt: 0 };
}

export function isTrainableBoard(board, winLength) {
  return board.length === 3 && Number(winLength) === 3;
}

export function modelKey(board, moverDisc, oppDisc) {
  let s = '';
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      const v = board[r][c];
      s += v === moverDisc ? '2' : v === oppDisc ? '1' : '0';
    }
  }
  return s;
}

export function chooseTrainedMove(board, winLength, aiDisc, humanDisc, model, epsilon = 0) {
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

// Rückführung einer real gespielten Partie (Mensch gegen trainierte KI).
// history: [{ key, disc }] in Zugreihenfolge, winnerDisc = Siegerscheibe|null.
export function learnFromGame(model, history, winnerDisc, alpha = 0.15) {
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
