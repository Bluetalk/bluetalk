const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadConnectFourEngine() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'bundled-plugins', 'connect-four', 'ui.js'),
    'utf8',
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
    __BLUETALK_CONNECTFOUR_TEST_HOOKS__: {},
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'host', name: 'Host' }) },
      connectFour: { onFromChild: () => () => {}, pushState: () => {}, openGameWindow: async () => {} },
    },
  };
  const execute = new Function('BlueTalkPlugin', 'window', 'document', 'crypto', 'queueMicrotask', source);
  execute(api, windowStub, {}, globalThis.crypto, queueMicrotask);
  return { hooks: windowStub.__BLUETALK_CONNECTFOUR_TEST_HOOKS__, storage, sent };
}

test('createEmptyBoard is 6x7 filled with zeros', () => {
  const { hooks } = loadConnectFourEngine();
  const board = hooks.createEmptyBoard();
  assert.equal(board.length, hooks.ROWS);
  assert.equal(board[0].length, hooks.COLS);
  assert.ok(board.every((row) => row.every((cell) => cell === 0)));
});

test('dropDisc places disc at lowest empty row', () => {
  const { hooks } = loadConnectFourEngine();
  const board = hooks.createEmptyBoard();
  const placed = hooks.dropDisc(board, 3, 1);
  assert.deepEqual(placed, { row: 5, col: 3 });
  assert.equal(board[5][3], 1);
  hooks.dropDisc(board, 3, 2);
  assert.equal(board[4][3], 2);
  assert.equal(board[5][3], 1);
});

test('dropDisc returns null for full column', () => {
  const { hooks } = loadConnectFourEngine();
  const board = hooks.createEmptyBoard();
  for (let i = 0; i < hooks.ROWS; i += 1) {
    board[i][0] = i % 2 === 0 ? 1 : 2;
  }
  assert.equal(hooks.dropDisc(board, 0, 1), null);
  assert.equal(hooks.isColumnFull(board, 0), true);
});

test('checkWin detects horizontal, vertical and diagonal wins', () => {
  const { hooks } = loadConnectFourEngine();
  const board = hooks.createEmptyBoard();

  for (let col = 0; col < 4; col += 1) {
    board[5][col] = 1;
  }
  assert.equal(hooks.checkWin(board, 5, 3, 1)?.length, 4);

  const vertical = hooks.createEmptyBoard();
  for (let row = 2; row < 6; row += 1) {
    vertical[row][2] = 2;
  }
  assert.equal(hooks.checkWin(vertical, 5, 2, 2)?.length, 4);

  const diagonal = hooks.createEmptyBoard();
  diagonal[5][0] = 1;
  diagonal[4][1] = 1;
  diagonal[3][2] = 1;
  diagonal[2][3] = 1;
  assert.equal(hooks.checkWin(diagonal, 2, 3, 1)?.length, 4);
});

test('isBoardFull detects draw', () => {
  const { hooks } = loadConnectFourEngine();
  const board = hooks.createEmptyBoard();
  assert.equal(hooks.isBoardFull(board), false);
  for (let col = 0; col < hooks.COLS; col += 1) {
    for (let row = 0; row < hooks.ROWS; row += 1) {
      board[row][col] = (row + col) % 2 === 0 ? 1 : 2;
    }
  }
  assert.equal(hooks.isBoardFull(board), true);
});

test('sanitizeSettings fixes maxPlayers to 2', () => {
  const { hooks } = loadConnectFourEngine();
  const s = hooks.sanitizeSettings({ maxPlayers: 8, tableName: '  Test  ' });
  assert.equal(s.maxPlayers, 2);
  assert.equal(s.tableName, 'Test');
});

test('host can start game with two players and alternate turns', () => {
  const { hooks } = loadConnectFourEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Gast' });
  assert.equal(host.startGame(), true);
  const state = host.publicState();
  assert.equal(state.phase, 'playing');
  assert.equal(state.players.length, 2);
  assert.equal(state.toAct, 'host');

  assert.equal(host.applyAction('host', { type: 'drop', column: 0 }), true);
  assert.equal(host.publicState().toAct, 'p2');
  assert.equal(host.applyAction('p2', { type: 'drop', column: 1 }), true);
  assert.equal(host.publicState().toAct, 'host');
});

test('host detects vertical win', () => {
  const { hooks } = loadConnectFourEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Gast' });
  host.startGame();

  const moves = [
    ['host', 0],
    ['p2', 1],
    ['host', 0],
    ['p2', 1],
    ['host', 0],
    ['p2', 1],
    ['host', 0],
  ];
  for (const [peer, col] of moves) {
    host.applyAction(peer, { type: 'drop', column: col });
  }

  const final = host.publicState();
  assert.equal(final.phase, 'finished');
  assert.equal(final.winnerPeerId, 'host');
  assert.equal(final.winCells?.length, 4);
});

test('rematch resets board after finished game', () => {
  const { hooks } = loadConnectFourEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Gast' });
  host.startGame();
  host.applyAction('host', { type: 'drop', column: 0 });
  host.applyAction('p2', { type: 'drop', column: 0 });
  host.applyAction('host', { type: 'drop', column: 1 });
  host.applyAction('p2', { type: 'drop', column: 1 });
  host.applyAction('host', { type: 'drop', column: 2 });
  host.applyAction('p2', { type: 'drop', column: 2 });
  host.applyAction('host', { type: 'drop', column: 3 });
  assert.equal(host.publicState().phase, 'finished');
  assert.equal(host.applyAction('host', { type: 'rematch' }), true);
  const after = host.publicState();
  assert.equal(after.phase, 'playing');
  assert.equal(after.winnerPeerId, null);
  assert.ok(after.board.every((row) => row.every((cell) => cell === 0)));
});

test('saved game persists lobby players', () => {
  const { hooks, storage } = loadConnectFourEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.saveNow();
  const saved = storage.get('savedConnectFourGame');
  assert.equal(saved.players.length, 1);
  assert.equal(saved.players[0].peerId, 'host');

  const resumed = hooks.createHost(saved.settings, () => {}, { id: 'host', name: 'Host' }, saved);
  resumed.bootstrapHost();
  assert.equal(resumed.publicState().players.length, 1);
});
