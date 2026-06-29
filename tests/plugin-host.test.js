const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { PluginHost } = require('../src/main/plugin-host.js');

class MemoryStore {
  constructor() {
    this.data = new Map();
  }

  get(key, fallback) {
    return this.data.has(key) ? this.data.get(key) : fallback;
  }

  set(key, value) {
    this.data.set(key, value);
  }

  delete(key) {
    this.data.delete(key);
  }
}

class MockPeerServer extends EventEmitter {
  getInfo() {
    return { id: 'main-self', name: 'Main' };
  }

  getPeers() { return []; }
  sendTo() { return true; }
  sendMany() { return []; }
  broadcast() { return []; }
  connectTo() { return Promise.resolve(null); }
  disconnectPeer() { return true; }
  refreshDiscovery() {}
}

function createHost(pluginsDir) {
  return new PluginHost({
    peerServer: new MockPeerServer(),
    store: new MemoryStore(),
    mainWindowRef: () => null,
    isAppInForegroundRef: () => false,
    pluginsDir,
  });
}

function createRecord(manifest, dir, mainFile = '') {
  return {
    manifest,
    dir,
    mainFile,
    enabled: false,
    eventListeners: new Map(),
    commands: new Map(),
    disposers: new Set(),
    timers: new Map(),
    lastError: '',
  };
}

test('main plugin realtime uses the peer server id', async () => {
  const { createRealtimeManager } = await import('../src/shared/plugin-realtime.mjs');
  const host = createHost(os.tmpdir());
  const record = createRecord({ id: 'test-plugin', name: 'Test' }, os.tmpdir());
  const api = host._buildApi(record, { createRealtimeManager });
  const room = api.realtime.createRoom({ roomId: 'main-room' });
  assert.ok(room);
  assert.equal(room.hostPeerId, 'main-self');
  assert.ok(room.members.has('main-self'));
  for (const dispose of record.disposers) dispose();
});

test('main plugin timers are removed after clear and completion', async () => {
  const host = createHost(os.tmpdir());
  const record = createRecord({ id: 'timer-plugin', name: 'Timer' }, os.tmpdir());
  const api = host._buildApi(record);

  let completed = false;
  const canceled = api.timer.setTimeout(() => { completed = true; }, 10);
  assert.equal(record.timers.size, 1);
  api.timer.clearTimeout(canceled);
  assert.equal(record.timers.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(completed, false);

  api.timer.setTimeout(() => { completed = true; }, 0);
  assert.equal(record.timers.size, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(completed, true);
  assert.equal(record.timers.size, 0);
});

test('failed main plugin activation disposes scheduled work', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluetalk-plugin-host-'));
  const mainFile = path.join(dir, 'main.js');
  await fs.writeFile(
    mainFile,
    "setTimeout(() => { bluetalk.store.set('fired', true); }, 5); throw new Error('boom');",
    'utf8',
  );
  const host = createHost(dir);
  const record = createRecord({ id: 'broken-main', name: 'Broken' }, dir, mainFile);
  host.plugins.set('broken-main', record);
  const originalError = console.error;
  console.error = () => {};
  try {
    await host._activate(record);
  } finally {
    console.error = originalError;
  }

  assert.equal(record.enabled, false);
  assert.match(record.lastError, /boom/);
  assert.equal(record.timers.size, 0);
  assert.equal(record.context, null);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(host.store.get('plugins.data.broken-main.fired', false), false);
  await fs.rm(dir, { recursive: true, force: true });
});
