const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadPokerEngine() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'bundled-plugins', 'poker', 'ui.js'), 'utf8');
  const storage = new Map();
  const events = new Map();
  const sent = [];
  let timerId = 0;
  const api = {
    contacts: () => [],
    peers: () => [],
    peer: { send: (peerId, payload) => sent.push({ peerId, payload }) },
    chat: { send: () => true },
    storage: {
      get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
      set: (key, value) => { storage.set(key, JSON.parse(JSON.stringify(value))); return true; },
    },
    timer: {
      setTimeout: () => ++timerId,
      clearTimeout: () => {},
    },
    on: (name, handler) => { events.set(name, handler); return () => events.delete(name); },
    onDeactivate: () => {},
    ui: { registerTab: () => {} },
    notify: { toast: () => {} },
    log: { info: () => {}, error: () => {} },
  };
  const windowStub = {
    __BLUETALK_POKER_TEST_HOOKS__: {},
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'host', name: 'Host' }) },
      poker: { onFromChild: () => () => {}, pushState: () => {}, openGameWindow: async () => {} },
    },
  };
  const execute = new Function('BlueTalkPlugin', 'window', 'document', 'crypto', 'queueMicrotask', source);
  execute(api, windowStub, {}, globalThis.crypto, queueMicrotask);
  return { hooks: windowStub.__BLUETALK_POKER_TEST_HOOKS__, storage, sent };
}

test('wheel straight is correctly lower than a six-high straight', () => {
  const { hooks } = loadPokerEngine();
  const wheel = hooks.scoreFive([12, 13, 27, 41, 3]);
  const sixHigh = hooks.scoreFive([0, 14, 28, 42, 4]);
  assert.deepEqual(wheel, [4, 3]);
  assert.ok(hooks.cmpScore(sixHigh, wheel) > 0);
});

test('side pots conserve every contributed chip', () => {
  const { hooks } = loadPokerEngine();
  const pots = hooks.buildSidePots({ a: 100, b: 60, c: 20 });
  assert.equal(pots.reduce((sum, pot) => sum + pot.amount, 0), 180);
  assert.deepEqual(pots.map((pot) => pot.amount), [60, 80, 40]);
});

test('heads-up starts with the dealer and a short all-in does not skip the caller', () => {
  const { hooks } = loadPokerEngine();
  const host = hooks.createHost(
    { smallBlind: 10, bigBlind: 20, startingChips: 100, maxPlayers: 2 },
    () => {},
    { id: 'host', name: 'Host' }
  );
  host.bootstrapHost();
  assert.equal(host.addDebugBot(), true);
  assert.equal(host.startHand(), true);

  let state = host.publicState();
  assert.equal(state.toAct, 'host');
  host.applyAction('host', { type: 'raise', raiseTo: 90 });
  state = host.publicState();
  assert.equal(state.toAct, '__bt_poker_bot_debug__');
  host.applyAction('__bt_poker_bot_debug__', { type: 'all_in' });
  state = host.publicState();
  assert.equal(state.toAct, 'host');
  assert.equal(state.actionBounds.toCall, 10);
  const chipsBeforeGrant = state.players.find((player) => player.peerId === 'host').chips;
  assert.equal(host.addChips('host', 50), true);
  state = host.publicState();
  assert.equal(state.players.find((player) => player.peerId === 'host').chips, chipsBeforeGrant);
  assert.equal(state.players.find((player) => player.peerId === 'host').pendingChips, 50);
});

test('admin chips and lobby standings are persisted', () => {
  const { hooks, storage } = loadPokerEngine();
  const host = hooks.createHost({}, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  assert.equal(host.addChips('host', 750), true);
  assert.equal(host.saveNow(), true);
  const saved = storage.get('savedPokerGame');
  assert.equal(saved.players.find((player) => player.peerId === 'host').chips, 2750);
  assert.equal(saved.players.find((player) => player.peerId === 'host').stats.chipsGranted, 750);

  const resumed = hooks.createHost(saved.settings, () => {}, { id: 'host', name: 'Host' }, saved);
  resumed.bootstrapHost();
  assert.equal(resumed.publicState().players.find((player) => player.peerId === 'host').chips, 2750);
});

test('host can remove chips between hands', () => {
  const { hooks } = loadPokerEngine();
  const host = hooks.createHost({}, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  assert.equal(host.removeChips('host', 500), true);
  assert.equal(host.publicState().players.find((player) => player.peerId === 'host').chips, 1500);
  assert.equal(host.removeChips('host', 5000), true);
  assert.equal(host.publicState().players.find((player) => player.peerId === 'host').chips, 0);
});
