const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadTicTacToeEngine() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'bundled-plugins', 'tic-tac-toe', 'ui.js'),
    'utf8'
  );
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
    __BLUETALK_TICTACTOE_TEST_HOOKS__: {},
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'host', name: 'Host' }) },
      ticTacToe: { onFromChild: () => () => {}, pushState: () => {}, openGameWindow: async () => {} },
    },
  };
  const execute = new Function('BlueTalkPlugin', 'window', 'document', 'crypto', 'queueMicrotask', source);
  execute(api, windowStub, {}, globalThis.crypto, queueMicrotask);
  return { hooks: windowStub.__BLUETALK_TICTACTOE_TEST_HOOKS__, storage, sent };
}

test('sanitizeSettings clamps board, win length and players', () => {
  const { hooks } = loadTicTacToeEngine();
  const s = hooks.sanitizeSettings({
    boardSize: 99,
    winLength: 9,
    maxPlayers: 8,
    playMode: 'online',
    aiDifficulty: 'unknown',
  });
  assert.equal(s.boardSize, 3);
  assert.equal(s.winLength, 3);
  assert.equal(s.maxPlayers, 4);
  assert.equal(s.aiDifficulty, 'medium');

  const solo = hooks.sanitizeSettings({ playMode: 'solo', maxPlayers: 4 });
  assert.equal(solo.maxPlayers, 2);
  assert.equal(solo.playMode, 'solo');
});

test('checkWin detects horizontal and diagonal wins', () => {
  const { hooks } = loadTicTacToeEngine();
  let board = hooks.createEmptyBoard(3);
  board[1][0] = 1;
  board[1][1] = 1;
  board[1][2] = 1;
  const rowWin = hooks.checkWin(board, 3, { row: 1, col: 2 });
  assert.equal(rowWin?.winner, 1);
  assert.equal(rowWin?.cells?.length, 3);

  board = hooks.createEmptyBoard(5);
  board[0][0] = 2;
  board[1][1] = 2;
  board[2][2] = 2;
  board[3][3] = 2;
  const diagWin = hooks.checkWin(board, 4, { row: 3, col: 3 });
  assert.equal(diagWin?.winner, 2);
});

test('applyMove rejects occupied and out-of-bounds cells', () => {
  const { hooks } = loadTicTacToeEngine();
  const board = hooks.createEmptyBoard(3);
  const next = hooks.applyMove(board, 1, 1, 1);
  assert.ok(next);
  assert.equal(next[1][1], 1);
  assert.equal(hooks.applyMove(next, 1, 1, 2), null);
  assert.equal(hooks.applyMove(board, 5, 5, 1), null);
});

test('chooseAiMove blocks immediate human win on 3x3', () => {
  const { hooks } = loadTicTacToeEngine();
  const board = hooks.createEmptyBoard(3);
  board[0][0] = 1;
  board[0][1] = 1;
  const move = hooks.chooseAiMove(board, 3, 2, 1, 'hard');
  assert.deepEqual(move, { row: 0, col: 2 });
});

test('host solo game starts with human and AI', () => {
  const { hooks } = loadTicTacToeEngine();
  const host = hooks.createHost(
    { playMode: 'solo', boardSize: 3, winLength: 3 },
    () => {},
    { id: 'host', name: 'Host' }
  );
  host.bootstrapHost();
  assert.ok(host.startGame());
  const pub = host.publicState();
  assert.equal(pub.phase, 'playing');
  assert.equal(pub.players.length, 2);
  assert.ok(pub.players.some((p) => p.isAi));
});

