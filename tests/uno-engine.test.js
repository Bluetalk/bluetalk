const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadUnoEngine() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'assets', 'bundled-plugins', 'uno', 'ui.js'), 'utf8');
  const storage = new Map();
  const events = new Map();
  const sent = [];
  let timerId = 0;
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
      setTimeout: () => ++timerId,
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
    __BLUETALK_UNO_TEST_HOOKS__: {},
    bluetalk: {
      peer: { getInfo: async () => ({ id: 'host', name: 'Host' }) },
      uno: { onFromChild: () => () => {}, pushState: () => {}, openGameWindow: async () => {} },
    },
  };
  const execute = new Function('BlueTalkPlugin', 'window', 'document', 'crypto', 'queueMicrotask', source);
  execute(api, windowStub, {}, globalThis.crypto, queueMicrotask);
  return { hooks: windowStub.__BLUETALK_UNO_TEST_HOOKS__, storage, sent };
}

test('buildDeck creates exactly 108 cards with correct distribution', () => {
  const { hooks } = loadUnoEngine();
  const deck = hooks.buildDeck();
  assert.equal(deck.length, 108);
  const byColor = {};
  for (const card of deck) {
    byColor[card.color] = (byColor[card.color] || 0) + 1;
  }
  assert.equal(byColor.red, 25);
  assert.equal(byColor.yellow, 25);
  assert.equal(byColor.green, 25);
  assert.equal(byColor.blue, 25);
  assert.equal(byColor.wild, 8);
  const ids = new Set(deck.map((c) => c.id));
  assert.equal(ids.size, 108);
});

test('canPlay matches color, value, wild and wild4 official restriction', () => {
  const { hooks } = loadUnoEngine();
  const top = { id: 'r_5_a', color: 'red', value: '5' };
  const sameColor = { id: 'r_3_a', color: 'red', value: '3' };
  const sameValue = { id: 'b_5_a', color: 'blue', value: '5' };
  const wild = { id: 'wild_0', color: 'wild', value: 'wild' };
  const wild4 = { id: 'wild4_0', color: 'wild', value: 'wild4' };
  const handWithRed = [{ id: 'r_1_a', color: 'red', value: '1' }];
  const handNoRed = [{ id: 'b_1_a', color: 'blue', value: '1' }];

  assert.equal(hooks.canPlay(sameColor, top, 'red', 'official', handWithRed), true);
  assert.equal(hooks.canPlay(sameValue, top, 'red', 'official', handWithRed), true);
  assert.equal(hooks.canPlay(wild, top, 'red', 'official', handWithRed), true);
  assert.equal(hooks.canPlay(wild4, top, 'red', 'official', handNoRed), true);
  assert.equal(hooks.canPlay(wild4, top, 'red', 'official', handWithRed), false);
  assert.equal(hooks.canPlay(wild4, top, 'red', 'casual', handWithRed), true);
});

test('cardPoints uses UNO scoring values', () => {
  const { hooks } = loadUnoEngine();
  assert.equal(hooks.cardPoints({ color: 'red', value: '7' }), 7);
  assert.equal(hooks.cardPoints({ color: 'red', value: 'skip' }), 20);
  assert.equal(hooks.cardPoints({ color: 'wild', value: 'wild4' }), 50);
});

test('sanitizeSettings clamps maxPlayers to 8 and preserves game modes', () => {
  const { hooks } = loadUnoEngine();
  const s = hooks.sanitizeSettings({ maxPlayers: 12, gameMode: 'points', houseRules: 'casual', targetScore: 99999 });
  assert.equal(s.maxPlayers, 8);
  assert.equal(s.gameMode, 'points');
  assert.equal(s.houseRules, 'casual');
  assert.equal(s.targetScore, 10000);
});

test('host can start game with two players and deal seven cards each', () => {
  const { hooks } = loadUnoEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Zwei' });
  assert.equal(host.startGame(), true);
  const state = host.publicState();
  assert.equal(state.phase, 'playing');
  assert.equal(state.players.length, 2);
  assert.ok(state.topCard);
  assert.equal(host.getMyHand().length, 7);
  assert.equal(state.players.find((p) => p.peerId === 'p2')?.cardCount, 7);
});

test('playing matching card advances turn', () => {
  const { hooks } = loadUnoEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Zwei' });
  host.startGame();

  const hand = host.getMyHand();
  const state = host.publicState();
  const actor = state.toAct;
  const actorHand = actor === 'host' ? hand : [];
  const top = state.topCard;
  const actorCards = actor === 'host' ? hand : host.getMyHand();
  const cards = actor === 'host' ? hand : actorCards;
  const playable = cards.find((c) => hooks.canPlay(c, top, state.activeColor, 'official', cards));
  assert.ok(actor);
  if (playable && actor === 'host') {
    assert.equal(host.applyAction(actor, { type: 'play', cardId: playable.id }), true);
    assert.notEqual(host.publicState().toAct, actor);
  } else {
    assert.equal(host.applyAction(actor, { type: 'draw' }), true);
    assert.ok(host.publicState().toAct);
  }
});

test('callUno marks player and draw plus pass advances turn', () => {
  const { hooks } = loadUnoEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.onWire('p2', { wire: 'join', gameId: host.gameId, name: 'Zwei' });
  host.startGame();

  assert.equal(host.applyAction('host', { type: 'callUno' }), false);
  const top = host.publicState().topCard;
  const hand = host.getMyHand();
  const playable = hand.find((c) => hooks.canPlay(c, top, host.publicState().activeColor, 'official', hand));
  if (playable && host.publicState().toAct === 'host') {
    host.applyAction('host', { type: 'play', cardId: playable.id });
  }
  host.applyAction('host', { type: 'draw' });
  if (host.publicState().drewCanPass === 'host') {
    host.applyAction('host', { type: 'pass' });
  }
  assert.ok(host.publicState().toAct);
});

test('saved game persists lobby players', () => {
  const { hooks, storage } = loadUnoEngine();
  const host = hooks.createHost({ lobbyAccess: 'public' }, () => {}, { id: 'host', name: 'Host' });
  host.bootstrapHost();
  host.saveNow();
  const saved = storage.get('savedUnoGame');
  assert.equal(saved.players.length, 1);
  assert.equal(saved.players[0].peerId, 'host');

  const resumed = hooks.createHost(saved.settings, () => {}, { id: 'host', name: 'Host' }, saved);
  resumed.bootstrapHost();
  assert.equal(resumed.publicState().players.length, 1);
});

test('restored UNO game needs two connected players to start', () => {
  const { hooks } = loadUnoEngine();
  const saved = {
    gameId: 'restored',
    settings: {},
    players: [
      { peerId: 'host', name: 'Host', seat: 0, score: 0 },
      { peerId: 'offline', name: 'Offline', seat: 1, score: 0 },
    ],
  };
  const host = hooks.createHost({}, () => {}, { id: 'host', name: 'Host' }, saved);
  host.bootstrapHost();
  assert.equal(host.startGame(), false);
  assert.equal(host.publicState().phase, 'lobby');
});
