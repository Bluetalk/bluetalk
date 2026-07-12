/**
 * Generic realtime protocol for BlueTalk plugins.
 * Host-authoritative rooms and shared documents over the existing P2P transport.
 */

const REALTIME_KIND = 'plugin-realtime';
const REALTIME_PRESENCE_CLEAR = 'room-presence-clear';

const WIRE = {
  ROOM_INVITE: 'room-invite',
  ROOM_JOIN: 'room-join',
  ROOM_JOIN_OK: 'room-join-ok',
  ROOM_JOIN_REJECT: 'room-join-reject',
  ROOM_LEAVE: 'room-leave',
  ROOM_CLOSED: 'room-closed',
  ROOM_MSG: 'room-msg',
  ROOM_PRESENCE: 'room-presence',
  ROOM_PRESENCE_CLEAR: REALTIME_PRESENCE_CLEAR,
  DOC_SYNC: 'doc-sync',
  DOC_OP: 'doc-op',
};

const ACCESS = {
  PUBLIC: 'public',
  INVITE: 'invite',
};

const PRESENCE_STALE_MS = 90_000;

function createEmitter() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (typeof fn !== 'function') return () => undefined;
      let bucket = listeners.get(name);
      if (!bucket) {
        bucket = new Set();
        listeners.set(name, bucket);
      }
      bucket.add(fn);
      return () => bucket.delete(fn);
    },
    emit(name, payload) {
      const bucket = listeners.get(name);
      if (!bucket) return;
      for (const fn of bucket) {
        try {
          fn(payload);
        } catch {
          /* ignore listener errors */
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

function randomRoomId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `room-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** @param {unknown} msg */
function isRealtimeMessage(msg) {
  return Boolean(msg && typeof msg === 'object' && msg.kind === REALTIME_KIND && msg.pluginRealtime);
}

/**
 * @param {unknown} msg
 * @param {string} [pluginId]
 */
function parseRealtimeMessage(msg, pluginId) {
  if (!isRealtimeMessage(msg)) return null;
  const body = msg.pluginRealtime;
  if (!body || typeof body !== 'object') return null;
  if (pluginId && body.pluginId !== pluginId) return null;
  return {
    pluginId: String(body.pluginId || ''),
    roomId: String(body.roomId || ''),
    wire: String(body.wire || ''),
    revision: typeof body.revision === 'number' ? body.revision : undefined,
    payload: body.payload,
    from: typeof msg.from === 'string' ? msg.from : undefined,
    timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
  };
}

/**
 * @param {string} pluginId
 * @param {string} roomId
 * @param {string} wire
 * @param {unknown} payload
 * @param {{ revision?: number }} [extra]
 */
function buildRealtimeEnvelope(pluginId, roomId, wire, payload, extra = {}) {
  return {
    kind: REALTIME_KIND,
    pluginRealtime: {
      pluginId,
      roomId,
      wire,
      ...(typeof extra.revision === 'number' ? { revision: extra.revision } : {}),
      payload,
    },
  };
}

/**
 * Apply a simple text operation to a string state.
 * @param {string} state
 * @param {{ type: string, pos?: number, text?: string, len?: number, value?: string }} op
 */
function applyTextOp(state, op) {
  const text = String(state ?? '');
  const pos = Math.max(0, Math.min(Number(op.pos) || 0, text.length));

  if (op.type === 'insert') {
    const insert = String(op.text ?? '');
    return text.slice(0, pos) + insert + text.slice(pos);
  }
  if (op.type === 'delete') {
    const len = Math.max(0, Number(op.len) || 0);
    return text.slice(0, pos) + text.slice(pos + len);
  }
  if (op.type === 'replace') {
    return String(op.value ?? '');
  }
  return text;
}

/** @param {{ timestamp?: number, maxAgeMs?: number }} params */
function isPresenceStale({ timestamp, maxAgeMs = PRESENCE_STALE_MS } = {}) {
  if (!timestamp || typeof timestamp !== 'number') return true;
  return Date.now() - timestamp > maxAgeMs;
}

/** Insert-/Delete-Op auf ganzzahlige, nicht-negative Felder normalisieren. */
function normalizeTextOp(op) {
  if (!op || typeof op !== 'object') return null;
  if (op.type === 'insert') {
    return { type: 'insert', pos: Math.max(0, Math.floor(Number(op.pos) || 0)), text: String(op.text ?? '') };
  }
  if (op.type === 'delete') {
    return {
      type: 'delete',
      pos: Math.max(0, Math.floor(Number(op.pos) || 0)),
      len: Math.max(0, Math.floor(Number(op.len) || 0)),
    };
  }
  return null;
}

/**
 * Operational Transform für primitive Text-Ops: verschiebt `op` (basiert auf
 * dem Zustand VOR `against`) so, dass es NACH `against` angewendet werden kann.
 * Liefert null, wenn sich die Regionen überschneiden (echter Konflikt) —
 * dann muss der Client gegen den aktuellen Stand neu diffen.
 */
function transformTextOp(op, against) {
  const mine = normalizeTextOp(op);
  const other = normalizeTextOp(against);
  if (!mine || !other) return null;

  if (other.type === 'insert') {
    const shift = other.text.length;
    if (mine.type === 'insert') {
      // Gleiche Position: der bereits angewendete Op behält den Vortritt.
      return mine.pos >= other.pos ? { ...mine, pos: mine.pos + shift } : mine;
    }
    if (other.pos <= mine.pos) return { ...mine, pos: mine.pos + shift };
    if (other.pos >= mine.pos + mine.len) return mine;
    return null; // Insert mitten im zu löschenden Bereich
  }

  // other.type === 'delete'
  const otherEnd = other.pos + other.len;
  if (mine.type === 'insert') {
    if (mine.pos <= other.pos) return mine;
    if (mine.pos >= otherEnd) return { ...mine, pos: mine.pos - other.len };
    return null; // Einfügeposition wurde gelöscht
  }
  if (mine.pos + mine.len <= other.pos) return mine;
  if (mine.pos >= otherEnd) return { ...mine, pos: mine.pos - other.len };
  return null; // überlappende Löschbereiche
}

const OP_LOG_LIMIT = 128;
const SEEN_OPS_PER_PEER = 16;

class SharedDocument {
  /**
   * @param {{
   *   docId: string,
   *   room: RealtimeRoom,
   *   initial?: unknown,
   *   isHost: boolean,
   *   hostPeerId: string,
   *   log?: { warn?: (...a: unknown[]) => void },
   * }} opts
   */
  constructor({ docId, room, initial, isHost, hostPeerId, log }) {
    this.docId = docId;
    this.room = room;
    this.isHost = isHost;
    this.hostPeerId = hostPeerId;
    this.log = log || {};
    this.state = initial;
    this.revision = 0;
    this.emitter = createEmitter();
    /** @type {Array<{ revision: number, op: Record<string, unknown> }>} rev N entstand durch op[N] */
    this._opLog = [];
    /** @type {Map<string, Map<string, boolean>>} Absender -> (opId -> wurde angewendet) */
    this._seenOps = new Map();
    this._off = room.on('internal', (evt) => this._handleWire(evt));
  }

  getState() {
    return this.state;
  }

  getRevision() {
    return this.revision;
  }

  on(event, handler) {
    return this.emitter.on(event, handler);
  }

  /** Host only — replace full state and broadcast sync. */
  setState(nextState) {
    if (!this.isHost) {
      this.log.warn?.('[SharedDocument] setState ignored — not host');
      return false;
    }
    this.state = nextState;
    this.revision += 1;
    // Vollersatz bricht die Op-Historie: Rebase über diesen Punkt hinweg ist unmöglich.
    this._logOp({ type: 'replace' });
    this.emitter.emit('change', { state: this.state, revision: this.revision, origin: 'local' });
    this._broadcastSync();
    return true;
  }

  /**
   * Apply an operation. Host applies locally; clients forward to host.
   * @param {Record<string, unknown>} op
   * @param {number} [baseRevision] Revision, auf der der Op basiert (Default: aktuelle)
   * @param {{ opId?: string, replacesOpId?: string }} [meta] Dedupe-Infos für Wiederholungen
   */
  applyOp(op, baseRevision, meta = {}) {
    const base = Number.isFinite(Number(baseRevision)) ? Number(baseRevision) : this.revision;
    if (this.isHost) {
      return this._applyOpAsHost(op, base, { ...meta, from: this.room.selfPeerId || '(self)' });
    }
    this.room._sendWire(this.hostPeerId, WIRE.DOC_OP, {
      docId: this.docId,
      baseRevision: base,
      op,
      ...(meta.opId ? { opId: meta.opId } : {}),
      ...(meta.replacesOpId ? { replacesOpId: meta.replacesOpId } : {}),
    });
    return true;
  }

  /** @private */
  _logOp(op) {
    this._opLog.push({ revision: this.revision, op });
    if (this._opLog.length > OP_LOG_LIMIT) {
      this._opLog.splice(0, this._opLog.length - OP_LOG_LIMIT);
    }
  }

  /** @private */
  _rememberOp(from, opId, applied) {
    if (!opId) return;
    let seen = this._seenOps.get(from);
    if (!seen) {
      seen = new Map();
      this._seenOps.set(from, seen);
    }
    if (!seen.has(opId) && seen.size >= SEEN_OPS_PER_PEER) {
      seen.delete(seen.keys().next().value);
    }
    seen.set(opId, applied);
  }

  /** @private — Op von baseRevision auf die aktuelle Revision heben. */
  _rebaseOp(op, baseRevision) {
    if (baseRevision > this.revision) return null;
    const pending = this._opLog.filter((e) => e.revision > baseRevision);
    // Lücke im Log (getrimmt oder setState dazwischen) → kein sicherer Rebase.
    if (pending.length !== this.revision - baseRevision) return null;
    let current = normalizeTextOp(op);
    for (const entry of pending) {
      if (!current) return null;
      current = transformTextOp(current, entry.op);
    }
    return current;
  }

  /** @private */
  _applyOpAsHost(op, baseRevision, meta = {}) {
    const from = meta.from || '(self)';
    const seen = this._seenOps.get(from);
    if (meta.opId && seen?.has(meta.opId)) {
      // Wiederholung (Ack ging verloren): nicht erneut anwenden.
      return seen.get(meta.opId) === true;
    }
    if (meta.replacesOpId) {
      if (seen?.get(meta.replacesOpId) === true) {
        // Der Vorgänger kam doch noch an — dieser Ersatz-Op basiert auf einem
        // veralteten Bild. Ablehnen, der Editor difft dann gegen den neuen Stand.
        this._rememberOp(from, meta.opId, false);
        return false;
      }
      // Falls der Vorgänger noch irgendwo unterwegs ist: bei Ankunft verwerfen.
      if (!seen?.has(meta.replacesOpId)) this._rememberOp(from, meta.replacesOpId, false);
    }

    let effective = op;
    if (baseRevision !== this.revision) {
      effective = typeof this.state === 'string' ? this._rebaseOp(op, baseRevision) : null;
      if (!effective) {
        this.log.warn?.('[SharedDocument] stale op rejected', { expected: this.revision, got: baseRevision });
        this._rememberOp(from, meta.opId, false);
        return false;
      }
    }

    if (typeof this.state === 'string' && effective && typeof effective === 'object' && effective.type) {
      this.state = applyTextOp(this.state, effective);
    } else if (effective && typeof effective === 'object' && effective.type === 'set') {
      this.state = effective.value;
    } else {
      this.log.warn?.('[SharedDocument] unsupported op', effective);
      this._rememberOp(from, meta.opId, false);
      return false;
    }
    this.revision += 1;
    this._logOp(normalizeTextOp(effective) || { type: 'replace' });
    this._rememberOp(from, meta.opId, true);
    this.emitter.emit('change', { state: this.state, revision: this.revision, origin: 'local' });
    this._broadcastSync();
    return true;
  }

  /** @private */
  _broadcastSync() {
    this.room._sendWireMany(this.room.memberPeerIds(), WIRE.DOC_SYNC, {
      docId: this.docId,
      state: this.state,
      revision: this.revision,
    });
  }

  /** @private */
  _handleWire({ wire, from, payload }) {
    if (!payload || payload.docId !== this.docId) return;

    if (wire === WIRE.DOC_SYNC) {
      const rev = Number(payload.revision) || 0;
      if (rev >= this.revision) {
        this.state = payload.state;
        this.revision = rev;
        this.emitter.emit('change', { state: this.state, revision: this.revision, origin: 'remote' });
        this.emitter.emit('remote-op', { from, payload });
      }
      if (payload.ackOpId) {
        this.emitter.emit('op-ack', { opId: String(payload.ackOpId), applied: payload.ackApplied === true });
      }
      return;
    }

    if (wire === WIRE.DOC_OP && this.isHost && from) {
      const baseRevision = Number(payload.baseRevision) || 0;
      const ok = this._applyOpAsHost(payload.op, baseRevision, {
        opId: payload.opId ? String(payload.opId) : undefined,
        replacesOpId: payload.replacesOpId ? String(payload.replacesOpId) : undefined,
        from,
      });
      // Gezieltes Ack mit aktuellem Stand an den Absender — auch bei Erfolg,
      // damit dessen Editor die Runde sicher abschließen kann.
      this.room._sendWire(from, WIRE.DOC_SYNC, {
        docId: this.docId,
        state: this.state,
        revision: this.revision,
        ...(payload.opId ? { ackOpId: String(payload.opId), ackApplied: ok === true } : {}),
      });
    }
  }

  dispose() {
    this._off?.();
    this.emitter.clear();
  }
}

class RealtimeRoom {
  /**
   * @param {{
   *   pluginId: string,
   *   roomId: string,
   *   name: string,
   *   access: string,
   *   maxPeers: number,
   *   isHost: boolean,
   *   hostPeerId: string,
   *   selfPeerId: string,
   *   peer: { send: Function, sendMany: Function, broadcast: Function },
   *   manager: RealtimeManager,
   *   log?: { warn?: (...a: unknown[]) => void, info?: (...a: unknown[]) => void },
   * }} opts
   */
  constructor(opts) {
    this.pluginId = opts.pluginId;
    this.roomId = opts.roomId;
    this.name = opts.name;
    this.access = opts.access;
    this.maxPeers = opts.maxPeers;
    this.isHost = opts.isHost;
    this.hostPeerId = opts.hostPeerId;
    this.selfPeerId = opts.selfPeerId;
    this.peer = opts.peer;
    this.manager = opts.manager;
    this.log = opts.log || {};
    /** @type {Map<string, { peerId: string, name?: string, joinedAt: number }>} */
    this.members = new Map();
    this.closed = false;
    this.emitter = createEmitter();
    /** @type {Map<string, SharedDocument>} */
    this.documents = new Map();

    if (this.isHost) {
      this.members.set(this.selfPeerId, { peerId: this.selfPeerId, name: 'host', joinedAt: Date.now() });
      if (this.access === ACCESS.PUBLIC) {
        this._publishPresence();
      }
    }
  }

  get info() {
    return {
      roomId: this.roomId,
      name: this.name,
      access: this.access,
      isHost: this.isHost,
      hostPeerId: this.hostPeerId,
      memberCount: this.members.size,
      maxPeers: this.maxPeers,
      closed: this.closed,
    };
  }

  memberPeerIds() {
    return Array.from(this.members.keys()).filter((id) => id !== this.selfPeerId);
  }

  allMemberPeerIds() {
    return Array.from(this.members.keys());
  }

  on(event, handler) {
    return this.emitter.on(event, handler);
  }

  /** @param {unknown} payload */
  broadcast(payload) {
    if (this.closed) return false;
    const targets = this.memberPeerIds();
    if (targets.length === 0) return true;
    this._sendWireMany(targets, WIRE.ROOM_MSG, payload);
    return true;
  }

  /** @param {string} peerId @param {unknown} payload */
  sendTo(peerId, payload) {
    if (this.closed || !peerId) return false;
    this._sendWire(peerId, WIRE.ROOM_MSG, payload);
    return true;
  }

  /** @param {string} peerId */
  invite(peerId) {
    if (!this.isHost || this.closed || !peerId) return false;
    // Den Eingeladenen host-seitig vormerken, damit sein späterer ROOM_JOIN die
    // Invite-Prüfung besteht (ohne das lehnt der Host den Beitritt ab).
    this.manager._recordInvite(this.roomId, peerId);
    this._sendWire(peerId, WIRE.ROOM_INVITE, {
      roomId: this.roomId,
      name: this.name,
      hostPeerId: this.hostPeerId,
      access: this.access,
    });
    return true;
  }

  /** @param {{ docId?: string, initial?: unknown }} [opts] */
  createDocument(opts = {}) {
    const docId = String(opts.docId || 'default');
    if (this.documents.has(docId)) {
      return this.documents.get(docId);
    }
    const doc = new SharedDocument({
      docId,
      room: this,
      initial: opts.initial,
      isHost: this.isHost,
      hostPeerId: this.hostPeerId,
      log: this.log,
    });
    this.documents.set(docId, doc);
    if (this.isHost) {
      doc.setState(opts.initial ?? '');
    }
    return doc;
  }

  getDocument(docId) {
    return this.documents.get(String(docId || 'default')) || null;
  }

  leave() {
    if (this.closed) return;
    this.closed = true;
    if (this.isHost) {
      this._clearPresence();
      const targets = this.memberPeerIds();
      if (targets.length > 0) {
        this._sendWireMany(targets, WIRE.ROOM_CLOSED, { roomId: this.roomId });
      }
    } else if (this.hostPeerId) {
      this._sendWire(this.hostPeerId, WIRE.ROOM_LEAVE, { roomId: this.roomId, peerId: this.selfPeerId });
    }
    for (const doc of this.documents.values()) {
      doc.dispose();
    }
    this.documents.clear();
    this.members.clear();
    this.emitter.emit('closed', { roomId: this.roomId });
    this.manager._removeRoom(this.roomId);
    this.emitter.clear();
  }

  /** @private */
  _publishPresence() {
    this.peer.broadcast(buildRealtimeEnvelope(this.pluginId, this.roomId, WIRE.ROOM_PRESENCE, {
      roomId: this.roomId,
      name: this.name,
      hostPeerId: this.hostPeerId,
      access: this.access,
      memberCount: this.members.size,
      maxPeers: this.maxPeers,
      joinable: this.members.size < this.maxPeers,
      timestamp: Date.now(),
    }));
  }

  /** @private */
  _clearPresence() {
    this.peer.broadcast(buildRealtimeEnvelope(this.pluginId, this.roomId, WIRE.ROOM_PRESENCE_CLEAR, {
      roomId: this.roomId,
      hostPeerId: this.hostPeerId,
      timestamp: Date.now(),
    }));
  }

  /** @private */
  _sendWire(peerId, wire, payload, extra) {
    if (!peerId) return;
    this.peer.send(peerId, buildRealtimeEnvelope(this.pluginId, this.roomId, wire, payload, extra));
  }

  /** @private */
  _sendWireMany(peerIds, wire, payload, extra) {
    const ids = (peerIds || []).filter(Boolean);
    if (ids.length === 0) return;
    const envelope = buildRealtimeEnvelope(this.pluginId, this.roomId, wire, payload, extra);
    if (typeof this.peer.sendMany === 'function') {
      this.peer.sendMany(ids, envelope);
    } else {
      for (const id of ids) {
        this.peer.send(id, envelope);
      }
    }
  }

  /** @private — called by RealtimeManager when a wire message arrives */
  _handleIncoming({ wire, from, payload }) {
    if (this.closed || !from) return;

    this.emitter.emit('internal', { wire, from, payload });

    if (wire === WIRE.ROOM_MSG) {
      this.emitter.emit('message', { from, payload });
      return;
    }

    if (this.isHost) {
      this._handleHostWire({ wire, from, payload });
    } else {
      this._handleClientWire({ wire, from, payload });
    }
  }

  /** @private */
  _handleHostWire({ wire, from, payload }) {
    if (wire === WIRE.ROOM_JOIN) {
      if (this.members.size >= this.maxPeers) {
        this._sendWire(from, WIRE.ROOM_JOIN_REJECT, { reason: 'full', roomId: this.roomId });
        return;
      }
      if (this.access === ACCESS.INVITE && !this.manager._isInvited(from, this.roomId)) {
        this._sendWire(from, WIRE.ROOM_JOIN_REJECT, { reason: 'invite-required', roomId: this.roomId });
        return;
      }
      const name = payload?.name ? String(payload.name) : from;
      this.members.set(from, { peerId: from, name, joinedAt: Date.now() });
      this._sendWire(from, WIRE.ROOM_JOIN_OK, {
        roomId: this.roomId,
        name: this.name,
        hostPeerId: this.hostPeerId,
        members: Array.from(this.members.values()),
      });
      const others = this.memberPeerIds().filter((id) => id !== from);
      if (others.length > 0) {
        this._sendWireMany(others, WIRE.ROOM_MSG, { type: 'peer-joined', peerId: from, name });
      }
      this.emitter.emit('peer-joined', { peerId: from, name });
      if (this.access === ACCESS.PUBLIC) {
        this._publishPresence();
      }
      for (const doc of this.documents.values()) {
        this._sendWire(from, WIRE.DOC_SYNC, {
          docId: doc.docId,
          state: doc.getState(),
          revision: doc.getRevision(),
        });
      }
      return;
    }

    if (wire === WIRE.ROOM_LEAVE) {
      if (this.members.has(from)) {
        this.members.delete(from);
        this.emitter.emit('peer-left', { peerId: from });
        this.broadcast({ type: 'peer-left', peerId: from });
        if (this.access === ACCESS.PUBLIC) {
          this._publishPresence();
        }
      }
    }
  }

  /** @private */
  _handleClientWire({ wire, from, payload }) {
    if (wire === WIRE.ROOM_JOIN_OK && from === this.hostPeerId) {
      const members = Array.isArray(payload?.members) ? payload.members : [];
      this.members.clear();
      for (const m of members) {
        if (m?.peerId) {
          this.members.set(m.peerId, { peerId: m.peerId, name: m.name, joinedAt: m.joinedAt || Date.now() });
        }
      }
      this.emitter.emit('joined', { roomId: this.roomId, members: Array.from(this.members.values()) });
      return;
    }

    if (wire === WIRE.ROOM_JOIN_REJECT && from === this.hostPeerId) {
      this.emitter.emit('join-rejected', { reason: payload?.reason || 'unknown' });
      this.leave();
      return;
    }

    if (wire === WIRE.ROOM_CLOSED && from === this.hostPeerId) {
      this.emitter.emit('closed', { roomId: this.roomId, reason: 'host-closed' });
      this.leave();
      return;
    }

    if (wire === WIRE.ROOM_MSG && payload?.type === 'peer-joined') {
      this.members.set(payload.peerId, {
        peerId: payload.peerId,
        name: payload.name || payload.peerId,
        joinedAt: Date.now(),
      });
      this.emitter.emit('peer-joined', { peerId: payload.peerId, name: payload.name });
      return;
    }

    if (wire === WIRE.ROOM_MSG && payload?.type === 'peer-left') {
      this.members.delete(payload.peerId);
      this.emitter.emit('peer-left', { peerId: payload.peerId });
    }
  }
}

class RealtimeManager {
  /**
   * @param {{
   *   pluginId: string,
   *   peer: { send: Function, sendMany?: Function, broadcast: Function, info?: Function, list?: Function },
   *   selfPeerId: () => string | undefined,
   *   log?: { warn?: (...a: unknown[]) => void, info?: (...a: unknown[]) => void },
   *   onPeerMessage?: (handler: Function) => () => void,
   * }} opts
   */
  constructor({ pluginId, peer, selfPeerId, log, onPeerMessage }) {
    this.pluginId = pluginId;
    this.peer = peer;
    this.selfPeerId = selfPeerId;
    this.log = log || {};
    /** @type {Map<string, RealtimeRoom>} */
    this.rooms = new Map();
    /** @type {Map<string, Set<string>>} roomId -> invited peerIds */
    this.invites = new Map();
    /** @type {Map<string, { roomId: string, hostPeerId: string, name: string, memberCount: number, timestamp: number }>} */
    this.discoveredRooms = new Map();
    this.emitter = createEmitter();
    this._pendingJoins = new Map();

    if (typeof onPeerMessage === 'function') {
      this._offPeer = onPeerMessage((msg) => this._onPeerMessage(msg));
    }
  }

  listRooms() {
    return Array.from(this.rooms.values()).map((r) => r.info);
  }

  getRoom(roomId) {
    const room = this.rooms.get(roomId);
    return room && !room.closed ? room : null;
  }

  on(event, handler) {
    return this.emitter.on(event, handler);
  }

  /**
   * @param {{ roomId?: string, name?: string, access?: string, maxPeers?: number }} [opts]
   */
  createRoom(opts = {}) {
    const selfId = this.selfPeerId();
    if (!selfId) {
      this.log.warn?.('[Realtime] createRoom: no self peer id');
      return null;
    }
    const roomId = String(opts.roomId || randomRoomId());
    if (this.rooms.has(roomId)) {
      return this.rooms.get(roomId);
    }
    const room = new RealtimeRoom({
      pluginId: this.pluginId,
      roomId,
      name: String(opts.name || 'Room').slice(0, 64),
      access: opts.access === ACCESS.PUBLIC ? ACCESS.PUBLIC : ACCESS.INVITE,
      maxPeers: Math.max(2, Math.min(64, Number(opts.maxPeers) || 16)),
      isHost: true,
      hostPeerId: selfId,
      selfPeerId: selfId,
      peer: this.peer,
      manager: this,
      log: this.log,
    });
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * @param {{ roomId: string, hostPeerId: string, name?: string }} opts
   * @returns {Promise<RealtimeRoom | null>}
   */
  joinRoom(opts) {
    const selfId = this.selfPeerId();
    const roomId = String(opts?.roomId || '');
    const hostPeerId = String(opts?.hostPeerId || '');
    if (!selfId || !roomId || !hostPeerId) {
      return Promise.resolve(null);
    }
    if (this.rooms.has(roomId)) {
      return Promise.resolve(this.rooms.get(roomId));
    }

    const room = new RealtimeRoom({
      pluginId: this.pluginId,
      roomId,
      name: String(opts.name || 'Room').slice(0, 64),
      access: ACCESS.INVITE,
      maxPeers: 16,
      isHost: false,
      hostPeerId,
      selfPeerId: selfId,
      peer: this.peer,
      manager: this,
      log: this.log,
    });
    this.rooms.set(roomId, room);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        room.leave();
        resolve(null);
      }, 15_000);

      const offJoined = room.on('joined', () => {
        cleanup();
        resolve(room);
      });
      const offRejected = room.on('join-rejected', () => {
        cleanup();
        resolve(null);
      });

      const cleanup = () => {
        clearTimeout(timeout);
        offJoined?.();
        offRejected?.();
      };

      room._sendWire(hostPeerId, WIRE.ROOM_JOIN, {
        roomId,
        name: opts.name || selfId,
        peerId: selfId,
      });
    });
  }

  /** @private */
  _isInvited(peerId, roomId) {
    const set = this.invites.get(roomId);
    return Boolean(set && set.has(peerId));
  }

  /** @private — merkt einen eingeladenen Peer für die Beitritts-Prüfung vor. */
  _recordInvite(roomId, peerId) {
    if (!roomId || !peerId) return;
    let set = this.invites.get(roomId);
    if (!set) {
      set = new Set();
      this.invites.set(roomId, set);
    }
    set.add(peerId);
  }

  /** @private */
  _removeRoom(roomId) {
    this.rooms.delete(roomId);
    this.invites.delete(roomId);
  }

  /** @private */
  _onPeerMessage(msg) {
    const parsed = parseRealtimeMessage(msg, this.pluginId);
    if (!parsed) return;

    const { roomId, wire, from, payload } = parsed;

    if (wire === WIRE.ROOM_PRESENCE && payload) {
      if (!isPresenceStale({ timestamp: payload.timestamp })) {
        const key = `${payload.hostPeerId}:${roomId}`;
        this.discoveredRooms.set(key, {
          roomId,
          hostPeerId: String(payload.hostPeerId || from || ''),
          name: String(payload.name || 'Room'),
          memberCount: Number(payload.memberCount) || 0,
          timestamp: payload.timestamp || Date.now(),
        });
        this.emitter.emit('room-discovered', this.discoveredRooms.get(key));
      }
      return;
    }

    if (wire === WIRE.ROOM_PRESENCE_CLEAR) {
      const host = payload?.hostPeerId || from;
      this.discoveredRooms.delete(`${host}:${roomId}`);
      this.emitter.emit('room-closed', { roomId, hostPeerId: host });
      return;
    }

    if (wire === WIRE.ROOM_INVITE && from) {
      this._recordInvite(roomId, from);
      this.emitter.emit('room-invite', {
        roomId,
        hostPeerId: payload?.hostPeerId || from,
        name: payload?.name,
        from,
      });
      return;
    }

    const room = this.rooms.get(roomId);
    if (room && !room.closed) {
      room._handleIncoming({ wire, from: from || msg.from, payload });
    }
  }

  dispose() {
    for (const room of Array.from(this.rooms.values())) {
      room.leave();
    }
    this.rooms.clear();
    this.invites.clear();
    this.discoveredRooms.clear();
    this._offPeer?.();
    this.emitter.clear();
  }
}

/**
 * @param {{
 *   pluginId: string,
 *   peer: { send: Function, sendMany?: Function, broadcast: Function, info?: Function, list?: Function },
 *   selfPeerId: () => string | undefined,
 *   log?: { warn?: (...a: unknown[]) => void, info?: (...a: unknown[]) => void },
 *   onPeerMessage?: (handler: Function) => () => void,
 * }} opts
 */
function createRealtimeManager(opts) {
  return new RealtimeManager(opts);
}

export {
  REALTIME_KIND,
  REALTIME_PRESENCE_CLEAR,
  WIRE,
  ACCESS,
  PRESENCE_STALE_MS,
  isRealtimeMessage,
  parseRealtimeMessage,
  buildRealtimeEnvelope,
  applyTextOp,
  normalizeTextOp,
  transformTextOp,
  isPresenceStale,
  SharedDocument,
  RealtimeRoom,
  RealtimeManager,
  createRealtimeManager,
};
