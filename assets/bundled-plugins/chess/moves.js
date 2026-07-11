/**
 * BlueTalk Schach — Zuggenerierung & Feld-Angriff pro Figur (pseudo-legal).
 * pieceMoves und isSquareAttacked sind wechselseitig rekursiv (Rochade prüft
 * Angriffe), daher im selben Modul.
 */
import { sq, inBounds, sqEqual, opponent, PROMOTION_PIECES } from './board.js';

export function pieceMoves(board, from, state, forAttackOnly = false) {
  const piece = board[from.r][from.c];
  if (!piece) return [];
  const moves = [];
  const { color, type } = piece;
  const dir = color === 'w' ? -1 : 1;
  const startRank = color === 'w' ? 6 : 1;
  const promoRank = color === 'w' ? 0 : 7;

  const add = (to, extra = {}) => {
    if (!inBounds(to.r, to.c)) return;
    const target = board[to.r][to.c];
    if (target && target.color === color) return;
    moves.push({ from, to, ...extra });
  };

  if (type === 'P') {
    const one = sq(from.r + dir, from.c);
    if (inBounds(one.r, one.c) && !board[one.r][one.c]) {
      if (one.r === promoRank) {
        for (const promotion of PROMOTION_PIECES) add(one, { promotion });
      } else {
        add(one);
      }
      if (from.r === startRank) {
        const two = sq(from.r + 2 * dir, from.c);
        if (!board[two.r][two.c]) add(two);
      }
    }
    for (const dc of [-1, 1]) {
      const cap = sq(from.r + dir, from.c + dc);
      if (!inBounds(cap.r, cap.c)) continue;
      const target = board[cap.r][cap.c];
      if (target && target.color !== color) {
        if (cap.r === promoRank) {
          for (const promotion of PROMOTION_PIECES) add(cap, { promotion });
        } else {
          add(cap);
        }
      } else if (
        state.enPassant
        && state.enPassant.r === cap.r
        && state.enPassant.c === cap.c
      ) {
        add(cap, { enPassant: true });
      }
    }
    return moves;
  }

  if (type === 'N') {
    const jumps = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, dc] of jumps) add(sq(from.r + dr, from.c + dc));
    return moves;
  }

  if (type === 'K') {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        add(sq(from.r + dr, from.c + dc));
      }
    }
    if (forAttackOnly) return moves;
    const opp = opponent(color);
    if (isSquareAttacked(board, from, opp, { ...state, enPassant: null })) return moves;
    const homeRank = color === 'w' ? 7 : 0;
    if (from.r === homeRank && from.c === 4) {
      if (color === 'w' && state.castling.wK
        && !board[7][5] && !board[7][6]
        && board[7][7]?.color === 'w' && board[7][7]?.type === 'R'
        && !isSquareAttacked(board, sq(7, 5), opp, { ...state, enPassant: null })
        && !isSquareAttacked(board, sq(7, 6), opp, { ...state, enPassant: null })) {
        moves.push({ from, to: sq(7, 6), castle: 'K' });
      }
      if (color === 'w' && state.castling.wQ
        && !board[7][1] && !board[7][2] && !board[7][3]
        && board[7][0]?.color === 'w' && board[7][0]?.type === 'R'
        && !isSquareAttacked(board, sq(7, 2), opp, { ...state, enPassant: null })
        && !isSquareAttacked(board, sq(7, 3), opp, { ...state, enPassant: null })) {
        moves.push({ from, to: sq(7, 2), castle: 'Q' });
      }
      if (color === 'b' && state.castling.bK
        && !board[0][5] && !board[0][6]
        && board[0][7]?.color === 'b' && board[0][7]?.type === 'R'
        && !isSquareAttacked(board, sq(0, 5), opp, { ...state, enPassant: null })
        && !isSquareAttacked(board, sq(0, 6), opp, { ...state, enPassant: null })) {
        moves.push({ from, to: sq(0, 6), castle: 'K' });
      }
      if (color === 'b' && state.castling.bQ
        && !board[0][1] && !board[0][2] && !board[0][3]
        && board[0][0]?.color === 'b' && board[0][0]?.type === 'R'
        && !isSquareAttacked(board, sq(0, 2), opp, { ...state, enPassant: null })
        && !isSquareAttacked(board, sq(0, 3), opp, { ...state, enPassant: null })) {
        moves.push({ from, to: sq(0, 2), castle: 'Q' });
      }
    }
    return moves;
  }

  const rays = type === 'B' || type === 'Q'
    ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
    : [];
  const lines = type === 'R' || type === 'Q'
    ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
    : [];
  for (const [dr, dc] of [...rays, ...lines]) {
    let nr = from.r + dr;
    let nc = from.c + dc;
    while (inBounds(nr, nc)) {
      const target = board[nr][nc];
      if (!target) {
        add(sq(nr, nc));
      } else {
        if (target.color !== color) add(sq(nr, nc));
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
  return moves;
}

export function isSquareAttacked(board, square, byColor, state) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.color !== byColor) continue;
      const from = sq(r, c);
      if (p.type === 'P') {
        const dir = byColor === 'w' ? -1 : 1;
        for (const dc of [-1, 1]) {
          const tr = r + dir;
          const tc = c + dc;
          if (tr === square.r && tc === square.c) return true;
        }
        continue;
      }
      if (p.type === 'K') {
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            if (r + dr === square.r && c + dc === square.c) return true;
          }
        }
        continue;
      }
      const moves = pieceMoves(board, from, state, true);
      if (moves.some((m) => sqEqual(m.to, square))) return true;
    }
  }
  return false;
}

export function getPseudoLegalMoves(state, color) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (!p || p.color !== color) continue;
      moves.push(...pieceMoves(state.board, sq(r, c), state));
    }
  }
  return moves;
}
