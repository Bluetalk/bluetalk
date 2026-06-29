const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const runtimeUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'plugins', 'pluginRuntime.js'),
).href;

function createRecord() {
  return {
    id: 'test-plugin',
    manifest: { id: 'test-plugin' },
    tabs: new Map(),
    screens: new Map(),
    composerAttachments: new Map(),
    commands: new Map(),
    eventListeners: new Map(),
    disposers: new Set(),
    timers: new Map(),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

test('renderer plugin API uses the synchronous app peer id for realtime rooms', async () => {
  const previousWindow = global.window;
  const previousLocalStorage = global.localStorage;
  global.window = {
    bluetalk: {
      peer: {
        send: () => true,
        sendMany: () => [],
        broadcast: () => [],
      },
    },
  };
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  try {
    const { PluginRuntime } = await import(`${runtimeUrl}?test=realtime`);
    const runtime = new PluginRuntime();
    runtime.setHost({ getOwnPeerId: () => 'renderer-self' });
    const record = createRecord();
    const api = runtime._buildPluginApi(record);
    const room = api.realtime.createRoom({ roomId: 'room-1' });
    assert.ok(room);
    assert.equal(room.hostPeerId, 'renderer-self');
    assert.ok(room.members.has('renderer-self'));
    for (const dispose of record.disposers) dispose();
  } finally {
    global.window = previousWindow;
    global.localStorage = previousLocalStorage;
  }
});

test('renderer plugin timers are removed after clear, completion and activation failure', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousLocalStorage = global.localStorage;
  global.window = {
    bluetalk: {
      peer: {
        send: () => true,
        sendMany: () => [],
        broadcast: () => [],
      },
    },
    __pluginTimerFired: false,
  };
  global.document = {};
  global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  try {
    const { PluginRuntime } = await import(`${runtimeUrl}?test=timers`);
    const runtime = new PluginRuntime();
    runtime.setHost({ getOwnPeerId: () => 'renderer-self' });
    const record = createRecord();
    const api = runtime._buildPluginApi(record);

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
    for (const dispose of record.disposers) dispose();

    const originalError = console.error;
    console.error = () => {};
    try {
      runtime._activate({
        id: 'broken-plugin',
        manifest: { id: 'broken-plugin' },
        ui: "BlueTalkPlugin.timer.setTimeout(() => { window.__pluginTimerFired = true; }, 5); throw new Error('boom');",
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(runtime.active.has('broken-plugin'), false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(global.window.__pluginTimerFired, false);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.localStorage = previousLocalStorage;
  }
});