test('host online game validates turns and detects win', () => {
  const { hooks } = loadTicTacToeEngine();
  const host = hooks.createHost(
    { playMode: 'online', boardSize: 3, winLength: 3, maxPlayers: 2, lobbyAccess: 'public' },
    () => {},
    { id: 'host', name: 'Host' }
  );
  host.bootstrapHost();
  host.onWire('guest', { wire: 'join', gameId: host.gameId, name: 'Guest' });
  assert.ok(host.startGame());

  const pub = host.publicState();
  const hostPlayer = pub.players.find((p) => p.peerId === 'host');
  const guestPlayer = pub.players.find((p) => p.peerId === 'guest');
  assert.ok(hostPlayer);
  assert.ok(guestPlayer);

  assert.ok(host.applyAction(hostPlayer.peerId, { type: 'place', row: 0, col: 0 }));
  assert.ok(host.applyAction(guestPlayer.peerId, { type: 'place', row: 0, col: 1 }));
  assert.ok(host.applyAction(hostPlayer.peerId, { type: 'place', row: 1, col: 0 }));
  assert.ok(host.applyAction(guestPlayer.peerId, { type: 'place', row: 1, col: 1 }));
  assert.ok(host.applyAction(hostPlayer.peerId, { type: 'place', row: 2, col: 0 }));
  assert.equal(host.publicState().phase, 'finished');
  assert.equal(host.publicState().winnerPeerId, 'host');
});

test('sanitizeSettings forces 3x3 for the trained AI', () => {
  const { hooks } = loadTicTacToeEngine();
  const s = hooks.sanitizeSettings({
    playMode: 'solo',
    aiDifficulty: 'trained',
    boardSize: 7,
    winLength: 5,
  });
  assert.equal(s.aiDifficulty, 'trained');
  assert.equal(s.boardSize, 3);
  assert.equal(s.winLength, 3);
});

test('chooseTrainedMove takes an immediate win and blanks on unknown states', () => {
  const { hooks } = loadTicTacToeEngine();
  const model = hooks.emptyModel();
  // AI (disc 2) can complete a row on the top edge.
  const board = hooks.createEmptyBoard(3);
  board[0][0] = 2;
  board[0][1] = 2;
  const win = hooks.chooseTrainedMove(board, 3, 2, 1, model);
  assert.deepEqual(win, { row: 0, col: 2 });

  // Empty model + no tactical move => null so the caller can fall back.
  const quiet = hooks.createEmptyBoard(3);
  quiet[1][1] = 1;
  assert.equal(hooks.chooseTrainedMove(quiet, 3, 2, 1, model), null);
});

test('chooseAiMove trained falls back to heuristic block without a model', () => {
  const { hooks } = loadTicTacToeEngine();
  const board = hooks.createEmptyBoard(3);
  board[0][0] = 1;
  board[0][1] = 1;
  const move = hooks.chooseAiMove(board, 3, 2, 1, 'trained', hooks.emptyModel());
  assert.deepEqual(move, { row: 0, col: 2 });
});

test('trainSelfPlay learns state values through self-play', () => {
  const { hooks } = loadTicTacToeEngine();
  const model = hooks.emptyModel();
  hooks.trainSelfPlay(model, 400);
  assert.equal(model.games, 400);
  const keys = Object.keys(model.V);
  assert.ok(keys.length > 20, 'should have learned many states');
  const values = keys.map((k) => model.V[k]);
  assert.ok(values.some((v) => v > 0), 'some winning states valued positively');
  assert.ok(values.some((v) => v < 0), 'some losing states valued negatively');
});

test('learnFromGame updates values from a played game', () => {
  const { hooks } = loadTicTacToeEngine();
  const model = hooks.emptyModel();
  const board = hooks.createEmptyBoard(3);
  const history = [
    { key: hooks.modelKey(board, 1, 2), disc: 1 },
  ];
  hooks.learnFromGame(model, history, 1);
  assert.equal(model.games, 1);
  assert.ok(model.V[history[0].key] > 0, 'winner move state valued positively');
});

test('solo host exposes an AI model summary', () => {
  const { hooks } = loadTicTacToeEngine();
  const host = hooks.createHost(
    { playMode: 'solo', boardSize: 3, winLength: 3, aiDifficulty: 'trained' },
    () => {},
    { id: 'host', name: 'Host' }
  );
  host.bootstrapHost();
  const pub = host.publicState();
  assert.ok(pub.aiModel);
  assert.equal(pub.aiModel.available, false);
  assert.equal(pub.aiModel.games, 0);
});

test('settingsSummary describes mode and board', () => {
  const { hooks } = loadTicTacToeEngine();
  const summary = hooks.settingsSummary({
    boardSize: 5,
    winLength: 4,
    playMode: 'online',
    maxPlayers: 3,
  });
  assert.match(summary, /5×5/);
  assert.match(summary, /4 in einer Reihe/);
  assert.match(summary, /max\. 3/);
});
