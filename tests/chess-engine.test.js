const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadChessEngine() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'bundled-plugins', 'chess', 'ui.js'), 'utf8');
  const storage = new Map();
  const events = new Map();
  const sent = [];
  const api = {
    contacts: () => [],
    peers: () => [],
    peer: {
      send: (peerId, payload) => sent.push({ peerId, payload }),
      broadcast: () => [],
    },
    chat: { send: () => true },
    storage: {
      get: (key, fallback) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key, value) => {
        storage.set(key, JSON.parse(JSON.stringify(value)));
        return true;
      },
    },
    timer: {
      setTimeout: () => 1,
      clearTimeout: () => {},
      setInterval: () => 2,
      clearInterval: () => {},
    },
    on: (name, handler) => {
      events.set(name, handler);
      return () => events.delete(name);
    },
    onDeactivate: () => {},
    ui: { registerTab: () => {}, registerCommand: () => {} },
    notify: { toast: () => {} },
    log: { info: () => {}, error: () => {} },
  };
  const windowStub = {
    __BLUETALK_CHESS_TEST_HOOKS__: {},
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'host', name: 'Host' }) },
      chess: { onFromChild: () => () => {}, pushState: () => {}, openGameWindow: async () => {} },
    },
  };
  const execute = new Function('BlueTalkPlugin', 'window', 'document', 'crypto', 'queueMicrotask', source);
  execute(api, windowStub, {}, globalThis.crypto, queueMicrotask);
  return { hooks: windowStub.__BLUETALK_CHESS_TEST_HOOKS__, storage, sent, api };
}

test('parseFen and boardToFen round-trip start position', () => {
  const { hooks } = loadChessEngine();
  const state = hooks.createInitialState();
  assert.equal(state.turn, 'w');
  assert.equal(state.board[7][4]?.type, 'K');
  assert.equal(state.board[0][4]?.type, 'K');
  const fen = hooks.boardToFen(state);
  assert.ok(fen.startsWith('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'));
  const again = hooks.parseFen(fen);
  assert.equal(hooks.boardToFen(again), fen);
});

test('knight and pawn moves from start', () => {
  const { hooks } = loadChessEngine();
  let state = hooks.createInitialState();
  const moves = hooks.getLegalMoves(state, 'w');
  assert.ok(moves.some((m) => hooks.sqToAlg(m.from) === 'b1' && hooks.sqToAlg(m.to) === 'c3'));
  assert.ok(moves.some((m) => hooks.sqToAlg(m.from) === 'e2' && hooks.sqToAlg(m.to) === 'e4'));
  const e4 = moves.find((m) => hooks.sqToAlg(m.from) === 'e2' && hooks.sqToAlg(m.to) === 'e4');
  state = hooks.applyMove(state, e4);
  assert.equal(state.turn, 'b');
  assert.equal(state.enPassant && hooks.sqToAlg(state.enPassant), 'e3');
});

test('castling rights and kingside castling for white', () => {
  const { hooks } = loadChessEngine();
  const fen = '8/8/8/8/8/8/8/R3K2R w KQ - 0 1';
  let state = hooks.parseFen(fen);
  const moves = hooks.getLegalMoves(state, 'w');
  assert.ok(moves.some((m) => m.castle === 'K'));
  const castle = moves.find((m) => m.castle === 'K');
  state = hooks.applyMove(state, castle);
  assert.equal(state.board[7][6]?.type, 'K');
  assert.equal(state.board[7][5]?.type, 'R');
  assert.equal(state.castling.wK, false);
});

test('en passant capture', () => {
  const { hooks } = loadChessEngine();
  let state = hooks.parseFen('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 1');
  const epMove = hooks.getLegalMoves(state, 'w').find((m) => m.enPassant);
  assert.ok(epMove);
  state = hooks.applyMove(state, epMove);
  assert.equal(state.board[3][3], null);
  assert.equal(state.board[2][3]?.type, 'P');
});

