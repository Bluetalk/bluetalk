/**
 * Tests für die kollaborative Dokument-Synchronisation:
 * Operational Transform (Rebase veralteter Ops), Op-Deduplizierung
 * und Acks — die Grundlage für gleichzeitiges Schreiben ohne Textverlust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SharedDocument,
  WIRE,
  applyTextOp,
  transformTextOp,
} from '../src/shared/plugin-realtime.mjs';

function stubRoom() {
  const handlers = new Set();
  const sent = [];
  return {
    selfPeerId: 'HOST',
    on(name, fn) {
      if (name === 'internal') handlers.add(fn);
      return () => handlers.delete(fn);
    },
    memberPeerIds: () => ['A', 'B'],
    _sendWire(peerId, wire, payload) {
      sent.push({ peerId, wire, payload });
    },
    _sendWireMany(peerIds, wire, payload) {
      sent.push({ peerId: peerIds, wire, payload });
    },
    emitInternal(evt) {
      for (const fn of [...handlers]) fn(evt);
    },
    sent,
  };
}

function hostDoc(initial = '') {
  const room = stubRoom();
  const doc = new SharedDocument({
    docId: 'main',
    room,
    initial: '',
    isHost: true,
    hostPeerId: 'HOST',
    log: {},
  });
  doc.setState(initial); // revision 1
  return { doc, room };
}

// ---------- transformTextOp ----------

test('transform: insert hinter fremdem insert wird verschoben', () => {
  const t = transformTextOp({ type: 'insert', pos: 5, text: 'X' }, { type: 'insert', pos: 0, text: 'AB' });
  assert.deepEqual(t, { type: 'insert', pos: 7, text: 'X' });
});

test('transform: insert vor fremdem insert bleibt stehen', () => {
  const t = transformTextOp({ type: 'insert', pos: 2, text: 'X' }, { type: 'insert', pos: 5, text: 'AB' });
  assert.deepEqual(t, { type: 'insert', pos: 2, text: 'X' });
});

test('transform: delete hinter fremdem delete rückt auf', () => {
  const t = transformTextOp({ type: 'delete', pos: 8, len: 2 }, { type: 'delete', pos: 0, len: 3 });
  assert.deepEqual(t, { type: 'delete', pos: 5, len: 2 });
});

test('transform: überlappende deletes sind ein Konflikt (null)', () => {
  const t = transformTextOp({ type: 'delete', pos: 2, len: 4 }, { type: 'delete', pos: 4, len: 4 });
  assert.equal(t, null);
});

test('transform: insert mitten im gelöschten Bereich ist ein Konflikt', () => {
  const t = transformTextOp({ type: 'insert', pos: 3, text: 'X' }, { type: 'delete', pos: 1, len: 5 });
  assert.equal(t, null);
});

// ---------- Host-Rebase: gleichzeitiges Schreiben ----------

test('gleichzeitige inserts an verschiedenen Stellen konvergieren (beide Reihenfolgen)', () => {
  {
    const { doc } = hostDoc('Hello');
    assert.equal(doc.applyOp({ type: 'insert', pos: 5, text: ' world' }, 1, { opId: 'a1' }), true);
    // Zweiter Op basiert noch auf Revision 1 → muss rebased werden, nicht verworfen.
    assert.equal(doc.applyOp({ type: 'insert', pos: 0, text: 'Say: ' }, 1, { opId: 'b1' }), true);
    assert.equal(doc.getState(), 'Say: Hello world');
    assert.equal(doc.getRevision(), 3);
  }
  {
    const { doc } = hostDoc('Hello');
    assert.equal(doc.applyOp({ type: 'insert', pos: 0, text: 'Say: ' }, 1, { opId: 'b1' }), true);
    assert.equal(doc.applyOp({ type: 'insert', pos: 5, text: ' world' }, 1, { opId: 'a1' }), true);
    assert.equal(doc.getState(), 'Say: Hello world');
  }
});

test('delete wird über fremden insert hinweg korrekt verschoben', () => {
  const { doc } = hostDoc('Hello cruel world');
  // A fügt vorne ein (rev 2), B löscht "cruel " basierend auf rev 1.
  assert.equal(doc.applyOp({ type: 'insert', pos: 0, text: '>> ' }, 1), true);
  assert.equal(doc.applyOp({ type: 'delete', pos: 6, len: 6 }, 1), true);
  assert.equal(doc.getState(), '>> Hello world');
});

test('Konflikt in derselben Region wird abgelehnt statt Text zu zerstören', () => {
  const { doc } = hostDoc('abcdef');
  assert.equal(doc.applyOp({ type: 'delete', pos: 1, len: 4 }, 1), true); // "af"
  const before = doc.getState();
  const rev = doc.getRevision();
  assert.equal(doc.applyOp({ type: 'delete', pos: 2, len: 3 }, 1), false); // überlappt
  assert.equal(doc.getState(), before);
  assert.equal(doc.getRevision(), rev);
});

test('setState bricht die Op-Historie: danach kein Rebase über den Bruch hinweg', () => {
  const { doc } = hostDoc('one');
  doc.setState('two'); // rev 2, replace-Marker im Log
  assert.equal(doc.applyOp({ type: 'insert', pos: 0, text: 'X' }, 1), false);
  assert.equal(doc.getState(), 'two');
});

// ---------- Dedupe & Acks ----------

test('gleiche opId wird nur einmal angewendet (verlorenes Ack, Wiederholung)', () => {
  const { doc } = hostDoc('Hi');
  assert.equal(doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 1, { opId: 'x' }), true);
  assert.equal(doc.getState(), 'Hi!');
  // Wiederholung mit derselben opId: meldet Erfolg, ändert aber nichts.
  assert.equal(doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 1, { opId: 'x' }), true);
  assert.equal(doc.getState(), 'Hi!');
  assert.equal(doc.getRevision(), 2);
});

test('Ersatz-Op wird verworfen, wenn der Vorgänger doch angewendet wurde', () => {
  const { doc } = hostDoc('Hi');
  assert.equal(doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 1, { opId: 'p1' }), true);
  const ok = doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 2, { opId: 'p2', replacesOpId: 'p1' });
  assert.equal(ok, false); // Editor difft danach gegen den neuen Stand
  assert.equal(doc.getState(), 'Hi!');
});

test('verspäteter Vorgänger eines Ersatz-Ops wird verworfen (kein Doppel-Insert)', () => {
  const { doc } = hostDoc('Hi');
  // Ersatz kommt zuerst an, Original hinkt hinterher.
  assert.equal(doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 1, { opId: 'p2', replacesOpId: 'p1' }), true);
  assert.equal(doc.applyOp({ type: 'insert', pos: 2, text: '!' }, 1, { opId: 'p1' }), false);
  assert.equal(doc.getState(), 'Hi!');
});

test('DOC_OP über die Leitung: Absender bekommt gezieltes Ack mit Stand', () => {
  const { doc, room } = hostDoc('Hello');
  room.emitInternal({
    wire: WIRE.DOC_OP,
    from: 'A',
    payload: { docId: 'main', baseRevision: 1, op: { type: 'insert', pos: 5, text: '!' }, opId: 'a9' },
  });
  assert.equal(doc.getState(), 'Hello!');
  const ack = room.sent.findLast((m) => m.peerId === 'A' && m.wire === WIRE.DOC_SYNC);
  assert.ok(ack, 'Ack-Sync an den Absender erwartet');
  assert.equal(ack.payload.ackOpId, 'a9');
  assert.equal(ack.payload.ackApplied, true);
  assert.equal(ack.payload.state, 'Hello!');
});

test('abgelehnter DOC_OP: Ack mit ackApplied=false und aktuellem Stand', () => {
  const { doc, room } = hostDoc('abcdef');
  doc.applyOp({ type: 'delete', pos: 1, len: 4 }, 1);
  room.emitInternal({
    wire: WIRE.DOC_OP,
    from: 'B',
    payload: { docId: 'main', baseRevision: 1, op: { type: 'delete', pos: 2, len: 3 }, opId: 'b7' },
  });
  const ack = room.sent.findLast((m) => m.peerId === 'B' && m.wire === WIRE.DOC_SYNC);
  assert.ok(ack);
  assert.equal(ack.payload.ackOpId, 'b7');
  assert.equal(ack.payload.ackApplied, false);
  assert.equal(ack.payload.state, 'af');
});

// ---------- Simulation: zwei Peers tippen gleichzeitig ----------

test('Simulation: verschachteltes Tippen zweier Peers konvergiert', () => {
  const { doc } = hostDoc('<p>Start</p>');
  // Beide Editoren senden abwechselnd Ops, die je auf einer alten Revision basieren.
  let revA = doc.getRevision();
  let revB = doc.getRevision();
  const opsA = [
    { type: 'insert', pos: 3, text: 'A1 ' },
    { type: 'insert', pos: 6, text: 'A2 ' },
  ];
  const opsB = [
    { type: 'insert', pos: 8, text: ' B1' },
    { type: 'insert', pos: 11, text: ' B2' },
  ];
  // Verschachtelt: A1 (base alt), B1 (base alt), A2, B2 — jeder kennt nur seine Sicht.
  assert.equal(doc.applyOp(opsA[0], revA, { opId: 'A-1' }), true);
  revA = doc.getRevision();
  assert.equal(doc.applyOp(opsB[0], revB, { opId: 'B-1' }), true);
  revB = doc.getRevision();
  assert.equal(doc.applyOp(opsA[1], revA, { opId: 'A-2' }), true);
  assert.equal(doc.applyOp(opsB[1], revB, { opId: 'B-2' }), true);
  const state = doc.getState();
  // Kein Text darf verloren gehen:
  for (const frag of ['A1', 'A2', 'B1', 'B2', 'Start'.slice(0, 2)]) {
    assert.ok(state.includes(frag), `"${frag}" fehlt in "${state}"`);
  }
});

test('applyTextOp klemmt Positionen sicher ein', () => {
  assert.equal(applyTextOp('abc', { type: 'insert', pos: 99, text: 'X' }), 'abcX');
  assert.equal(applyTextOp('abc', { type: 'delete', pos: 1, len: 99 }), 'a');
});
