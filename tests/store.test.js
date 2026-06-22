const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Store = require('../src/shared/store');

test('store rejects prototype-polluting paths and persists normal nested keys', async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bluetalk-store-'));
  try {
    const store = new Store({ configName: 'test', baseDir });
    assert.throws(() => store.set('messages.__proto__.polluted', true), /Invalid store key/);
    assert.throws(() => store.set('constructor.prototype.polluted', true), /Invalid store key/);
    assert.equal({}.polluted, undefined);

    store.set('settings.theme', 'dark');
    await store.waitForWrites();
    const reloaded = new Store({ configName: 'test', baseDir });
    assert.equal(reloaded.get('settings.theme'), 'dark');
    assert.equal(reloaded.get('messages.__proto__.polluted', 'safe'), 'safe');
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true });
  }
});
