const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'preload', 'game-preload.js'),
  'utf8',
);

const GAMES = [
  { id: 'poker', bridge: 'poker', channel: 'poker' },
  { id: 'uno', bridge: 'uno', channel: 'uno' },
  { id: 'connect-four', bridge: 'connectFour', channel: 'connect-four' },
  { id: 'chess', bridge: 'chess', channel: 'chess' },
  { id: 'tic-tac-toe', bridge: 'ticTacToe', channel: 'ticTacToe' },
  { id: 'racing-3d', bridge: 'racing', channel: 'racing' },
];

function loadBridge(config) {
  let exposed = null;
  const invoked = [];
  const sent = [];
  const listeners = new Map();
  const removed = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => { exposed = { name, api }; },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invoked.push({ channel, args });
        return Promise.resolve({ ok: true });
      },
      send: (channel, ...args) => sent.push({ channel, args }),
      on: (channel, listener) => listeners.set(channel, listener),
      removeListener: (channel, listener) => removed.push({ channel, listener }),
    },
  };
  vm.runInNewContext(source, {
    require: (name) => {
      assert.equal(name, 'electron');
      return electron;
    },
    process: { argv: ['electron', '.', `--bluetalk-game=${config.id}`] },
  });
  return { exposed, invoked, sent, listeners, removed };
}

test('game preload exposes only the route-specific minimal bridge', async (t) => {
  for (const config of GAMES) {
    await t.test(config.id, async () => {
      const runtime = loadBridge(config);
      assert.equal(runtime.exposed.name, 'bluetalk');
      assert.deepEqual(Object.keys(runtime.exposed.api).sort(), [config.bridge, 'peer'].sort());
      assert.deepEqual(Object.keys(runtime.exposed.api.peer), ['getInfo']);

      const gameApi = runtime.exposed.api[config.bridge];
      assert.deepEqual(Object.keys(gameApi).sort(), [
        'closeGameWindow',
        'isWindowMaximized',
        'maximizeWindow',
        'minimizeWindow',
        'onState',
        'onWindowMaximizedChange',
        'sendAction',
      ].sort());
      assert.equal(gameApi.openGameWindow, undefined);
      assert.equal(runtime.exposed.api.store, undefined);
      assert.equal(runtime.exposed.api.plugins, undefined);
      assert.equal(runtime.exposed.api.ollama, undefined);

      await runtime.exposed.api.peer.getInfo();
      await gameApi.closeGameWindow();
      await gameApi.minimizeWindow();
      await gameApi.maximizeWindow();
      await gameApi.isWindowMaximized();
      gameApi.sendAction({ type: 'request_state' });

      assert.deepEqual(runtime.invoked.map((entry) => entry.channel), [
        'peer:getInfo',
        `${config.channel}:closeGameWindow`,
        `${config.channel}:minimizeWindow`,
        `${config.channel}:maximizeWindow`,
        `${config.channel}:isWindowMaximized`,
      ]);
      assert.equal(runtime.sent[0].channel, `${config.channel}:fromChild`);

      const offState = gameApi.onState(() => {});
      const offMaximized = gameApi.onWindowMaximizedChange(() => {});
      assert.ok(runtime.listeners.has(`${config.channel}:state`));
      assert.ok(runtime.listeners.has(`${config.channel}:windowMaximized`));
      offState();
      offMaximized();
      assert.equal(runtime.removed.length, 2);
    });
  }
});

test('game preload exposes nothing without an approved game argument', () => {
  let exposed = false;
  vm.runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld: () => { exposed = true; } },
      ipcRenderer: {},
    }),
    process: { argv: ['electron', '.'] },
  });
  assert.equal(exposed, false);
});