test('pawn promotion requires piece choice in legal moves', () => {
  const { hooks } = loadChessEngine();
  const state = hooks.parseFen('8/4P3/8/8/8/8/8/4K2k w - - 0 1');
  const moves = hooks.getLegalMoves(state, 'w');
  const promos = moves.filter((m) => hooks.sqToAlg(m.to) === 'e8');
  assert.equal(promos.length, 4);
  assert.ok(promos.some((m) => m.promotion === 'q'));
});

test('fools mate delivers checkmate', () => {
  const { hooks } = loadChessEngine();
  let state = hooks.createInitialState();
  const w1 = hooks.normalizeMove({ from: 'f2', to: 'f3' });
  state = hooks.applyMove(state, w1);
  const b1 = hooks.normalizeMove({ from: 'e7', to: 'e5' });
  state = hooks.applyMove(state, b1);
  const w2 = hooks.normalizeMove({ from: 'g2', to: 'g4' });
  state = hooks.applyMove(state, w2);
  const b2 = hooks.normalizeMove({ from: 'd8', to: 'h4' });
  state = hooks.applyMove(state, b2);
  assert.equal(hooks.isCheckmate(state, 'w'), true);
});

test('stalemate detection', () => {
  const { hooks } = loadChessEngine();
  const state = hooks.parseFen('k7/P7/1K6/8/8/8/8/8 b - - 0 1');
  assert.equal(hooks.isStalemate(state, 'b'), true);
});

test('insufficient material draw helper', () => {
  const { hooks } = loadChessEngine();
  assert.equal(hooks.isInsufficientMaterial(hooks.parseFen('8/8/8/8/8/8/4k3/4K3 w - - 0 1')), true);
  assert.equal(hooks.isInsufficientMaterial(hooks.parseFen('8/8/8/8/8/8/4k3/4K2B w - - 0 1')), true);
  assert.equal(hooks.isInsufficientMaterial(hooks.parseFen('8/8/8/8/8/8/4k2p/4K3 w - - 0 1')), false);
});

test('createHost join flow and move validation', () => {
  const { hooks } = loadChessEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('guest', { wire: 'join', gameId: host.gameId, name: 'Guest' });
  assert.equal(host.publicState().players.length, 2);
  host.startGame();
  assert.equal(host.publicState().phase, 'playing');
  const legal = host.getLegalMovesForPeer('host');
  assert.ok(legal.length > 0);
  const first = legal[0];
  assert.equal(host.applyAction('host', { type: 'move', ...first }), true);
  assert.equal(host.applyAction('guest', { type: 'move', from: 'e7', to: 'e5' }), true);
  assert.equal(host.applyAction('guest', { type: 'move', from: 'e2', to: 'e4' }), false);
});

test('createHost resign and draw offer', () => {
  const { hooks } = loadChessEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('guest', { wire: 'join', gameId: host.gameId, name: 'Guest' });
  host.startGame();
  assert.equal(host.applyAction('host', { type: 'offerDraw' }), true);
  assert.equal(host.publicState().drawOffer, 'w');
  assert.equal(host.applyAction('guest', { type: 'acceptDraw' }), true);
  assert.equal(host.publicState().phase, 'gameOver');
  assert.equal(host.publicState().gameResult.type, 'draw');

  const host2 = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host2.bootstrapHost();
  host2.onWire('guest', { wire: 'join', gameId: host2.gameId, name: 'Guest' });
  host2.startGame();
  assert.equal(host2.applyAction('host', { type: 'resign' }), true);
  assert.equal(host2.publicState().gameResult.winnerColor, 'b');
});

test('sanitizeSettings clamps time control and max players', () => {
  const { hooks } = loadChessEngine();
  const s = hooks.sanitizeSettings({ tableName: ' Test ', timeControlSec: 99999, maxPlayers: 8 });
  assert.equal(s.tableName, 'Test');
  assert.equal(s.maxPlayers, 2);
  assert.equal(s.timeControlSec, 7200);
});
