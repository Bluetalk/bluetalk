const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const realtimeUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'shared', 'plugin-realtime.mjs'),
).href;

function mockPeer() {
  const sent = [];
  return {
    sent,
    send(peerId, data) {
      sent.push({ type: 'send', peerId, data });
      return true;
    },
    sendMany(peerIds, data) {
      sent.push({ type: 'sendMany', peerIds, data });
      return true;
    },
    broadcast(data) {
      sent.push({ type: 'broadcast', data });
      return true;
    },
  };
}

test('realtime envelope helpers', async () => {
  const {
    REALTIME_KIND,
    isRealtimeMessage,
    parseRealtimeMessage,
    buildRealtimeEnvelope,
    applyTextOp,
    isPresenceStale,
  } = await import(realtimeUrl);

  const envelope = buildRealtimeEnvelope('my-plugin', 'room-1', 'room-msg', { hello: true });
  assert.equal(envelope.kind, REALTIME_KIND);
  assert.equal(envelope.pluginRealtime.pluginId, 'my-plugin');
  assert.equal(envelope.pluginRealtime.roomId, 'room-1');
  assert.equal(envelope.pluginRealtime.wire, 'room-msg');
  assert.deepEqual(envelope.pluginRealtime.payload, { hello: true });

  assert.equal(isRealtimeMessage(envelope), true);
  assert.equal(isRealtimeMessage({ kind: 'chat' }), false);

  const parsed = parseRealtimeMessage({ ...envelope, from: 'peer-a' }, 'my-plugin');
  assert.ok(parsed);
  assert.equal(parsed.from, 'peer-a');
  assert.equal(parseRealtimeMessage(envelope, 'other-plugin'), null);

  assert.equal(applyTextOp('hello', { type: 'insert', pos: 5, text: '!' }), 'hello!');
  assert.equal(applyTextOp('hello!', { type: 'delete', pos: 5, len: 1 }), 'hello');
  assert.equal(applyTextOp('old', { type: 'replace', value: 'new' }), 'new');

  assert.equal(isPresenceStale({ timestamp: Date.now() - 100_000 }), true);
  assert.equal(isPresenceStale({ timestamp: Date.now() }), false);
});

test('host room join flow', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const hostPeer = mockPeer();
  const clientPeer = mockPeer();
  let hostSelf = 'host-id';
  let clientSelf = 'client-id';

  const hostHandlers = [];
  const clientHandlers = [];

  const hostManager = createRealtimeManager({
    pluginId: 'collab',
    peer: hostPeer,
    selfPeerId: () => hostSelf,
    onPeerMessage: (handler) => {
      hostHandlers.push(handler);
      return () => {};
    },
  });

  const clientManager = createRealtimeManager({
    pluginId: 'collab',
    peer: clientPeer,
    selfPeerId: () => clientSelf,
    onPeerMessage: (handler) => {
      clientHandlers.push(handler);
      return () => {};
    },
  });

  const room = hostManager.createRoom({ roomId: 'doc-room', name: 'Notes', access: 'public' });
  assert.ok(room);
  assert.equal(room.isHost, true);

  const joinPromise = clientManager.joinRoom({ roomId: 'doc-room', hostPeerId: 'host-id', name: 'Alice' });

  const joinWire = hostPeer.sent.find((s) => s.type === 'send' && s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN);
  assert.ok(!joinWire);

  const clientJoin = clientPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN);
  assert.ok(clientJoin);
  assert.equal(clientJoin.peerId, 'host-id');

  hostHandlers[0]({
    ...clientJoin.data,
    from: 'client-id',
  });

  const joinOk = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN_OK);
  assert.ok(joinOk);
  assert.equal(joinOk.peerId, 'client-id');

  clientHandlers[0]({
    ...joinOk.data,
    from: 'host-id',
  });

  const joinedRoom = await joinPromise;
  assert.ok(joinedRoom);
  assert.equal(joinedRoom.isHost, false);
  assert.equal(joinedRoom.members.size, 2);
});

test('invite-access room accepts an invited peer', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const hostPeer = mockPeer();
  const clientPeer = mockPeer();

  const hostHandlers = [];
  const clientHandlers = [];

  const hostManager = createRealtimeManager({
    pluginId: 'live-docs',
    peer: hostPeer,
    selfPeerId: () => 'host-id',
    onPeerMessage: (handler) => {
      hostHandlers.push(handler);
      return () => {};
    },
  });

  const clientManager = createRealtimeManager({
    pluginId: 'live-docs',
    peer: clientPeer,
    selfPeerId: () => 'client-id',
    onPeerMessage: (handler) => {
      clientHandlers.push(handler);
      return () => {};
    },
  });

  const room = hostManager.createRoom({ roomId: 'doc-room', name: 'Notes', access: 'invite' });
  assert.equal(room.access, 'invite');

  // Host lädt den Client ein.
  assert.equal(room.invite('client-id'), true);
  const inviteWire = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_INVITE);
  assert.ok(inviteWire);
  assert.equal(inviteWire.peerId, 'client-id');

  // Client erhält die Einladung und tritt bei.
  clientHandlers[0]({ ...inviteWire.data, from: 'host-id' });
  const joinPromise = clientManager.joinRoom({ roomId: 'doc-room', hostPeerId: 'host-id', name: 'Alice' });

  const clientJoin = clientPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN);
  assert.ok(clientJoin);
  hostHandlers[0]({ ...clientJoin.data, from: 'client-id' });

  // Der Host darf NICHT ablehnen — der Beitritt muss bestätigt werden.
  const reject = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN_REJECT);
  assert.equal(reject, undefined);
  const joinOk = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN_OK);
  assert.ok(joinOk);

  clientHandlers[0]({ ...joinOk.data, from: 'host-id' });
  const joinedRoom = await joinPromise;
  assert.ok(joinedRoom);
  assert.equal(joinedRoom.isHost, false);
  assert.equal(joinedRoom.members.size, 2);
});

