import { bytesToB64 } from './peerProtocol/bytes.js';

export const DEFAULT_RELAY_URL = 'wss://bt.henny.dev/v1/ws';
const PING_INTERVAL_MS = 20_000;
const HELLO_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_WATCH_PEERS = 2_000;
const MAX_TUNNELS = 64;
const MAX_PENDING_OPENS = 8;
const MAX_TUNNEL_PAYLOAD = 64 * 1024;
const CLIENT_LABEL = 'BlueTalk/2.2.0';
const SEND_BUFFER_HIGH = 1024 * 1024;
const SEND_BUFFER_POLL_MS = 16;
const DEFAULT_MAX_MAIL_BODY = 1024 * 1024;

export function parseRelayUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed.length > 512) throw new Error('Relay-URL fehlt oder ist zu lang.');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Relay-URL ist ungültig.');
  }
  if (url.protocol === 'wss:') return url;
  if (url.protocol === 'ws:') {
    const host = url.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
      throw new Error('ws:// ist nur für localhost erlaubt.');
    }
    return url;
  }
  throw new Error('Nur wss:// ist erlaubt (ws:// nur lokal).');
}

export function authHost(url) {
  const host = url.hostname.toLowerCase();
  return url.port ? `${host}:${url.port}` : host;
}

export function encodeTunnelFrame(tunnelId, payload) {
  const out = new Uint8Array(4 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, tunnelId);
  out.set(payload, 4);
  return out;
}

export function decodeTunnelFrame(data) {
  if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
  if (data.length < 4) return null;
  const tunnelId = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
  if (tunnelId === 0) return null;
  return { tunnelId, payload: data.subarray(4) };
}

function mailPostId(id) {
  const trimmed = String(id || '').trim();
  if (
    trimmed
    && trimmed.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(trimmed)
  ) {
    return trimmed;
  }
  return crypto.randomUUID();
}

export class RelayClient {
  constructor({
    getIdentity,
    getDisplayName,
    getWatchIds,
    isBlocked,
    hasPeer,
    onStatus,
    onPresence,
    onMail,
    attachTunnel,
  }) {
    this.getIdentity = getIdentity;
    this.getDisplayName = getDisplayName;
    this.getWatchIds = getWatchIds;
    this.isBlocked = isBlocked;
    this.hasPeer = hasPeer;
    this.onStatus = onStatus;
    this.onPresence = onPresence;
    this.onMail = onMail;
    this.attachTunnel = attachTunnel;
    this.config = { enabled: true, relayUrl: DEFAULT_RELAY_URL };
    this.snapshot = this.snapshotFromConfig();
    this.mail = [];
    this.inFlight = new Map();
    this.ws = null;
    this.loop = null;
    this.backoffMs = BACKOFF_MIN_MS;
    this.replaced = false;
    this.stopped = false;
    this.tunnels = new Map();
    this.pendingOpen = new Map();
    this.openingPeers = new Set();
    this.pendingPost = new Map();
    this.nextTunnelId = 1;
    this.ourPeerId = '';
    this.host = '';
    this.limits = { maxFrame: MAX_TUNNEL_PAYLOAD, maxMailBody: DEFAULT_MAX_MAIL_BODY, maxTunnels: MAX_TUNNELS };
    this.controlQ = [];
    this.dataQ = [];
    this.flushing = false;
    this.flushDone = null;
  }

  snapshotFromConfig() {
    return {
      enabled: this.config.enabled,
      relayUrl: this.config.relayUrl,
      state: this.config.enabled ? 'connecting' : 'disabled',
      peerId: '',
      lastError: null,
      latencyMs: null,
      connectedAt: null,
      tunnels: 0,
      onlinePeers: [],
    };
  }

  getStatus() {
    return { ...this.snapshot, onlinePeers: [...this.snapshot.onlinePeers] };
  }

  emitStatus() {
    this.onStatus?.(this.getStatus());
  }

  setState(state, error) {
    this.snapshot.state = state;
    if (state !== 'online') {
      this.snapshot.connectedAt = null;
      this.snapshot.tunnels = 0;
      this.snapshot.onlinePeers = [];
    }
    if (error) this.snapshot.lastError = error;
    if (state === 'online' || state === 'disabled') this.snapshot.lastError = null;
    if (state === 'disabled') this.snapshot.lastError = null;
    this.emitStatus();
  }

