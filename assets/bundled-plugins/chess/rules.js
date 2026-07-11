/**
 * BlueTalk Schach — Regeln: Zug-Anwendung, Legalität, Schach/Matt/Patt,
 * Remis-Bedingungen, SAN-Notation. Reine Logik.
 */
import {
  sq,
  sqEqual,
  sqToAlg,
  algToSq,
  cloneBoard,
  findKing,
  opponent,
  PROMOTION_PIECES,
} from './board.js';
import {
  pieceMoves,
  isSquareAttacked,
  getPseudoLegalMoves,
} from './moves.js';

export function isInCheck(state, color) {
  const king = findKing(state.board, color);
  if (!king) return false;
  return isSquareAttacked(state.board, king, opponent(color), state);
}

export function applyMove(state, move) {
  const next = {
    board: cloneBoard(state.board),
    turn: opponent(state.turn),
    castling: { ...state.castling },
    enPassant: null,
    halfMoveClock: state.halfMoveClock,
    fullMoveNumber: state.fullMoveNumber,
  };
  const piece = next.board[move.from.r][move.from.c];
  if (!piece) return null;
  const captured = next.board[move.to.r][move.to.c];
  next.board[move.from.r][move.from.c] = null;

  if (move.enPassant) {
    const capRow = piece.color === 'w' ? move.to.r + 1 : move.to.r - 1;
    next.board[capRow][move.to.c] = null;
  }

  if (move.castle === 'K') {
    const rank = piece.color === 'w' ? 7 : 0;
    next.board[rank][5] = next.board[rank][7];
    next.board[rank][7] = null;
  } else if (move.castle === 'Q') {
    const rank = piece.color === 'w' ? 7 : 0;
    next.board[rank][3] = next.board[rank][0];
    next.board[rank][0] = null;
  }

  let placed = { ...piece };
  if (piece.type === 'P' && move.promotion) {
    placed = { color: piece.color, type: move.promotion.toUpperCase() };
  }
  next.board[move.to.r][move.to.c] = placed;

  if (piece.type === 'P' && Math.abs(move.to.r - move.from.r) === 2) {
    next.enPassant = sq((move.from.r + move.to.r) / 2, move.from.c);
  }

  if (piece.type === 'K') {
    if (piece.color === 'w') {
      next.castling.wK = false;
      next.castling.wQ = false;
    } else {
      next.castling.bK = false;
      next.castling.bQ = false;
    }
  }
  if (piece.type === 'R') {
    if (piece.color === 'w' && move.from.c === 0) next.castling.wQ = false;
    if (piece.color === 'w' && move.from.c === 7) next.castling.wK = false;
    if (piece.color === 'b' && move.from.c === 0) next.castling.bQ = false;
    if (piece.color === 'b' && move.from.c === 7) next.castling.bK = false;
  }
  // Wird ein Turm auf seinem Ausgangsfeld geschlagen, verfällt das dortige
  // Rochaderecht (sonst bliebe es fälschlich im FEN erhalten).
  if (move.to.r === 7 && move.to.c === 0) next.castling.wQ = false;
  if (move.to.r === 7 && move.to.c === 7) next.castling.wK = false;
  if (move.to.r === 0 && move.to.c === 0) next.castling.bQ = false;
  if (move.to.r === 0 && move.to.c === 7) next.castling.bK = false;

  if (piece.type === 'P' || captured) {
    next.halfMoveClock = 0;
  } else {
    next.halfMoveClock += 1;
  }
  if (state.turn === 'b') next.fullMoveNumber += 1;

  return next;
}

export function movesEqual(a, b) {
  return sqEqual(a.from, b.from)
    && sqEqual(a.to, b.to)
    && (a.promotion || '') === (b.promotion || '')
    && Boolean(a.enPassant) === Boolean(b.enPassant)
    && (a.castle || '') === (b.castle || '');
}

export function normalizeMove(input) {
  if (!input) return null;
  const from = typeof input.from === 'string' ? algToSq(input.from) : input.from;
  const to = typeof input.to === 'string' ? algToSq(input.to) : input.to;
  if (!from || !to) return null;
  const promotion = input.promotion ? String(input.promotion).toLowerCase()[0] : undefined;
  return {
    from,
    to,
    promotion: PROMOTION_PIECES.includes(promotion) ? promotion : undefined,
    enPassant: input.enPassant === true,
    castle: input.castle,
  };
}

export function getLegalMoves(state, color) {
  const pseudo = getPseudoLegalMoves(state, color);
  return pseudo.filter((move) => {
    const after = applyMove(state, move);
    if (!after) return false;
    return !isInCheck(after, color);
  });
}

export function hasLegalMove(state, color) {
  return getLegalMoves(state, color).length > 0;
}

export function isCheckmate(state, color) {
  return isInCheck(state, color) && !hasLegalMove(state, color);
}

export function isStalemate(state, color) {
  return !isInCheck(state, color) && !hasLegalMove(state, color);
}

export function countMaterial(board) {
  const vals = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
  let w = 0;
  let b = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.type === 'K') continue;
      const v = vals[p.type] || 0;
      if (p.color === 'w') w += v;
      else b += v;
    }
  }
  return { w, b };
}

export function isInsufficientMaterial(state) {
  const pieces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = state.board[r][c];
      if (p) pieces.push(p);
    }
  }
  if (pieces.length > 4) return false;
  const nonKings = pieces.filter((p) => p.type !== 'K');
  if (nonKings.length === 0) return true;
  if (nonKings.length === 1 && (nonKings[0].type === 'B' || nonKings[0].type === 'N')) return true;
  if (nonKings.length === 2
    && nonKings[0].type === 'B' && nonKings[1].type === 'B'
    && nonKings[0].color !== nonKings[1].color) {
    const squares = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = state.board[r][c];
        if (p && p.type === 'B') squares.push((r + c) % 2);
      }
    }
    if (squares.length === 2 && squares[0] === squares[1]) return true;
  }
  return false;
}

export function isFiftyMoveDraw(state) {
  return state.halfMoveClock >= 100;
}

export function moveToSan(state, move) {
  const piece = state.board[move.from.r][move.from.c];
  if (!piece) return '';
  if (move.castle === 'K') return 'O-O';
  if (move.castle === 'Q') return 'O-O-O';
  const target = state.board[move.to.r][move.to.c];
  const isCapture = Boolean(target) || move.enPassant === true;
  let san = '';
  if (piece.type === 'P') {
    if (isCapture) san += `${String.fromCharCode(97 + move.from.c)}x`;
    san += sqToAlg(move.to);
    if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
    return san;
  }
  san += piece.type;
  const rivals = getLegalMoves(state, piece.color).filter((m) => !sqEqual(m.from, move.from)
    && sqEqual(m.to, move.to)
    && state.board[m.from.r][m.from.c]?.type === piece.type);
  if (rivals.length) {
    const sameFile = rivals.some((m) => m.from.c === move.from.c);
    const sameRank = rivals.some((m) => m.from.r === move.from.r);
    if (!sameFile) san += String.fromCharCode(97 + move.from.c);
    else if (!sameRank) san += String(8 - move.from.r);
    else san += sqToAlg(move.from);
  }
  if (isCapture) san += 'x';
  san += sqToAlg(move.to);
  return san;
}

export function moveToWire(move) {
  return {
    from: sqToAlg(move.from),
    to: sqToAlg(move.to),
    promotion: move.promotion,
    castle: move.castle,
    enPassant: move.enPassant || false,
  };
}

export function movesToWire(moves) {
  return moves.map(moveToWire);
}
