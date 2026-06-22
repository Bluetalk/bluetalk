const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PeerServer } = require('../src/shared/peer-server');

class MemoryStore {
  constructor(initial = {}) {
    this.data = { ...initial };
  }

  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
  }
}

async function listenLocally(peer) {
  const server = await peer._listenOnPort(0);
  assert.ok(server);
  peer.servers = [server];
  peer.server = server;
  peer.port = server.address().port;
  peer.ports = [peer.port];
  peer._stopped = false;
}

async function createPair() {
  const left = new PeerServer(new MemoryStore({ peerId: 'bt-a' }));
  const right = new PeerServer(new MemoryStore({ peerId: 'bt-b' }));
  await Promise.all([listenLocally(left), listenLocally(right)]);
  return { left, right };
}

function closePair(left, right) {
  left.stop();
  right.stop();
}

test('connect resolves after the WebSocket handshake and keeps idle sockets alive', async () => {
  const { left, right } = await createPair();
  try {
    const info = await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    assert.equal(info.id, right.id);
    assert.equal(left.peers.size, 1);
    assert.equal(right.peers.size, 1);
    assert.equal(left.peers.get(right.id).socket.timeout, 0);
    assert.equal(right.peers.get(left.id).socket.timeout, 0);
  } finally {
    closePair(left, right);
  }
});

test('simultaneous dialing converges on one shared connection', async () => {
  const { left, right } = await createPair();
  try {
    const results = await Promise.all([
      left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port }),
      right.connectTo({ id: left.id, address: '127.0.0.1', port: left.port }),
    ]);
    assert.deepEqual(results.map((item) => item.id).sort(), [left.id, right.id].sort());
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(left.peers.size, 1);
    assert.equal(right.peers.size, 1);
    assert.equal(left.peers.get(right.id).direction, 'outgoing');
    assert.equal(right.peers.get(left.id).direction, 'incoming');
  } finally {
    closePair(left, right);
  }
});

test('messages larger than 64 KiB survive WebSocket framing', async () => {
  const { left, right } = await createPair();
  try {
    await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    const received = once(right, 'peer:message');
    const content = 'x'.repeat(96 * 1024);
    assert.equal(left.sendTo(right.id, { kind: 'chat', content, messageId: 'large-frame' }), true);
    const [message] = await received;
    assert.equal(message.from, left.id);
    assert.equal(message.content, content);
  } finally {
    closePair(left, right);
  }
});