test('invite-access room rejects an uninvited peer', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const hostPeer = mockPeer();
  const hostHandlers = [];
  const hostManager = createRealtimeManager({
    pluginId: 'live-docs',
    peer: hostPeer,
    selfPeerId: () => 'host-id',
    onPeerMessage: (h) => {
      hostHandlers.push(h);
      return () => {};
    },
  });

  hostManager.createRoom({ roomId: 'doc-room', name: 'Notes', access: 'invite' });

  hostHandlers[0]({
    kind: 'plugin-realtime',
    from: 'stranger',
    pluginRealtime: {
      pluginId: 'live-docs',
      roomId: 'doc-room',
      wire: WIRE.ROOM_JOIN,
      payload: { name: 'Mallory' },
    },
  });

  const reject = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN_REJECT);
  assert.ok(reject);
  assert.equal(reject.data.pluginRealtime.payload.reason, 'invite-required');
});

test('shared document revision conflicts', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const hostPeer = mockPeer();
  const hostHandlers = [];
  const hostManager = createRealtimeManager({
    pluginId: 'collab',
    peer: hostPeer,
    selfPeerId: () => 'host-id',
    onPeerMessage: (handler) => {
      hostHandlers.push(handler);
      return () => {};
    },
  });

  const room = hostManager.createRoom({ roomId: 'r1' });
  const doc = room.createDocument({ docId: 'main', initial: 'hi' });
  assert.equal(doc.getState(), 'hi');
  assert.equal(doc.getRevision(), 1);

  doc.applyOp({ type: 'insert', pos: 2, text: '!' });
  assert.equal(doc.getState(), 'hi!');
  assert.equal(doc.getRevision(), 2);

  const stale = doc._applyOpAsHost({ type: 'insert', pos: 0, text: 'x' }, 0);
  assert.equal(stale, false);
  assert.equal(doc.getRevision(), 2);

  hostHandlers[0]({
    kind: 'plugin-realtime',
    from: 'client-id',
    pluginRealtime: {
      pluginId: 'collab',
      roomId: 'r1',
      wire: WIRE.DOC_OP,
      payload: { docId: 'main', baseRevision: 2, op: { type: 'insert', pos: 3, text: '?' } },
    },
  });
  assert.equal(doc.getState(), 'hi!?');
  assert.equal(doc.getRevision(), 3);
});

test('room join reject when full', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const hostPeer = mockPeer();
  const hostHandlers = [];
  const hostManager = createRealtimeManager({
    pluginId: 'p',
    peer: hostPeer,
    selfPeerId: () => 'host',
    onPeerMessage: (h) => {
      hostHandlers.push(h);
      return () => {};
    },
  });

  const room = hostManager.createRoom({ roomId: 'small', maxPeers: 2 });
  room.members.set('other', { peerId: 'other', joinedAt: Date.now() });

  hostHandlers[0]({
    kind: 'plugin-realtime',
    from: 'late-peer',
    pluginRealtime: {
      pluginId: 'p',
      roomId: 'small',
      wire: WIRE.ROOM_JOIN,
      payload: { name: 'Late' },
    },
  });

  const reject = hostPeer.sent.find((s) => s.data?.pluginRealtime?.wire === WIRE.ROOM_JOIN_REJECT);
  assert.ok(reject);
  assert.equal(reject.data.pluginRealtime.payload.reason, 'full');
});

test('presence discovery', async () => {
  const { createRealtimeManager, WIRE } = await import(realtimeUrl);

  const peer = mockPeer();
  const handlers = [];
  const manager = createRealtimeManager({
    pluginId: 'p',
    peer,
    selfPeerId: () => 'self',
    onPeerMessage: (h) => {
      handlers.push(h);
      return () => {};
    },
  });

  let discovered = null;
  manager.on('room-discovered', (info) => {
    discovered = info;
  });

  handlers[0]({
    kind: 'plugin-realtime',
    from: 'host-1',
    pluginRealtime: {
      pluginId: 'p',
      roomId: 'pub-room',
      wire: WIRE.ROOM_PRESENCE,
      payload: {
        roomId: 'pub-room',
        hostPeerId: 'host-1',
        name: 'Public Notes',
        memberCount: 1,
        timestamp: Date.now(),
      },
    },
  });

  assert.ok(discovered);
  assert.equal(discovered.name, 'Public Notes');
  assert.equal(discovered.hostPeerId, 'host-1');
});