  setConfig(value = {}) {
    const next = { ...this.config };
    if (typeof value.enabled === 'boolean') next.enabled = value.enabled;
    if (typeof value.relayUrl === 'string') next.relayUrl = value.relayUrl.trim() || DEFAULT_RELAY_URL;
    parseRelayUrl(next.relayUrl);
    this.config = next;
    this.snapshot.enabled = next.enabled;
    this.snapshot.relayUrl = next.relayUrl;
    this.replaced = false;
    this.reconnect();
    return this.getStatus();
  }

  start() {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.runLoop();
  }

  reconnect() {
    this.replaced = false;
    this._reconfigure = true;
    this.closeSocket('reconfigure');
    this.wake();
  }

  takeover() {
    this.replaced = false;
    this._reconfigure = true;
    this.backoffMs = BACKOFF_MIN_MS;
    this.closeSocket('takeover');
    this.start();
    this.wake();
    return this.getStatus();
  }

  async stop() {
    this.stopped = true;
    this.closeSocket('shutdown');
    this.setState('offline');
  }

  closeSocket(reason) {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.wsCloseReason = reason;
  }

  sendJson(value) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.controlQ.push(JSON.stringify(value));
    void this.flushSends();
  }

  async sendBinary(tunnelId, payload) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (let offset = 0; offset < payload.length; offset += MAX_TUNNEL_PAYLOAD) {
      const chunk = payload.subarray(offset, offset + MAX_TUNNEL_PAYLOAD);
      this.dataQ.push(encodeTunnelFrame(tunnelId, chunk));
    }
    await this.flushSends();
  }

  async flushSends() {
    if (this.flushing) {
      if (this.flushDone) await this.flushDone;
      if (this.controlQ.length || this.dataQ.length) return this.flushSends();
      return;
    }
    this.flushing = true;
    this.flushDone = new Promise((resolve) => {
      this._flushResolve = resolve;
    });
    try {
      while (this.ws?.readyState === WebSocket.OPEN && (this.controlQ.length || this.dataQ.length)) {
        if (this.controlQ.length) {
          this.ws.send(this.controlQ.shift());
          continue;
        }
        while (
          this.ws.readyState === WebSocket.OPEN
          && this.ws.bufferedAmount > SEND_BUFFER_HIGH
          && !this.controlQ.length
        ) {
          await new Promise((resolve) => setTimeout(resolve, SEND_BUFFER_POLL_MS));
        }
        if (this.controlQ.length) continue;
        if (!this.dataQ.length) continue;
        if (this.ws.readyState !== WebSocket.OPEN) break;
        if (this.ws.bufferedAmount > SEND_BUFFER_HIGH) continue;
        this.ws.send(this.dataQ.shift());
      }
    } finally {
      this.flushing = false;
      const resolve = this._flushResolve;
      this._flushResolve = null;
      this.flushDone = null;
      resolve?.();
    }
    if (this.controlQ.length || this.dataQ.length) await this.flushSends();
  }

  async runLoop() {
    while (!this.stopped) {
      if (!this.config.enabled) {
        this.setState('disabled');
        await this.waitForWake();
        continue;
      }
      if (this.replaced) {
        this.setState('replaced', 'replaced');
        await this.waitForWake();
        continue;
      }
      this.setState('connecting');
      try {
        await this.runSession();
        this.backoffMs = BACKOFF_MIN_MS;
      } catch (error) {
        const message = error?.message || String(error);
        if (this.stopped) break;
        if (this._reconfigure) {
          this._reconfigure = false;
          this.backoffMs = BACKOFF_MIN_MS;
          continue;
        }
        if (message === 'replaced') {
          this.replaced = true;
          this.setState('replaced', 'replaced');
          continue;
        }
        const next = message.includes('auth_failed') || message.includes('auth_timeout')
          ? 'error'
          : 'offline';
        this.setState(next, message);
        const jitter = Math.floor(Math.random() * Math.max(1, this.backoffMs / 4));
        const wait = this.backoffMs + jitter;
        this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
        await this.sleep(wait);
      }
    }
  }

  waitForWake() {
    return new Promise((resolve) => {
      this._wake = resolve;
    }).then(() => {
      this._wake = null;
    });
  }

  wake() {
    this._wake?.();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      const prev = this._wake;
      this._wake = () => {
        clearTimeout(timer);
        resolve();
        prev?.();
      };
    });
  }

  async runSession() {
    const url = parseRelayUrl(this.config.relayUrl);
    this.host = authHost(url);
    const identity = this.getIdentity();
    if (!identity) throw new Error('identity unavailable');

    const ws = new WebSocket(url.toString());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    const incoming = this.wsMessages(ws);

    try {
      const hello = await incoming.nextJson(HELLO_TIMEOUT_MS);
      if (hello?.t !== 'hello' || !hello.nonce) throw new Error('unerwartete Relay-Begrüßung');
      const name = String(this.getDisplayName() || 'BlueTalk user').slice(0, 64);
      const signature = identity.signRelayAuth(hello.nonce, this.host);
      this.sendJson({
        t: 'auth',
        publicKey: identity.publicKeyB64,
        signature: bytesToB64(signature),
        name,
        client: CLIENT_LABEL,
      });
      const ready = await incoming.nextJson(HELLO_TIMEOUT_MS);
      if (ready?.t !== 'ready') {
        const code = ready?.code || 'auth_failed';
        throw new Error(code);
      }
      this.ourPeerId = ready.peerId || identity.peerId;
      this.limits = {
        maxFrame: ready.limits?.maxFrame || MAX_TUNNEL_PAYLOAD,
        maxMailBody: ready.limits?.maxMailBody || DEFAULT_MAX_MAIL_BODY,
        maxTunnels: ready.limits?.maxTunnels || MAX_TUNNELS,
      };
      this.inFlight.clear();
      this.snapshot.peerId = this.ourPeerId;
      this.snapshot.connectedAt = Date.now();
      this.snapshot.lastError = null;
      this.snapshot.latencyMs = null;
      this.snapshot.onlinePeers = [];
      this.snapshot.tunnels = 0;
      this.snapshot.state = 'online';
      this.snapshot.enabled = true;
      this.snapshot.relayUrl = this.config.relayUrl;
      this.emitStatus();
      this.sendWatch();

      this.tunnels = new Map();
      this.pendingOpen = new Map();
      this.openingPeers = new Set();
      this.pendingPost = new Map();
      this.nextTunnelId = 1;
      let pingN = 1;
      let pingSent = null;
      const pingTimer = setInterval(() => {
        pingN = (pingN + 1) || 1;
        pingSent = { n: pingN, at: Date.now() };
        this.sendJson({ t: 'ping', n: pingN });
      }, PING_INTERVAL_MS);

      try {
        while (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          const message = await incoming.next();
          if (message.type === 'close') throw new Error(message.reason || 'Relay hat die Verbindung geschlossen.');
          if (message.type === 'binary') {
            this.handleBinary(message.data);
            continue;
          }
          const value = message.value;
          switch (value?.t) {
            case 'pong':
              if (pingSent && value.n === pingSent.n) {
                this.snapshot.latencyMs = Date.now() - pingSent.at;
                pingSent = null;
                this.emitStatus();
              }
              break;
            case 'presence':
              this.handlePresence(value);
              break;
            case 'incoming':
              this.handleIncoming(value);
              break;
            case 'opened':
              this.handleOpened(value);
              break;
            case 'open_failed':
              this.handleOpenFailed(value);
              break;
            case 'closed':
              this.closeLocalTunnel(value.tunnel, value.code || 'remote');
              break;
            case 'mail':
              this.handleMail(value);
              break;
            case 'posted':
              this.pendingPost.get(value.id)?.resolve({ status: value.status || 'stored' });
              this.pendingPost.delete(value.id);
              break;
            case 'post_failed':
              this.pendingPost.get(value.id)?.reject(new Error(`Postfach abgelehnt (${value.code || 'failed'})`));
              this.pendingPost.delete(value.id);
              break;
            case 'error': {
              const code = value.code || 'error';
              if (code === 'replaced' || code === 'auth_failed' || code === 'auth_timeout') {
                throw new Error(code);
              }
              break;
            }
            default:
              break;
          }
        }
      } finally {
        clearInterval(pingTimer);
      }
    } finally {
      incoming.stop();
      this.tearDownTunnels();
      if (this.ws === ws) this.ws = null;
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  wsMessages(ws) {
    const queue = [];
    let waiter = null;
    let closed = null;
    const onMessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          queue.push({ type: 'json', value: JSON.parse(event.data) });
        } catch {
          return;
        }
      } else {
        queue.push({ type: 'binary', data: new Uint8Array(event.data) });
      }
      waiter?.();
    };
    const onClose = () => {
      closed = 'Relay hat die Verbindung geschlossen.';
      waiter?.();
    };
    const onError = () => {
      closed = 'Relay-Verbindung fehlgeschlagen.';
      waiter?.();
    };
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onError);
    const next = async () => {
      while (!queue.length && !closed) {
        await new Promise((resolve) => {
          waiter = resolve;
        });
        waiter = null;
      }
      if (queue.length) return queue.shift();
      return { type: 'close', reason: closed };
    };
    return {
      next,
      async nextJson(timeoutMs) {
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Relay antwortet nicht.')), timeoutMs);
        });
        const message = await Promise.race([next(), timeout]);
        if (message.type !== 'json') throw new Error(message.reason || 'ungültige Relay-Nachricht');
        return message.value;
      },
      stop() {
        ws.removeEventListener('message', onMessage);
        ws.removeEventListener('close', onClose);
        ws.removeEventListener('error', onError);
      },
    };
  }

  sendWatch() {
    const ids = (this.getWatchIds?.() || []).slice(0, MAX_WATCH_PEERS);
    this.sendJson({ t: 'watch', peers: ids });
  }

  refreshWatch() {
    if (this.snapshot.state === 'online') this.sendWatch();
  }

  handlePresence(value) {
    const peerId = value.peerId;
    if (!peerId) return;
    const online = Boolean(value.online);
    if (online) {
      if (!this.snapshot.onlinePeers.includes(peerId)) this.snapshot.onlinePeers.push(peerId);
    } else {
      this.snapshot.onlinePeers = this.snapshot.onlinePeers.filter((id) => id !== peerId);
    }
    this.emitStatus();
    this.onPresence?.({ peerId, online });
    if (!online || this.isBlocked?.(peerId) || this.ourPeerId >= peerId) return;
    if (this.hasPeer?.(peerId) || this.openingPeers.has(peerId) || [...this.tunnels.values()].some((t) => t.peerId === peerId)) {
      return;
    }
    this.startOpen(peerId).catch(() => {});
  }

  handleIncoming(value) {
    const tunnelId = Number(value.tunnel);
    const from = String(value.from || '');
    if (!tunnelId || !from || this.isBlocked?.(from) || this.hasPeer?.(from) || this.tunnels.size >= this.limits.maxTunnels) {
      this.sendJson({ t: 'reject', tunnel: tunnelId });
      return;
    }
    this.sendJson({ t: 'accept', tunnel: tunnelId });
    this.bindTunnel(tunnelId, from, false);
  }

  handleOpened(value) {
    const tunnelId = Number(value.tunnel);
    const pending = this.pendingOpen.get(tunnelId);
    if (!pending) return;
    this.pendingOpen.delete(tunnelId);
    this.openingPeers.delete(pending.peerId);
    this.bindTunnel(tunnelId, pending.peerId, true)
      .then(pending.resolve)
      .catch(pending.reject);
  }

  handleOpenFailed(value) {
    const tunnelId = Number(value.tunnel);
    const pending = this.pendingOpen.get(tunnelId);
    if (!pending) return;
    this.pendingOpen.delete(tunnelId);
    this.openingPeers.delete(pending.peerId);
    pending.reject(new Error(`Cloud-Tunnel fehlgeschlagen (${value.code || 'failed'})`));
  }

  async bindTunnel(tunnelId, peerId, initiator) {
    const send = (bytes) => this.sendBinary(tunnelId, bytes);
    const handle = {
      peerId,
      push: null,
      queue: [],
      close: () => this.sendJson({ t: 'close', tunnel: tunnelId }),
    };
    this.tunnels.set(tunnelId, handle);
    this.snapshot.tunnels = this.tunnels.size;
    this.emitStatus();
    try {
      const attached = await this.attachTunnel({
        tunnelId,
        peerId,
        initiator,
        send,
        remoteAddress: `relay://${this.host}`,
        onReady: (api) => {
          handle.push = api.push;
          handle.closeSession = api.close;
          for (const chunk of handle.queue) api.push(chunk);
          handle.queue = [];
        },
      });
      return attached;
    } catch (error) {
      this.closeLocalTunnel(tunnelId, 'handshake');
      throw error;
    }
  }

  handleBinary(data) {
    const decoded = decodeTunnelFrame(data);
    if (!decoded) return;
    if (decoded.payload.length > MAX_TUNNEL_PAYLOAD) {
      this.closeLocalTunnel(decoded.tunnelId, 'overflow');
      return;
    }
    const handle = this.tunnels.get(decoded.tunnelId);
    if (!handle) return;
    if (handle.push) handle.push(decoded.payload);
    else handle.queue.push(decoded.payload);
  }

  closeLocalTunnel(tunnelId, _reason) {
    const handle = this.tunnels.get(tunnelId);
    if (!handle) return;
    this.tunnels.delete(tunnelId);
    handle.closeSession?.();
    this.snapshot.tunnels = this.tunnels.size;
    this.emitStatus();
  }

  tearDownTunnels() {
    for (const [id, handle] of this.tunnels) {
      handle.closeSession?.();
      this.tunnels.delete(id);
    }
    for (const pending of this.pendingOpen.values()) {
      pending.reject(new Error('Cloud-Tunnel wurde unterbrochen.'));
    }
    this.pendingOpen.clear();
    this.openingPeers.clear();
    for (const pending of this.pendingPost.values()) {
      pending.reject(new Error('Cloud-Postfach wurde unterbrochen.'));
    }
    this.pendingPost.clear();
    this.snapshot.tunnels = 0;
    this.snapshot.onlinePeers = [];
    this.snapshot.connectedAt = null;
    this.snapshot.latencyMs = null;
    this.controlQ = [];
    this.dataQ = [];
  }

  allocTunnelId() {
    for (let i = 0; i < 0xffffffff; i += 1) {
      const id = this.nextTunnelId;
      this.nextTunnelId = (this.nextTunnelId + 1) || 1;
      if (id && !this.tunnels.has(id) && !this.pendingOpen.has(id)) return id;
    }
    return 1;
  }

  async startOpen(target) {
    if (this.pendingOpen.size >= MAX_PENDING_OPENS || this.tunnels.size >= this.limits.maxTunnels) {
      throw new Error('Zu viele Cloud-Tunnel.');
    }
    if ([...this.tunnels.values()].some((t) => t.peerId === target) || this.openingPeers.has(target)) {
      throw new Error('Cloud-Tunnel zu diesem Peer läuft bereits.');
    }
    const id = this.allocTunnelId();
    this.openingPeers.add(target);
    const promise = new Promise((resolve, reject) => {
      this.pendingOpen.set(id, { peerId: target, resolve, reject });
    });
    this.sendJson({ t: 'open', tunnel: id, to: target });
    return promise;
  }

  async openPeer(peerId) {
    const target = String(peerId || '').trim();
    if (!target) throw new Error('peerId fehlt');
    if (this.snapshot.state !== 'online') throw new Error('Cloud ist nicht online.');
    if (this.hasPeer?.(target)) return null;
    return this.startOpen(target);
  }

  async postMail(peerId, body, id) {
    const to = String(peerId || '').trim();
    if (!to) throw new Error('peerId fehlt');
    if (this.snapshot.state !== 'online') throw new Error('Cloud ist nicht online.');
    const encoded = new TextEncoder().encode(JSON.stringify(body ?? null));
    if (encoded.length > this.limits.maxMailBody) {
      throw new Error('Nachricht ist zu groß für das Postfach.');
    }
    const postId = mailPostId(id);
    const result = new Promise((resolve, reject) => {
      this.pendingPost.set(postId, { resolve, reject });
    });
    this.sendJson({ t: 'post', id: postId, to, body });
    return result;
  }

  handleMail(value) {
    if (!value?.id || !value.from) return;
    if (this.inFlight.has(value.id) || this.mail.some((item) => item.id === value.id)) return;
    const item = {
      id: value.id,
      from: value.from,
      ts: value.ts || 0,
      body: value.body ?? null,
    };
    this.mail.push(item);
    this.onMail?.({ id: item.id, from: item.from, ts: item.ts });
  }

  drainMail() {
    const items = this.mail.splice(0, this.mail.length);
    for (const item of items) this.inFlight.set(item.id, item);
    return items;
  }

  ackMail(ids) {
    const cleaned = (ids || [])
      .map((id) => String(id || '').trim())
      .filter((id) => id && id.length <= 128)
      .slice(0, 500);
    if (!cleaned.length) return;
    for (const id of cleaned) {
      this.inFlight.delete(id);
      this.mail = this.mail.filter((item) => item.id !== id);
    }
    this.sendJson({ t: 'ack', ids: cleaned });
  }
}
