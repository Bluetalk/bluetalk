const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { PeerServer, isLoopbackConnectAddress } = require('../src/shared/peer-server');

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
    assert.equal(left.peers.get(right.id).socket._socket.timeout, 0);
    assert.equal(right.peers.get(left.id).socket._socket.timeout, 0);
    assert.equal(left.peers.get(right.id).info.supportsHeartbeat, true);
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

test('connectTo replaces a stale dead peer entry', async () => {
  const { left, right } = await createPair();
  try {
    await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    assert.equal(left.peers.size, 1);

    const staleSocket = left.peers.get(right.id).socket;
    staleSocket.terminate();
    left._pruneDeadPeer(right.id);

    const staleOnRight = right.peers.get(left.id);
    assert.ok(staleOnRight);
    staleOnRight.lastPongAt = Date.now() - 30000;

    const info = await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    assert.equal(info.id, right.id);
    assert.equal(left.peers.size, 1);
    assert.equal(right.peers.size, 1);
  } finally {
    closePair(left, right);
  }
});

test('heartbeat removes peers that stop responding', async () => {
  const { left, right } = await createPair();
  try {
    await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    const peerEntry = left.peers.get(right.id);
    assert.ok(peerEntry);

    peerEntry.lastPongAt = Date.now() - 76000;
    left._heartbeatTick();

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(left.peers.has(right.id), false);
  } finally {
    closePair(left, right);
  }
});

test('heartbeat remains compatible with peers that do not advertise support', async () => {
  const { left, right } = await createPair();
  try {
    await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    const peerEntry = left.peers.get(right.id);
    peerEntry.info.supportsHeartbeat = false;
    peerEntry.lastPongAt = Date.now() - 5 * 60 * 1000;
    left._heartbeatTick();
    assert.equal(left.peers.has(right.id), true);
  } finally {
    closePair(left, right);
  }
});

test('saved contacts retain their identity when reconnecting host:port addresses', async () => {
  const peer = new PeerServer(new MemoryStore({
    peerId: 'bt-a',
    contacts: [{ id: 'bt-b', address: '127.0.0.1:4567' }],
  }));
  const calls = [];
  peer.connectTo = async (target) => {
    calls.push(target);
    return { id: target.id };
  };
  peer.reconnectContactsFromStore();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: 'bt-b', address: '127.0.0.1:4567' }]);
  const descriptor = peer._createConnectionDescriptor(calls[0]);
  assert.equal(descriptor.peerId, 'bt-b');
  assert.equal(descriptor.host, '127.0.0.1');
  assert.deepEqual(descriptor.ports, [4567]);
  peer.stop();
});

test('explicit host:port addresses dial only the saved port', () => {
  const peer = new PeerServer(new MemoryStore({ peerId: 'bt-a' }));
  const descriptor = peer._createConnectionDescriptor({ id: 'bt-b', address: '127.0.0.1:58621' });
  const candidates = peer._createConnectionCandidates(descriptor);
  assert.deepEqual(candidates.map((item) => item.port), [58621]);
  peer.stop();
});

test('isLoopbackConnectAddress detects localhost endpoints', () => {
  assert.equal(isLoopbackConnectAddress('127.0.0.1:58621'), true);
  assert.equal(isLoopbackConnectAddress('localhost:8080'), true);
  assert.equal(isLoopbackConnectAddress('192.168.1.10:58621'), false);
});

test('candidate dialing uses bounded parallel batches', async () => {
  const peer = new PeerServer(new MemoryStore({ peerId: 'bt-a' }));
  let active = 0;
  let maxActive = 0;
  peer._connectToCandidateWs = async (candidate) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    throw new Error(`failed:${candidate.port}`);
  };
  await assert.rejects(
    peer._connectUsingCandidates({}, Array.from({ length: 9 }, (_, index) => ({ host: '127.0.0.1', port: 1000 + index }))),
    /failed:/
  );
  assert.equal(maxActive, 4);
  peer.stop();
});

test('invalid peer identities are rejected before dialing', async () => {
  const peer = new PeerServer(new MemoryStore({ peerId: 'bt-a' }));
  await assert.rejects(
    peer.connectTo({ id: '__proto__', address: '127.0.0.1:1234' }),
    /Invalid peer identity/
  );
  peer.stop();
});

test('sendMany routes only to explicit valid recipients', () => {
  const peer = new PeerServer(new MemoryStore({ peerId: 'bt-a' }));
  const calls = [];
  peer.sendTo = (peerId, data) => {
    calls.push({ peerId, data });
    return peerId !== 'bt-offline';
  };
  const result = peer.sendMany(
    ['bt-member', 'bt-member', 'invalid peer', 'bt-offline'],
    { kind: 'group-message-v1', groupId: 'group:12345678' }
  );
  assert.deepEqual(calls.map((call) => call.peerId), ['bt-member', 'bt-offline']);
  assert.deepEqual(result, [
    { peerId: 'bt-member', sent: true },
    { peerId: 'bt-offline', sent: false },
  ]);
  peer.stop();
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

test('wire messages cannot spoof their sender or override the transport type', async () => {
  const { left, right } = await createPair();
  try {
    await left.connectTo({ id: right.id, address: '127.0.0.1', port: right.port });
    const received = once(right, 'peer:message');
    assert.equal(left.sendTo(right.id, {
      type: 'bye',
      from: 'bt-spoofed',
      kind: 'chat',
      content: 'still a message',
    }), true);
    const [message] = await received;
    assert.equal(message.from, left.id);
    assert.equal(message.type, 'message');
    assert.equal(right.peers.has(left.id), true);
  } finally {
    closePair(left, right);
  }
});
