const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GAMES = [
  {
    id: 'poker',
    bridge: 'poker',
    payloadKey: 'poker',
    sessionKey: 'tableId',
    sessionId: 'table-1',
    pending: { pokerSettings: {} },
  },
  {
    id: 'uno',
    bridge: 'uno',
    payloadKey: 'uno',
    sessionKey: 'gameId',
    sessionId: 'uno-1',
    pending: { unoSettings: {} },
  },
  {
    id: 'connect-four',
    bridge: 'connectFour',
    payloadKey: 'connectFour',
    sessionKey: 'gameId',
    sessionId: 'connect-four-1',
    pending: { connectFourSettings: {} },
  },
  {
    id: 'chess',
    bridge: 'chess',
    payloadKey: 'chess',
    sessionKey: 'gameId',
    sessionId: 'chess-1',
    pending: { chessSettings: {} },
  },
  {
    id: 'tic-tac-toe',
    bridge: 'ticTacToe',
    payloadKey: 'ticTacToe',
    sessionKey: 'gameId',
    sessionId: 'tic-tac-toe-1',
    pending: { ticTacToeSettings: {} },
  },
];

function loadGamePlugin(config) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'assets', 'bundled-plugins', config.id, 'ui.js'),
    'utf8',
  );
  const commands = new Map();
  const storage = new Map();
  const sent = [];
  let openCount = 0;
  let pushedState = null;

  const api = {
    contacts: () => [],
    peers: () => [{ id: 'host', name: 'Host' }],
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
    on: () => () => {},
    onDeactivate: () => {},
    ui: {
      registerTab: () => {},
      registerCommand: (name, handler) => commands.set(name, handler),
    },
    notify: { toast: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const windowStub = {
    dispatchEvent: () => true,
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'guest', name: 'Gast' }) },
      [config.bridge]: {
        onFromChild: () => () => {},
        pushState: (value) => { pushedState = value; },
        openGameWindow: async () => {
          openCount += 1;
          return { ok: true };
        },
      },
    },
  };

  const execute = new Function(
    'BlueTalkPlugin',
    'window',
    'document',
    'crypto',
    'queueMicrotask',
    'sessionStorage',
    'CustomEvent',
    source,
  );
  execute(
    api,
    windowStub,
    {},
    globalThis.crypto,
    queueMicrotask,
    { getItem: () => null, removeItem: () => {} },
    class CustomEvent {},
  );

  return {
    commands,
    sent,
    getOpenCount: () => openCount,
    getPushedState: () => pushedState,
  };
}

test('all game plugins accept a join command after startup', async (t) => {
  for (const config of GAMES) {
    await t.test(config.id, async () => {
      const runtime = loadGamePlugin(config);
      const join = runtime.commands.get('join');
      assert.equal(typeof join, 'function');

      const pending = {
        hostPeerId: 'host',
        [config.sessionKey]: config.sessionId,
        ...config.pending,
      };
      const result = await join(pending);

      assert.deepEqual(result, { ok: true });
      const request = runtime.sent.find((entry) => (
        entry.peerId === 'host'
        && entry.payload?.kind === config.id
        && entry.payload?.[config.payloadKey]?.wire === 'join'
      ));
      assert.ok(request, `${config.id} must send a join request to the host`);
      assert.equal(request.payload[config.payloadKey][config.sessionKey], config.sessionId);
      assert.equal(runtime.getOpenCount(), 1);
      assert.ok(runtime.getPushedState()?.public);

      const secondResult = await join(pending);
      assert.deepEqual(secondResult, { ok: true });
      const joinRequests = runtime.sent.filter((entry) => (
        entry.peerId === 'host'
        && entry.payload?.[config.payloadKey]?.wire === 'join'
      ));
      assert.equal(joinRequests.length, 1, 'repeated clicks must not send duplicate join requests');
    });
  }
});

test('game join rejects incomplete invitations before opening a window', async (t) => {
  for (const config of GAMES) {
    await t.test(config.id, async () => {
      const runtime = loadGamePlugin(config);
      const result = await runtime.commands.get('join')({ hostPeerId: 'host' });
      assert.equal(result.ok, false);
      assert.equal(runtime.sent.length, 0);
      assert.equal(runtime.getOpenCount(), 0);
    });
  }
});
