/**
 * BlueTalk Schach — Host-autoritativ, 2 Spieler, P2P.
 */
(function chessPluginUi() {
  const api = BlueTalkPlugin;

  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const PROMOTION_PIECES = ['q', 'r', 'b', 'n'];
  const TIME_CONTROL_OPTIONS = [0, 60, 180, 300, 600, 900, 1800];

  window.__BLUETALK_CHESS_TEST_HOOKS__ = window.__BLUETALK_CHESS_TEST_HOOKS__ || {};

  function clampInt(value, min, max, fallback) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function defaultSettings() {
    return {
      tableName: 'Schach-Partie',
      maxPlayers: 2,
      lobbyAccess: 'invite',
      timeControlSec: 0,
    };
  }

  function sanitizeSettings(input = {}, fallback = defaultSettings()) {
    const next = { ...defaultSettings(), ...fallback, ...input };
    next.tableName = String(next.tableName || 'Schach-Partie').trim().slice(0, 48) || 'Schach-Partie';
    next.maxPlayers = 2;
    next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
    const tc = clampInt(next.timeControlSec, 0, 7200, fallback.timeControlSec || 0);
    next.timeControlSec = TIME_CONTROL_OPTIONS.includes(tc) ? tc : (tc > 0 ? tc : 0);
    return next;
  }

  function emptyBoard() {
    return Array.from({ length: 8 }, () => Array(8).fill(null));
  }

  function cloneBoard(board) {
    return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  }

  function sq(r, c) {
    return { r, c };
  }

  function inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function sqEqual(a, b) {
    return a && b && a.r === b.r && a.c === b.c;
  }

  function sqToAlg({ r, c }) {
    return `${String.fromCharCode(97 + c)}${8 - r}`;
  }

  function algToSq(alg) {
    if (!alg || alg.length < 2) return null;
    const c = alg.charCodeAt(0) - 97;
    const rank = Number(alg.slice(1));
    if (!inBounds(8 - rank, c)) return null;
    return sq(8 - rank, c);
  }

  function createInitialState() {
    return parseFen(START_FEN);
  }

  function parseFen(fen) {
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

  function boardToFen(state) {
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

  function findKing(board, color) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.color === color && p.type === 'K') return sq(r, c);
      }
    }
    return null;
  }

  function opponent(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function pieceMoves(board, from, state, forAttackOnly = false) {
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

  function isSquareAttacked(board, square, byColor, state) {
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

  function isInCheck(state, color) {
    const king = findKing(state.board, color);
    if (!king) return false;
    return isSquareAttacked(state.board, king, opponent(color), state);
  }

  function applyMove(state, move) {
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

    if (piece.type === 'P' || captured) {
      next.halfMoveClock = 0;
    } else {
      next.halfMoveClock += 1;
    }
    if (state.turn === 'b') next.fullMoveNumber += 1;

    return next;
  }

  function movesEqual(a, b) {
    return sqEqual(a.from, b.from)
      && sqEqual(a.to, b.to)
      && (a.promotion || '') === (b.promotion || '')
      && Boolean(a.enPassant) === Boolean(b.enPassant)
      && (a.castle || '') === (b.castle || '');
  }

  function normalizeMove(input) {
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

  function getPseudoLegalMoves(state, color) {
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

  function getLegalMoves(state, color) {
    const pseudo = getPseudoLegalMoves(state, color);
    return pseudo.filter((move) => {
      const after = applyMove(state, move);
      if (!after) return false;
      return !isInCheck(after, color);
    });
  }

  function hasLegalMove(state, color) {
    return getLegalMoves(state, color).length > 0;
  }

  function isCheckmate(state, color) {
    return isInCheck(state, color) && !hasLegalMove(state, color);
  }

  function isStalemate(state, color) {
    return !isInCheck(state, color) && !hasLegalMove(state, color);
  }

  function countMaterial(board) {
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

  function isInsufficientMaterial(state) {
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

  function isFiftyMoveDraw(state) {
    return state.halfMoveClock >= 100;
  }

  function moveToWire(move) {
    return {
      from: sqToAlg(move.from),
      to: sqToAlg(move.to),
      promotion: move.promotion,
      castle: move.castle,
      enPassant: move.enPassant || false,
    };
  }

  function movesToWire(moves) {
    return moves.map(moveToWire);
  }

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'chess', chess: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isChessLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  function colorForSeat(seat) {
    return seat === 0 ? 'w' : 'b';
  }

  function seatForColor(players, color) {
    const seat = color === 'w' ? 0 : 1;
    return players.find((p) => p.seat === seat) || null;
  }

  function createHost(settings, onTick, me, restoredGame = null) {
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
      chessState = applyMove(chessState, match);
      lastMove = moveToWire(match);
      drawOffer = null;
      clockLastTick = Date.now();

      if (evaluateDrawConditions()) return true;

      const oppColor = opponent(prevTurn);
      if (isCheckmate(chessState, oppColor)) {
        endGame({ type: 'checkmate', winnerColor: prevTurn });
        return true;
      }
      if (isStalemate(chessState, oppColor)) {
        endGame({ type: 'stalemate' });
        return true;
      }

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

  Object.assign(window.__BLUETALK_CHESS_TEST_HOOKS__, {
    START_FEN,
    createInitialState,
    parseFen,
    boardToFen,
    sqToAlg,
    algToSq,
    getLegalMoves,
    applyMove,
    isInCheck,
    isCheckmate,
    isStalemate,
    isInsufficientMaterial,
    isFiftyMoveDraw,
    normalizeMove,
    createHost,
    sanitizeSettings,
  });

  let host = null;
  let hostRef = null;
  let chessSelfPeerId = '';
  let chessSelfPeerName = '';
  let clientState = null;
  let myLegalMoves = [];
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'chess',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !chessSelfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).length;
    const maxPlayers = 2;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isChessLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'chess',
      sessionId,
      tableName: pub.settings?.tableName || 'Schach-Partie',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || chessSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshChessSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      chessSelfPeerId = i?.id || '';
      chessSelfPeerName = i?.name || '';
    } catch {
      chessSelfPeerId = '';
      chessSelfPeerName = '';
    }
    return chessSelfPeerId;
  }

  function myColorFromState(pub) {
    if (!pub?.players || !chessSelfPeerId) return null;
    const me = pub.players.find((p) => p.peerId === chessSelfPeerId);
    return me?.color || null;
  }

  function tryPump() {
    if (!window.bluetalk?.chess?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.chess.pushState(null);
      clearGamePresence();
      return;
    }
    if (hostRef) {
      myLegalMoves = hostRef.getLegalMovesForPeer(chessSelfPeerId);
    } else {
      myLegalMoves = [];
    }
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.chess.pushState({
      public: pub,
      myColor: myColorFromState(pub),
      myLegalMoves,
      inviteCandidates,
    });
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.chess?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'chess' || !msg.chess) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.chess;
    const selfId = chessSelfPeerId;

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      myLegalMoves = w.legalMoves || myLegalMoves;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      if (w.public) clientState = w.public;
      api.notify.toast?.({ title: 'Schach', message: 'Der Partie beigetreten.' });
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Schach', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        myLegalMoves = [];
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myLegalMoves = [];
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'Schach', message: w.reason || 'Du wurdest aus der Partie entfernt.' });
      clientState = null;
      myLegalMoves = [];
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.chess?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.chess.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.chess.pendingJoin');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function notifyLauncherRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('bt:games-launcher-refresh'));
    } catch {
      /* ignore */
    }
  }

  async function launchHostGame(saved = null) {
    const peerInfo = await window.bluetalk?.peer?.getInfo?.();
    if (!peerInfo?.id) {
      api.notify.toast?.({ title: 'Schach', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    chessSelfPeerId = peerInfo.id;
    chessSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('chessSettings', defaultSettings());
    host = createHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    myLegalMoves = host.getLegalMovesForPeer(chessSelfPeerId);
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshChessSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedChessGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Schach-Partie',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function bootstrapPendingJoin() {
    await refreshChessSelfId();
    const pending = tryConsumePendingJoin();
    if (pending?.hostPeerId && pending?.gameId && !host && !clientState) {
      clientState = {
        gameId: pending.gameId,
        hostPeerId: pending.hostPeerId,
        phase: 'lobby',
        players: [],
        settings: sanitizeSettings(pending.chessSettings || {}),
        message: 'Verbindung zur Partie wird hergestellt…',
      };
      sendWire(pending.hostPeerId, {
        wire: 'join',
        gameId: pending.gameId,
        name: chessSelfPeerName || 'Spieler',
      });
      await openGameWindowIfNeeded();
      tryPump();
      notifyLauncherRefresh();
    }
  }

  const offChessMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'chess' || !msg.chess || isContactBlocked(msg.from)) return;
    if (host && msg.from !== chessSelfPeerId) host.onWire(msg.from, msg.chess);
    handleWire(msg);
  });
  const offChessDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offChessConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: chessSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChessChild = null;
  if (window.bluetalk?.chess?.onFromChild) {
    offChessChild = window.bluetalk.chess.onFromChild((payload) => {
      if (!payload) return;
      const pid = chessSelfPeerId;

      if (payload.type === 'request_state') {
        tryPump();
      } else if (payload.type === 'action' && payload.action) {
        if (hostRef) {
          hostRef.applyAction(pid, payload.action);
        } else if (clientState?.hostPeerId && clientState?.gameId) {
          sendWire(clientState.hostPeerId, {
            wire: 'action',
            gameId: clientState.gameId,
            action: payload.action,
          });
        }
      } else if (payload.type === 'host_start') {
        if (hostRef) hostRef.startGame();
      } else if (payload.type === 'leave') {
        if (hostRef) {
          broadcastWire({ wire: 'leave', gameId: hostRef.gameId }, hostRef.publicState().players.map((p) => p.peerId));
          hostRef.destroy();
          hostRef = null;
          host = null;
        } else if (clientState?.hostPeerId) {
          sendWire(clientState.hostPeerId, { wire: 'leave', gameId: clientState.gameId });
        }
        clearGamePresence();
        clientState = null;
        myLegalMoves = [];
        tryPump();
        notifyLauncherRefresh();
      } else if (payload.type === 'update_settings' && payload.settings) {
        hostRef?.updateSettings(payload.settings);
      } else if (payload.type === 'invite' && payload.peerId) {
        hostRef?.invitePeer(payload.peerId);
      } else if (payload.type === 'save_game') {
        hostRef?.saveNow();
      } else if (payload.type === 'kick_player' && payload.peerId) {
        hostRef?.kickPlayer(payload.peerId);
      }
    });
  }

  void refreshChessSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedChessGame', null)));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offChessChild?.();
    offChessMessage?.();
    offChessDisconnect?.();
    offChessConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
  });

  api.log.info('Schach-Plugin UI geladen');
})();
