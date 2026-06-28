const { EventEmitter } = require('events');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const { WebSocket, WebSocketServer } = require('ws');

/**
 * PeerServer - P2P networking layer
 * - Auto-discovery via UDP broadcast on LAN
 * - Multi-port listening so peers can connect across several allowed ports
 * - WebSocket-over-HTTP for messaging (firewall friendly)
 */

const PORT_CANDIDATES = [
  0,
  8080,
  8443,
  3000,
  5000,
  9090,
  8888,
  4443,
  80,
  443,
  8000,
  8081,
  8082,
  9000,
  5500,
];

const MAX_LISTEN_PORTS = 4;
/** Data URLs for avatars can exceed 200k chars (see ProfileMenu MAX_AVATAR_BYTES); keep handshake/profile sync usable. */
const MAX_PROFILE_PICTURE_DATA_URL_CHARS = 520 * 1024;
/** Reject absurd frames to avoid OOM (chat attachments are large but not multi‑GB over this JSON transport). */
/** Large chat attachments (base64 JSON). 512 MiB cap per assembled WS text frame. */
const MAX_WEBSOCKET_PAYLOAD_BYTES = 24 * 1024 * 1024;
const MAX_WEBSOCKET_BUFFERED_BYTES = 8 * 1024 * 1024;
const CONNECTION_BATCH_SIZE = 4;
const DISCOVERY_PORT = 41234;
const DISCOVERY_INTERVAL = 5000;
const DISCOVERY_MAGIC = 'BLUETALK_V2';
const CONNECTION_TIMEOUT_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 5000;

function normalizeConnectError(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (
    !message
    || message === 'Opening handshake has timed out'
    || message === 'Peer handshake timed out'
    || message === 'Connection closed before handshake completed'
  ) {
    return new Error('Connection failed');
  }
  return error instanceof Error ? error : new Error(message);
}
const TCP_KEEP_ALIVE_DELAY_MS = 15000;
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 75000;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30000;
const MAX_HOSTED_FILE_BYTES = 8 * 1024 * 1024;
const MAX_HOSTED_FILES = 20;
const MAX_TOTAL_HOSTED_FILE_BYTES = 64 * 1024 * 1024;
const FILE_REQUEST_TIMEOUT_MS = 30000;

function safeDownloadName(value) {
  const name = String(value || 'file').replace(/[\r\n"\\/]/g, '_').trim();
  return (name || 'file').slice(0, 180);
}

function safeContentType(value) {
  const type = String(value || '').toLowerCase().trim();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)
    ? type
    : 'application/octet-stream';
}

function isValidPeerId(value) {
  return typeof value === 'string' && /^bt-[A-Za-z0-9_-]{1,64}$/.test(value);
}

/**
 * Normalize user-entered peer addresses (trim, strip /bt/ws paths, accept http/ws URLs).
 * @param {string} rawInput
 * @returns {string} host, or host:port when a port was given
 */
function normalizeConnectAddress(rawInput) {
  let raw = String(rawInput || '').trim();
  if (!raw) {
    throw new Error('Address is required');
  }
  raw = raw.replace(/\s+/g, '');
  raw = raw.replace(/\/bt\/ws\/?$/i, '');
  raw = raw.replace(/\/$/, '');

  let toParse = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    toParse = `http://${raw}`;
  }

  try {
    const u = new URL(toParse);
    const host = u.hostname;
    if (!host) {
      throw new Error('Invalid address');
    }
    const port = u.port ? Number(u.port) : 0;
    if (port > 0 && port <= 65535) {
      return `${host}:${port}`;
    }
    return host;
  } catch {
    /* fall through */
  }

  const lastColon = raw.lastIndexOf(':');
  if (lastColon > 0) {
    const hostPart = raw.slice(0, lastColon);
    const portPart = raw.slice(lastColon + 1);
    const portNum = Number(portPart);
    if (
      portPart !== '' &&
      Number.isInteger(portNum) &&
      portNum > 0 &&
      portNum <= 65535 &&
      (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostPart) || /^[a-zA-Z0-9.-]+$/.test(hostPart))
    ) {
      return `${hostPart}:${portNum}`;
    }
  }

  return raw;
}

function isLoopbackConnectAddress(rawInput) {
  const raw = String(rawInput || '').trim();
  if (!raw) return false;
  try {
    const normalized = normalizeConnectAddress(raw);
    const host = normalized.includes(':')
      ? normalized.slice(0, normalized.lastIndexOf(':'))
      : normalized;
    const lower = host.toLowerCase();
    return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1';
  } catch {
    return false;
  }
}

class PeerServer extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.id = store.get('peerId') || this._generateId();
    this.peers = new Map();
    this.hostedFiles = new Map();
    this.discoveredPeers = new Map();
    this.servers = [];
    this.server = null;
    this.port = 0;
    this.ports = [];
    this.discoverySocket = null;
    this._discoveryTimer = null;
    this._pendingConnections = new Map();
    this._activeConnectionAttempts = new Set();
    this._heartbeatTimer = null;
    this._reconnectTimers = new Map();
    this._reconnectAttempts = new Map();
    this._stopped = false;
    this._webSocketServer = new WebSocketServer({
      noServer: true,
      clientTracking: false,
      perMessageDeflate: false,
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
    });

    if (!store.get('peerId')) {
      store.set('peerId', this.id);
    }
  }

  _generateId() {
    return 'bt-' + crypto.randomBytes(8).toString('hex');
  }

  _getDisplayName() {
    return this.store.get('settings.displayName', 'Anonymous');
  }

  _getProfileFields() {
    const bio = this.store.get('settings.bio', '') || '';
    const profilePicture = this.store.get('settings.profilePicture', '') || '';
    return {
      bio: typeof bio === 'string' ? bio.slice(0, 500) : '',
      profilePicture:
        typeof profilePicture === 'string' ? profilePicture.slice(0, MAX_PROFILE_PICTURE_DATA_URL_CHARS) : '',
    };
  }

  _normalizeAddress(address) {
    if (!address) return '';
    if (address.startsWith('::ffff:')) {
      return address.slice(7);
    }
    return address;
  }

  _uniqueStrings(values = []) {
    return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
  }

  _normalizePortList(...values) {
    const ports = [];
    for (const value of values) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        const port = Number(item);
        if (Number.isInteger(port) && port > 0 && port <= 65535) {
          ports.push(port);
        }
      }
    }
    return [...new Set(ports)];
  }

  getLocalAddresses() {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          addresses.push(this._normalizeAddress(iface.address));
        }
      }
    }

    return this._uniqueStrings(addresses);
  }

  _getBroadcastAddresses() {
    const interfaces = os.networkInterfaces();
    const broadcasts = [];

    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal && iface.netmask) {
          const ip = iface.address.split('.').map(Number);
          const mask = iface.netmask.split('.').map(Number);
          const broadcast = ip.map((octet, i) => (octet | (~mask[i] & 255)));
          broadcasts.push(broadcast.join('.'));
        }
      }
    }

    if (broadcasts.length === 0) {
      broadcasts.push('255.255.255.255');
    }

    return this._uniqueStrings(broadcasts);
  }

  _getConfiguredPortCandidates() {
    const preferred = this._normalizePortList(
      this.store.get('settings.peerPorts', []),
      this.store.get('settings.peerPort', 0)
    );

    return [...new Set([0, ...preferred, ...PORT_CANDIDATES])];
  }

  async start() {
    this._stopped = false;
    const started = await this._startListeningServers();
    if (!started) {
      console.error('[PeerServer] Failed to bind to any port');
      return;
    }

    this.store.set('settings.peerPort', this.port);
    this.store.set('settings.peerPorts', this.ports);
    console.log(`[PeerServer] Listening on ports ${this.ports.join(', ')}`);
    this._startDiscovery();
    this._startHeartbeat();
  }

  async _startListeningServers() {
    const candidates = this._getConfiguredPortCandidates();

    for (const candidate of candidates) {
      if (this.ports.length >= MAX_LISTEN_PORTS) {
        break;
      }

      const server = await this._listenOnPort(candidate);
      if (!server) {
        continue;
      }

      const boundPort = server.address().port;
      if (this.ports.includes(boundPort)) {
        server.close();
        continue;
      }

      this.servers.push(server);
      this.ports.push(boundPort);
    }

    this.server = this.servers[0] || null;
    this.port = this.ports[0] || 0;

    return this.ports.length > 0;
  }

  _listenOnPort(port) {
    return new Promise((resolve) => {
      const server = this._createHTTPServer();

      const onError = (err) => {
        if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
          console.warn(`[PeerServer] Port ${port || 'auto'} failed: ${err.message}`);
        }
        try {
          server.close();
        } catch {}
        resolve(null);
      };

      server.once('error', onError);
      server.listen(port, () => {
        server.removeListener('error', onError);
        resolve(server);
      });
    });
  }

  _createHTTPServer() {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/bt/info') {
        const info = this.getInfo();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(JSON.stringify({ id: info.id, name: info.name, port: info.port, ports: info.ports }));
        return;
      }

      if (req.method === 'GET' && req.url?.startsWith('/bt/files/')) {
        const fileId = req.url.slice('/bt/files/'.length).split(/[?#]/, 1)[0];
        if (!/^[a-f0-9]{24}$/.test(fileId)) {
          res.writeHead(404);
          res.end('File not found');
          return;
        }
        const file = this.hostedFiles.get(fileId);
        if (file) {
          const name = safeDownloadName(file.name);
          res.writeHead(200, {
            'Content-Type': safeContentType(file.type),
            'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
            'Content-Length': file.data.length,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          });
          res.end(file.data);
          return;
        }
        res.writeHead(404);
        res.end('File not found');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain', 'X-Content-Type-Options': 'nosniff' });
      res.end('Not found');
    });

    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bt/ws') {
        socket.destroy();
        return;
      }
      this._webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
        this._handleWebSocketConnection(webSocket, req);
      });
    });

    return server;
  }

  _getEndpointList(addresses = this.getLocalAddresses(), ports = this.ports) {
    const endpoints = [];
    const normalizedAddresses = this._uniqueStrings(addresses.map((address) => this._normalizeAddress(address)));
    const normalizedPorts = this._normalizePortList(ports);

    for (const address of normalizedAddresses) {
      for (const port of normalizedPorts) {
        endpoints.push(`${address}:${port}`);
      }
    }

    return endpoints;
  }

  _rememberDiscoveredPeer(packet, rinfo) {
    const peerId = packet.id;
    const addresses = this._uniqueStrings([
      this._normalizeAddress(rinfo.address),
      ...(Array.isArray(packet.addresses) ? packet.addresses.map((address) => this._normalizeAddress(address)) : []),
    ]);
    const ports = this._normalizePortList(packet.ports, packet.port, packet.primaryPort);
    const existing = this.discoveredPeers.get(peerId) || {};

    const merged = {
      id: peerId,
      name: packet.name || existing.name || 'Unknown',
      addresses: this._uniqueStrings([...(existing.addresses || []), ...addresses]),
      ports: this._normalizePortList(existing.ports, ports),
      primaryPort: ports[0] || existing.primaryPort || 0,
      lastSeenAt: Date.now(),
      sourceAddress: this._normalizeAddress(rinfo.address),
    };

    this.discoveredPeers.set(peerId, merged);
    this.emit('peer:discovered', merged);
    return merged;
  }

  _mergePeerDiscovery(peerId, info = {}) {
    if (!peerId) return;

    const existing = this.discoveredPeers.get(peerId) || { id: peerId };
    const merged = {
      ...existing,
      ...info,
      addresses: this._uniqueStrings([...(existing.addresses || []), ...(info.addresses || []), info.address]),
      ports: this._normalizePortList(existing.ports, info.ports, info.port),
      lastSeenAt: Date.now(),
    };

    if (!merged.primaryPort) {
      merged.primaryPort = merged.ports[0] || info.port || existing.primaryPort || 0;
    }

    this.discoveredPeers.set(peerId, merged);
  }

  _startDiscovery() {
    try {
      this.discoverySocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.discoverySocket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.magic !== DISCOVERY_MAGIC) return;
          if (data.id === this.id) return;
          if (!isValidPeerId(data.id)) return;

          const discoveredPeer = this._rememberDiscoveredPeer(data, rinfo);

          if (!data.response) {
            this._broadcastPresence([this._normalizeAddress(rinfo.address)], { response: true });
          }

          if (this._getActivePeer(discoveredPeer.id)) {
            return;
          }

          this.connectTo(discoveredPeer)
            .then(() => {
              console.log(`[Discovery] Auto-connected to ${discoveredPeer.name} (${discoveredPeer.id})`);
            })
            .catch(() => {});
        } catch {}
      });

      this.discoverySocket.on('error', (err) => {
        console.warn('[Discovery] Socket error:', err.message);
        // Attempt to recreate the socket on critical errors
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          console.warn('[Discovery] Fatal socket error, will retry on next start()');
          try {
            this.discoverySocket.close();
          } catch {}
          this.discoverySocket = null;
        }
      });

      this.discoverySocket.bind(DISCOVERY_PORT, () => {
        try {
          this.discoverySocket.setBroadcast(true);
        } catch {}
        this._broadcastPresence();
        this._discoveryTimer = setInterval(() => this._broadcastPresence(), DISCOVERY_INTERVAL);
        // Rapid initial discovery: broadcast again quickly to find peers faster on startup
        setTimeout(() => this._broadcastPresence(), 500);
        setTimeout(() => this._broadcastPresence(), 1500);
      });
    } catch (err) {
      console.warn('[Discovery] Could not start:', err.message);
    }
  }

  /** Send an immediate discovery broadcast (same as the periodic LAN beacon). */
  refreshDiscovery() {
    this._broadcastPresence();
    for (const id of this.discoveredPeers.keys()) {
      if (!id || id === this.id || this._getActivePeer(id)) continue;
      const snapshot = this.discoveredPeers.get(id);
      if (!snapshot) continue;
      void this.connectTo(snapshot).catch(() => {});
    }
  }

  _broadcastPresence(targetAddresses = null, extraPayload = {}) {
    if (!this.discoverySocket || this.ports.length === 0) return;

    const payload = Buffer.from(JSON.stringify({
      magic: DISCOVERY_MAGIC,
      id: this.id,
      name: this._getDisplayName(),
      port: this.port,
      primaryPort: this.port,
      ports: this.ports,
      addresses: this.getLocalAddresses(),
      response: Boolean(extraPayload.response),
      ts: Date.now(),
    }));

    const addresses = Array.isArray(targetAddresses) && targetAddresses.length > 0
      ? this._uniqueStrings(targetAddresses)
      : this._getBroadcastAddresses();

    for (const address of addresses) {
      try {
        this.discoverySocket.send(payload, 0, payload.length, DISCOVERY_PORT, address);
      } catch {}
    }
  }

  _createConnectionDescriptor(target) {
    if (typeof target === 'string') {
      const raw = target.trim();
      if (!raw) {
        throw new Error('Address is required');
      }

      let host = raw;
      let port = 0;

      try {
        if (raw.includes('://')) {
          const url = new URL(raw);
          host = url.hostname;
          port = Number(url.port) || 0;
        } else {
          const parts = raw.split(':');
          const maybePort = Number(parts[parts.length - 1]);
          if (parts.length > 1 && Number.isInteger(maybePort) && maybePort > 0) {
            port = maybePort;
            host = parts.slice(0, -1).join(':');
          }
        }
      } catch {
        host = raw;
      }

      return {
        host: this._normalizeAddress(host),
        addresses: [this._normalizeAddress(host)],
        ports: this._normalizePortList(port),
      };
    }

    if (target && typeof target === 'object') {
      const requestedPeerId = target.id || target.peerId;
      if (requestedPeerId && !isValidPeerId(requestedPeerId)) throw new Error('Invalid peer identity');
      const primaryAddress = target.host || target.address || target.sourceAddress || '';
      let parsed = { host: '', addresses: [], ports: [] };
      if (typeof primaryAddress === 'string' && primaryAddress.trim()) {
        try {
          parsed = this._createConnectionDescriptor(normalizeConnectAddress(primaryAddress));
        } catch {
          parsed = { host: this._normalizeAddress(primaryAddress), addresses: [], ports: [] };
        }
      }
      return {
        peerId: requestedPeerId,
        name: target.name,
        host: parsed.host,
        address: parsed.host,
        addresses: this._uniqueStrings([
          ...(parsed.addresses || []),
          ...(Array.isArray(target.addresses) ? target.addresses : []),
        ].map((address) => this._normalizeAddress(address))),
        ports: this._normalizePortList(target.ports, target.port, target.primaryPort, parsed.ports),
      };
    }

    throw new Error('Invalid peer target');
  }

  _createConnectionCandidates(descriptor) {
    const discovered = descriptor.peerId ? this.discoveredPeers.get(descriptor.peerId) : null;
    const addresses = this._uniqueStrings([
      descriptor.host,
      descriptor.address,
      ...(descriptor.addresses || []),
      ...(discovered?.addresses || []),
    ].map((address) => this._normalizeAddress(address)));

    const explicitPorts = this._normalizePortList(descriptor.ports);
    const discoveredPorts = discovered
      ? this._normalizePortList(discovered.ports, discovered.port, discovered.primaryPort)
      : [];
    const ports = explicitPorts.length > 0
      ? this._normalizePortList(explicitPorts, discoveredPorts)
      : this._normalizePortList(
        discoveredPorts,
        this.store.get('settings.peerPorts', []),
        this.store.get('settings.peerPort', 0),
        PORT_CANDIDATES,
      );

    const localAddresses = new Set(this.getLocalAddresses());
    const localPorts = new Set(this.ports);
    const candidates = [];

    for (const address of addresses) {
      for (const port of ports) {
        if (localAddresses.has(address) && localPorts.has(port)) {
          continue;
        }
        candidates.push({ host: address, port });
      }
    }

    return candidates;
  }

  async connectTo(target) {
    if (this._stopped) {
      throw new Error('Peer server is stopped');
    }
    const normalized = typeof target === 'string' ? normalizeConnectAddress(target) : target;
    const descriptor = this._createConnectionDescriptor(normalized);

    if (descriptor.peerId) {
      const activePeer = this._getActivePeer(descriptor.peerId);
      if (activePeer) {
        return activePeer.info;
      }
    }

    const candidates = this._createConnectionCandidates(descriptor);
    if (candidates.length === 0) {
      throw new Error('No peer endpoint available');
    }

    // Use peerId as primary dedup key; fallback to normalized host list
    const pendingKey = descriptor.peerId || candidates.map((candidate) => `${candidate.host}:${candidate.port}`).sort().join('|');
    if (this._pendingConnections.has(pendingKey)) {
      return this._pendingConnections.get(pendingKey);
    }

    const pendingPromise = this._connectUsingCandidates(descriptor, candidates)
      .finally(() => {
        this._pendingConnections.delete(pendingKey);
      });

    this._pendingConnections.set(pendingKey, pendingPromise);
    return pendingPromise;
  }

  async _connectUsingCandidates(descriptor, candidates) {
    let lastError = null;
    const operation = { attempts: new Set() };
    const cancelOutstanding = () => {
      for (const attempt of [...operation.attempts]) {
        try {
          attempt.cancel();
        } catch {}
      }
    };

    for (let offset = 0; offset < candidates.length; offset += CONNECTION_BATCH_SIZE) {
      if (this._stopped) {
        cancelOutstanding();
        throw new Error('Peer server is stopped');
      }
      if (descriptor.peerId) {
        const activePeer = this._getActivePeer(descriptor.peerId);
        if (activePeer) {
          cancelOutstanding();
          return activePeer.info;
        }
      }

      const batch = candidates.slice(offset, offset + CONNECTION_BATCH_SIZE);
      try {
        const info = await Promise.any(
          batch.map((candidate) => this._connectToCandidateWs(candidate, descriptor, operation))
        );
        cancelOutstanding();
        return info;
      } catch (err) {
        const errors = err instanceof AggregateError ? err.errors : [err];
        lastError = errors.find((item) => item?.message !== 'Connection attempt cancelled') || errors[0] || err;
      }
    }

    cancelOutstanding();
    throw normalizeConnectError(lastError) || new Error('Connection failed');
  }

  _connectToCandidateWs(candidate, descriptor, operation) {
    return new Promise((resolve, reject) => {
      const host = candidate.host.includes(':') && !candidate.host.startsWith('[')
        ? `[${candidate.host}]`
        : candidate.host;
      const socket = new WebSocket(`ws://${host}:${candidate.port}/bt/ws`, {
        handshakeTimeout: CONNECTION_TIMEOUT_MS,
        maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
        perMessageDeflate: false,
      });
      let settled = false;
      let handshakeComplete = false;
      let handshakeTimer = null;
      let peerId = descriptor.peerId || null;

      const attempt = {
        cancel: () => {
          if (settled) return;
          const error = new Error('Connection attempt cancelled');
          finishReject(error);
          try {
            socket.terminate();
          } catch {}
        },
      };
      this._activeConnectionAttempts.add(attempt);
      operation?.attempts?.add(attempt);

      const finish = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        this._activeConnectionAttempts.delete(attempt);
        operation?.attempts?.delete(attempt);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        finish();
        reject(error);
      };
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(value);
      };

      socket.once('open', () => {
        socket._socket?.setTimeout(0);
        socket._socket?.setKeepAlive(true, TCP_KEEP_ALIVE_DELAY_MS);
        handshakeTimer = setTimeout(() => {
          finishReject(new Error('Peer handshake timed out'));
          socket.terminate();
        }, HANDSHAKE_TIMEOUT_MS);

        if (!this._wsSend(socket, JSON.stringify({
          type: 'handshake',
          peerId: this.id,
          name: this._getDisplayName(),
          port: this.port,
          ports: this.ports,
          addresses: this.getLocalAddresses(),
          heartbeatVersion: 1,
          ...this._getProfileFields(),
        }))) {
          finishReject(new Error('Could not send peer handshake'));
          socket.terminate();
        }
      });

      socket.on('message', (raw, isBinary) => {
        if (isBinary) {
          if (!settled) finishReject(new Error('Peer sent a binary handshake'));
          socket.close(1003, 'Text messages only');
          return;
        }
        try {
          const data = JSON.parse(raw.toString('utf8'));
          if (data.type === 'handshake-ack') {
            if (handshakeComplete) return;
            const acknowledgedPeerId = typeof data.peerId === 'string' ? data.peerId.trim() : '';
            if (!isValidPeerId(acknowledgedPeerId) || acknowledgedPeerId === this.id) {
              throw new Error('Invalid peer identity');
            }
            if (descriptor.peerId && descriptor.peerId !== acknowledgedPeerId) {
              throw new Error('Peer identity does not match discovery record');
            }
            peerId = acknowledgedPeerId;

            const existing = this._getActivePeer(peerId);
            const preferredDirection = this._preferredConnectionDirection(peerId);
            if (this._shouldRejectNewConnection(existing, preferredDirection, 'outgoing')) {
              socket.terminate();
              finishResolve(existing.info);
              return;
            }
            if (existing && !this._isPeerResponsive(existing)) {
              this.disconnectPeer(peerId);
            }

            const info = {
              id: peerId,
              name: typeof data.name === 'string' ? data.name.slice(0, 100) : descriptor.name || 'Unknown',
              address: this._normalizeAddress(candidate.host),
              port: Number(data.port) || candidate.port,
              ports: this._normalizePortList(data.ports, data.port, candidate.port),
              connectedAt: Date.now(),
              bio: typeof data.bio === 'string' ? data.bio.slice(0, 500) : '',
              profilePicture:
                typeof data.profilePicture === 'string'
                  ? data.profilePicture.slice(0, MAX_PROFILE_PICTURE_DATA_URL_CHARS)
                  : '',
              supportsHeartbeat: Number(data.heartbeatVersion) >= 1,
            };

            handshakeComplete = true;
            this._registerPeerConnection(peerId, socket, info, 'outgoing');
            this._mergePeerDiscovery(peerId, info);
            this.emit('peer:connected', info);
            finishResolve(info);
            return;
          }

          if (!handshakeComplete) throw new Error('Expected peer handshake acknowledgement');
          if (peerId && this._handlePeerKeepalive(peerId, socket, data)) return;
          if (data.type === 'message') {
            if (this._getActivePeer(peerId)) this.emit('peer:message', { ...data, from: peerId });
          } else if (data.type === 'file-offer') {
            if (this._getActivePeer(peerId)) this.emit('peer:file-offered', { ...data, from: peerId });
          }
        } catch (error) {
          if (!settled) finishReject(error);
          socket.close(1007, 'Invalid message');
        }
      });

      const cleanup = () => {
        if (!settled) {
          const replacement = peerId ? this.peers.get(peerId) : null;
          if (replacement?.socket && replacement.socket !== socket) finishResolve(replacement.info);
          else finishReject(new Error('Connection closed before handshake completed'));
        }
        if (!peerId) return;
        const currentPeer = this.peers.get(peerId);
        if (currentPeer?.socket !== socket) return;
        this.peers.delete(peerId);
        this.emit('peer:disconnected', peerId);
        this._scheduleReconnect(peerId);
      };

      socket.once('close', cleanup);
      socket.once('error', (error) => {
        if (!settled) finishReject(normalizeConnectError(error));
      });
    });
  }

  _connectToCandidate(candidate, descriptor) {
    return new Promise((resolve, reject) => {
      const webSocketKey = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: candidate.host,
        port: candidate.port,
        path: '/bt/ws',
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': webSocketKey,
          'Sec-WebSocket-Version': '13',
        },
      });

      let settled = false;
      let socket = null;
      let handshakeTimer = null;

      const attempt = {
        cancel: () => {
          const error = new Error('Connection attempt cancelled');
          try {
            req.destroy(error);
          } catch {}
          try {
            socket?.destroy(error);
          } catch {}
          finishReject(error);
        },
      };
      this._activeConnectionAttempts.add(attempt);

      const finish = () => {
        if (handshakeTimer) {
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        }
        this._activeConnectionAttempts.delete(attempt);
      };

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        finish();
        reject(err);
      };

      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        finish();
        resolve(value);
      };

      req.on('response', (res) => {
        res.resume();
        finishReject(new Error(`Peer returned HTTP ${res.statusCode || 500}`));
      });

      req.on('upgrade', (res, upgradedSocket) => {
        socket = upgradedSocket;
        let peerId = descriptor.peerId || null;

        const expectedAccept = crypto
          .createHash('sha1')
          .update(webSocketKey + '258EAFA5-E914-47DA-95CA-5AB5DC175D22')
          .digest('base64');
        if (res.headers['sec-websocket-accept'] !== expectedAccept) {
          finishReject(new Error('Invalid WebSocket upgrade response'));
          socket.destroy();
          return;
        }

        socket._bluetalkMaskOutgoing = true;
        socket.setTimeout(0);
        socket.setKeepAlive(true, TCP_KEEP_ALIVE_DELAY_MS);
        handshakeTimer = setTimeout(() => {
          const error = new Error('Peer handshake timed out');
          finishReject(error);
          socket.destroy(error);
        }, HANDSHAKE_TIMEOUT_MS);

        const handshakeSent = this._wsSend(socket, JSON.stringify({
          type: 'handshake',
          peerId: this.id,
          name: this._getDisplayName(),
          port: this.port,
          ports: this.ports,
          addresses: this.getLocalAddresses(),
          ...this._getProfileFields(),
        }));
        if (!handshakeSent) {
          finishReject(new Error('Could not send peer handshake'));
          socket.destroy();
          return;
        }

        socket._bluetalkWsRx = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          socket._bluetalkWsRx = Buffer.concat([socket._bluetalkWsRx, chunk]);
          this._pumpWebSocketRx(socket, (message) => {
            try {
              const data = JSON.parse(message);

              if (data.type === 'handshake-ack') {
                const acknowledgedPeerId = typeof data.peerId === 'string' ? data.peerId.trim() : '';
                if (!acknowledgedPeerId || acknowledgedPeerId === this.id) {
                  throw new Error('Invalid peer identity');
                }
                if (descriptor.peerId && descriptor.peerId !== acknowledgedPeerId) {
                  throw new Error('Peer identity does not match discovery record');
                }
                peerId = acknowledgedPeerId;

                const existing = this._getActivePeer(peerId);
                const preferredDirection = this._preferredConnectionDirection(peerId);
                if (this._shouldRejectNewConnection(existing, preferredDirection, 'outgoing')) {
                  socket.destroy();
                  finishResolve(existing.info);
                  return;
                }
                if (existing && !this._isPeerResponsive(existing)) {
                  this.disconnectPeer(peerId);
                }

                const info = {
                  id: peerId,
                  name: data.name || descriptor.name || 'Unknown',
                  address: this._normalizeAddress(candidate.host),
                  port: data.port || candidate.port,
                  ports: this._normalizePortList(data.ports, data.port, candidate.port),
                  connectedAt: Date.now(),
                  bio: typeof data.bio === 'string' ? data.bio.slice(0, 500) : '',
                  profilePicture:
                    typeof data.profilePicture === 'string'
                      ? data.profilePicture.slice(0, MAX_PROFILE_PICTURE_DATA_URL_CHARS)
                      : '',
                };

                this._registerPeerConnection(peerId, socket, info, 'outgoing');
                this._mergePeerDiscovery(peerId, info);
                this.emit('peer:connected', info);
                finishResolve(info);
                return;
              }

              if (peerId && this._handlePeerKeepalive(peerId, socket, data)) {
                return;
              }

              if (data.type === 'message') {
                if (!peerId || !this._getActivePeer(peerId)) return;
                this.emit('peer:message', { ...data, from: peerId });
                return;
              }

              if (data.type === 'file-offer') {
                if (!peerId || !this._getActivePeer(peerId)) return;
                this.emit('peer:file-offered', { ...data, from: peerId });
              }
            } catch (e) {
              console.error('[PeerServer] Parse error:', e.message);
              if (!settled) {
                finishReject(e);
                socket.destroy();
              }
            }
          });
        });

        const cleanup = () => {
          if (!settled) {
            const replacement = peerId ? this.peers.get(peerId) : null;
            if (replacement?.socket && replacement.socket !== socket) {
              finishResolve(replacement.info);
            } else {
              finishReject(new Error('Connection closed before handshake completed'));
            }
          }
          if (!peerId) {
            return;
          }
          const currentPeer = this.peers.get(peerId);
          if (currentPeer?.socket !== socket) return;
          this.peers.delete(peerId);
          this.emit('peer:disconnected', peerId);
        };

        socket.on('close', cleanup);
        socket.on('error', cleanup);
      });

      req.on('error', finishReject);
      req.setTimeout(CONNECTION_TIMEOUT_MS, () => {
        req.destroy(new Error('Connection timed out'));
      });
      req.end();
    });
  }

  _preferredConnectionDirection(peerId) {
    return this.id.localeCompare(peerId) < 0 ? 'outgoing' : 'incoming';
  }

  _isPeerSocketAlive(peerEntry) {
    if (!peerEntry?.socket) return false;
    const socket = peerEntry.socket;
    if (typeof socket.readyState === 'number') {
      return socket.readyState === WebSocket.OPEN;
    }
    return !socket.destroyed && socket.writable;
  }

  _isPeerResponsive(peerEntry) {
    if (!this._isPeerSocketAlive(peerEntry)) return false;
    if (peerEntry.info?.supportsHeartbeat !== true) return true;
    const now = Date.now();
    const lastPong = peerEntry.lastPongAt || 0;
    const lastPing = peerEntry.lastPingSentAt || 0;
    if (lastPing > lastPong + 5000) return false;
    if (now - lastPong > HEARTBEAT_INTERVAL_MS) return false;
    return true;
  }

  _shouldRejectNewConnection(existing, preferredDirection, connectionDirection) {
    if (!existing) return false;
    const wouldRejectByDirection = preferredDirection !== connectionDirection
      || existing.direction === connectionDirection;
    if (!wouldRejectByDirection) return false;
    return this._isPeerResponsive(existing);
  }

  _pruneDeadPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    if (this._isPeerSocketAlive(peer)) return false;
    try {
      if (typeof peer.socket.terminate === 'function') peer.socket.terminate();
      else peer.socket.destroy();
    } catch {}
    this.peers.delete(peerId);
    this.emit('peer:disconnected', peerId);
    return true;
  }

  _getActivePeer(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    if (!this._isPeerSocketAlive(peer)) {
      this._pruneDeadPeer(peerId);
      return null;
    }
    return peer;
  }

  _handlePeerKeepalive(peerId, socket, data) {
    if (data.type === 'bye') {
      if (peerId) {
        const currentPeer = this.peers.get(peerId);
        if (currentPeer?.socket === socket) {
          this.disconnectPeer(peerId);
        }
      }
      return true;
    }
    if (data.type === 'ping') {
      this._wsSend(socket, JSON.stringify({ type: 'pong', ts: data.ts || Date.now() }));
      return true;
    }
    if (data.type === 'pong') {
      const peer = this.peers.get(peerId);
      if (peer?.socket === socket) {
        peer.lastPongAt = Date.now();
      }
      return true;
    }
    return false;
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => this._heartbeatTick(), HEARTBEAT_INTERVAL_MS);
  }

  _heartbeatTick() {
    if (this._stopped) return;
    const now = Date.now();
    for (const peerId of [...this.peers.keys()]) {
      const peer = this._getActivePeer(peerId);
      if (!peer) continue;
      if (peer.info?.supportsHeartbeat !== true) continue;
      if (now - (peer.lastPongAt || peer.info.connectedAt || 0) > HEARTBEAT_TIMEOUT_MS) {
        console.warn(`[PeerServer] Heartbeat timeout for ${peerId}`);
        this.disconnectPeer(peerId, { reconnect: true });
        continue;
      }
      peer.lastPingSentAt = now;
      this._wsSend(peer.socket, JSON.stringify({ type: 'ping', ts: now }));
    }
  }

  _registerPeerConnection(peerId, socket, info, direction) {
    const previous = this.peers.get(peerId);
    this.peers.set(peerId, { socket, info, direction, lastPongAt: Date.now() });
    this._clearReconnect(peerId);
    if (previous?.socket && previous.socket !== socket) {
      try {
        if (typeof previous.socket.terminate === 'function') previous.socket.terminate();
        else previous.socket.destroy();
      } catch {}
    }
  }

  _getReconnectTarget(peerId) {
    const contacts = this.store.get('contacts', []);
    const contact = Array.isArray(contacts) ? contacts.find((item) => item?.id === peerId) : null;
    if (contact?.blocked === true) return null;
    const discovered = this.discoveredPeers.get(peerId);
    const address = typeof contact?.address === 'string' ? contact.address.trim() : '';
    if (!address && !discovered) return null;
    return {
      id: peerId,
      name: contact?.nickname || contact?.name || discovered?.name,
      address: address || discovered?.sourceAddress || discovered?.address,
      addresses: discovered?.addresses || [],
      ports: discovered?.ports || [],
      port: discovered?.primaryPort || 0,
    };
  }

  _clearReconnect(peerId) {
    const timer = this._reconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    this._reconnectTimers.delete(peerId);
    this._reconnectAttempts.delete(peerId);
  }

  _scheduleReconnect(peerId) {
    if (this._stopped || !peerId || this._reconnectTimers.has(peerId) || this._getActivePeer(peerId)) return;
    const target = this._getReconnectTarget(peerId);
    if (!target) return;
    const attempt = (this._reconnectAttempts.get(peerId) || 0) + 1;
    this._reconnectAttempts.set(peerId, attempt);
    const exponential = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * (2 ** Math.min(attempt - 1, 5)));
    const delay = exponential + Math.floor(Math.random() * Math.min(1000, exponential / 4));
    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(peerId);
      if (this._stopped || this._getActivePeer(peerId)) return;
      try {
        await this.connectTo(target);
        this._clearReconnect(peerId);
      } catch {
        this._scheduleReconnect(peerId);
      }
    }, delay);
    timer.unref?.();
    this._reconnectTimers.set(peerId, timer);
  }

  _handleWebSocketConnection(socket) {
    if (this._stopped) {
      socket.terminate();
      return;
    }

    let peerId = null;
    let handshakeComplete = false;
    socket._socket?.setTimeout(0);
    socket._socket?.setKeepAlive(true, TCP_KEEP_ALIVE_DELAY_MS);
    const handshakeTimer = setTimeout(() => {
      if (!handshakeComplete) socket.terminate();
    }, HANDSHAKE_TIMEOUT_MS);

    socket.on('message', (raw, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      try {
        const data = JSON.parse(raw.toString('utf8'));
        if (data.type === 'handshake') {
          if (handshakeComplete) return;
          const incomingPeerId = typeof data.peerId === 'string' ? data.peerId.trim() : '';
          if (!isValidPeerId(incomingPeerId) || incomingPeerId === this.id) {
            socket.close(1008, 'Invalid peer identity');
            return;
          }
          peerId = incomingPeerId;

          const existing = this._getActivePeer(peerId);
          const preferredDirection = this._preferredConnectionDirection(peerId);
          if (this._shouldRejectNewConnection(existing, preferredDirection, 'incoming')) {
            socket.terminate();
            return;
          }
          if (existing && !this._isPeerResponsive(existing)) this.disconnectPeer(peerId);

          const remoteAddress = this._normalizeAddress(socket._socket?.remoteAddress || '');
          const info = {
            id: peerId,
            name: typeof data.name === 'string' ? data.name.slice(0, 100) : 'Unknown',
            address: remoteAddress,
            port: Number(data.port) || 0,
            ports: this._normalizePortList(data.ports, data.port),
            connectedAt: Date.now(),
            bio: typeof data.bio === 'string' ? data.bio.slice(0, 500) : '',
            profilePicture:
              typeof data.profilePicture === 'string'
                ? data.profilePicture.slice(0, MAX_PROFILE_PICTURE_DATA_URL_CHARS)
                : '',
            supportsHeartbeat: Number(data.heartbeatVersion) >= 1,
          };

          this._registerPeerConnection(peerId, socket, info, 'incoming');
          this._mergePeerDiscovery(peerId, {
            ...info,
            addresses: this._uniqueStrings([
              remoteAddress,
              ...(Array.isArray(data.addresses) ? data.addresses : []),
            ]),
          });
          if (!this._wsSend(socket, JSON.stringify({
            type: 'handshake-ack',
            peerId: this.id,
            name: this._getDisplayName(),
            port: this.port,
            ports: this.ports,
            addresses: this.getLocalAddresses(),
            heartbeatVersion: 1,
            ...this._getProfileFields(),
          }))) {
            socket.terminate();
            return;
          }
          handshakeComplete = true;
          clearTimeout(handshakeTimer);
          this.emit('peer:connected', info);
          return;
        }

        if (!handshakeComplete || !peerId) {
          socket.close(1008, 'Handshake required');
          return;
        }
        if (this._handlePeerKeepalive(peerId, socket, data)) return;
        if (data.type === 'message') this.emit('peer:message', { ...data, from: peerId });
        else if (data.type === 'file-offer') this.emit('peer:file-offered', { ...data, from: peerId });
      } catch {
        socket.close(1007, 'Invalid message');
      }
    });

    const cleanup = () => {
      clearTimeout(handshakeTimer);
      if (!peerId) return;
      const currentPeer = this.peers.get(peerId);
      if (currentPeer?.socket !== socket) return;
      this.peers.delete(peerId);
      this.emit('peer:disconnected', peerId);
      this._scheduleReconnect(peerId);
    };
    socket.once('close', cleanup);
    socket.on('error', () => {
      /* close event owns peer cleanup */
    });
  }

  // --- WebSocket handling ---
  _handleWebSocketUpgrade(req, socket, head) {
    if (this._stopped) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (
      typeof key !== 'string'
      || !key
      || String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
      || String(req.headers['sec-websocket-version'] || '') !== '13'
    ) {
      socket.destroy();
      return;
    }
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC175D22')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n'
    );

    let peerId = null;
    let handshakeComplete = false;

    socket._bluetalkMaskOutgoing = false;
    socket.setTimeout(0);
    socket.setKeepAlive(true, TCP_KEEP_ALIVE_DELAY_MS);
    const handshakeTimer = setTimeout(() => {
      if (!handshakeComplete) socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);

    socket._bluetalkWsRx = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const onWsText = (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'handshake') {
          if (handshakeComplete) return;
          const incomingPeerId = typeof data.peerId === 'string' ? data.peerId.trim() : '';
          if (!incomingPeerId || incomingPeerId === this.id) {
            socket.destroy();
            return;
          }
          peerId = incomingPeerId;

          const existing = this._getActivePeer(peerId);
          const preferredDirection = this._preferredConnectionDirection(peerId);
          if (this._shouldRejectNewConnection(existing, preferredDirection, 'incoming')) {
            socket.destroy();
            return;
          }
          if (existing && !this._isPeerResponsive(existing)) {
            this.disconnectPeer(peerId);
          }

          const remoteAddress = this._normalizeAddress(socket.remoteAddress);
          const info = {
            id: peerId,
            name: data.name || 'Unknown',
            address: remoteAddress,
            port: data.port,
            ports: this._normalizePortList(data.ports, data.port),
            connectedAt: Date.now(),
            bio: typeof data.bio === 'string' ? data.bio.slice(0, 500) : '',
            profilePicture:
              typeof data.profilePicture === 'string'
                ? data.profilePicture.slice(0, MAX_PROFILE_PICTURE_DATA_URL_CHARS)
                : '',
          };

          this._registerPeerConnection(peerId, socket, info, 'incoming');
          this._mergePeerDiscovery(peerId, {
            ...info,
            addresses: this._uniqueStrings([remoteAddress, ...(data.addresses || [])]),
          });

          const ackSent = this._wsSend(socket, JSON.stringify({
            type: 'handshake-ack',
            peerId: this.id,
            name: this._getDisplayName(),
            port: this.port,
            ports: this.ports,
            addresses: this.getLocalAddresses(),
            ...this._getProfileFields(),
          }));
          if (!ackSent) {
            socket.destroy();
            return;
          }
          handshakeComplete = true;
          clearTimeout(handshakeTimer);
          this.emit('peer:connected', info);
        } else if (peerId && this._handlePeerKeepalive(peerId, socket, data)) {
          /* keepalive */
        } else if (data.type === 'message') {
          if (!handshakeComplete || !peerId) return;
          this.emit('peer:message', { ...data, from: peerId });
        } else if (data.type === 'file-offer') {
          if (!handshakeComplete || !peerId) return;
          this.emit('peer:file-offered', { ...data, from: peerId });
        }
      } catch (e) {
        console.error('[PeerServer] Parse error:', e.message);
      }
    };

    this._pumpWebSocketRx(socket, onWsText);
    socket.on('data', (chunk) => {
      socket._bluetalkWsRx = Buffer.concat([socket._bluetalkWsRx, chunk]);
      this._pumpWebSocketRx(socket, onWsText);
    });

    const cleanup = () => {
      clearTimeout(handshakeTimer);
      if (!peerId) return;
      const currentPeer = this.peers.get(peerId);
      if (currentPeer?.socket !== socket) return;
      this.peers.delete(peerId);
      this.emit('peer:disconnected', peerId);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _encodeFrame(data, options = {}) {
    const payload = Buffer.from(data);
    const opcode = Number.isInteger(options.opcode) ? options.opcode & 0x0f : 0x01;
    const masked = options.mask === true;
    let headerLength = 2;
    if (payload.length < 126) {
      headerLength = 2;
    } else if (payload.length < 65536) {
      headerLength = 4;
    } else {
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frame = Buffer.allocUnsafe(headerLength + maskLength + payload.length);
    frame[0] = 0x80 | opcode;
    if (payload.length < 126) {
      frame[1] = (masked ? 0x80 : 0) | payload.length;
    } else if (payload.length < 65536) {
      frame[1] = (masked ? 0x80 : 0) | 126;
      frame.writeUInt16BE(payload.length, 2);
    } else {
      frame[1] = (masked ? 0x80 : 0) | 127;
      frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    let payloadOffset = headerLength;
    if (masked) {
      const mask = crypto.randomBytes(4);
      mask.copy(frame, headerLength);
      payloadOffset += 4;
      for (let i = 0; i < payload.length; i += 1) {
        frame[payloadOffset + i] = payload[i] ^ mask[i % 4];
      }
    } else {
      payload.copy(frame, payloadOffset);
    }
    return frame;
  }

  /**
   * Consume complete WebSocket frames from an accumulated TCP buffer (handles fragmented TCP packets).
   * Supports WebSocket continuation frames: a text frame with fin=0 starts a fragment sequence,
   * continuation frames (opcode 0x00) carry the rest, and the final frame has fin=1.
   * @param {import('net').Socket} socket
   * @param {(utf8: string) => void} onTextPayload
   */
  _pumpWebSocketRx(socket, onTextPayload) {
    let rx = socket._bluetalkWsRx;
    if (!rx || rx.length === 0) return;

    while (true) {
      const decoded = this._decodeOneWebSocketFrame(rx);
      if (decoded === null) break;
      rx = rx.subarray(decoded.bytesConsumed);
      if (decoded.skip) continue;

      // Handle fragmented messages (continuation frames)
      if (decoded.fragment) {
        if (!socket._bluetalkWsFragBufs) {
          socket._bluetalkWsFragBufs = [];
          socket._bluetalkWsFragLen = 0;
        }
        socket._bluetalkWsFragBufs.push(decoded.payload);
        socket._bluetalkWsFragLen += decoded.payload.length;
        if (socket._bluetalkWsFragLen > MAX_WEBSOCKET_PAYLOAD_BYTES) {
          // Accumulated fragments too large — discard
          socket._bluetalkWsFragBufs = [];
          socket._bluetalkWsFragLen = 0;
        }
        continue;
      }

      if (decoded.fragmentEnd) {
        if (socket._bluetalkWsFragBufs) {
          socket._bluetalkWsFragBufs.push(decoded.payload);
          const full = Buffer.concat(socket._bluetalkWsFragBufs);
          socket._bluetalkWsFragBufs = null;
          socket._bluetalkWsFragLen = 0;
          if (full.length <= MAX_WEBSOCKET_PAYLOAD_BYTES) {
            onTextPayload(full.toString('utf8'));
          }
        }
        continue;
      }

      onTextPayload(decoded.text);
    }
    socket._bluetalkWsRx = rx;
  }

  /**
   * @returns {null | { bytesConsumed: number, skip?: true, text?: string, fragment?: true, fragmentEnd?: true, payload?: Buffer }}
   */
  _decodeOneWebSocketFrame(buffer) {
    if (buffer.length < 2) return null;

    const opcode = buffer[0] & 0x0f;
    const fin = (buffer[0] & 0x80) !== 0;
    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (buffer.length < 4) return null;
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (buffer.length < 10) return null;
      const bigLen = buffer.readBigUInt64BE(2);
      offset = 10;
      const maskBytes = isMasked ? 4 : 0;
      const totalFrame = BigInt(offset + maskBytes) + bigLen;
      if (totalFrame > BigInt(buffer.length)) return null;
      if (bigLen > BigInt(MAX_WEBSOCKET_PAYLOAD_BYTES)) {
        return { bytesConsumed: Number(totalFrame), skip: true };
      }
      payloadLength = Number(bigLen);
    }

    let mask = null;
    if (isMasked) {
      if (buffer.length < offset + 4) return null;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    const frameEnd = offset + payloadLength;
    if (buffer.length < frameEnd) return null;

    let payload = buffer.subarray(offset, frameEnd);
    if (isMasked && mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    // Opcode 0x01 = text, 0x00 = continuation, 0x08 = close, 0x09 = ping, 0x0A = pong
    if (opcode === 0x01 && !fin) {
      // Start of a fragmented text message
      return { bytesConsumed: frameEnd, fragment: true, payload };
    }

    if (opcode === 0x00) {
      // Continuation frame
      if (fin) {
        return { bytesConsumed: frameEnd, fragmentEnd: true, payload };
      }
      return { bytesConsumed: frameEnd, fragment: true, payload };
    }

    if (opcode !== 0x01) {
      return { bytesConsumed: frameEnd, skip: true };
    }

    return {
      bytesConsumed: frameEnd,
      text: payload.toString('utf8'),
    };
  }

  _wsSend(socket, data) {
    try {
      if (typeof socket?.send === 'function' && typeof socket.readyState === 'number') {
        if (socket.readyState !== WebSocket.OPEN) return false;
        const bytes = Buffer.byteLength(String(data));
        if (bytes > MAX_WEBSOCKET_PAYLOAD_BYTES || socket.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
          return false;
        }
        socket.send(data, { binary: false }, (error) => {
          if (error && socket.readyState === WebSocket.OPEN) socket.terminate();
        });
        return true;
      }
      if (!socket || socket.destroyed || !socket.writable) return false;
      const frame = this._encodeFrame(data, { mask: socket._bluetalkMaskOutgoing === true });
      if (frame.length > MAX_WEBSOCKET_PAYLOAD_BYTES + 14) {
        console.error('[PeerServer] Payload too large');
        return false;
      }
      socket.write(frame);
      return true;
    } catch (e) {
      console.error('[PeerServer] Send error:', e.message);
      return false;
    }
  }

  sendTo(peerId, data) {
    const peer = this._getActivePeer(peerId);
    if (!peer) return false;
    const ts = typeof data?.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : Date.now();
    const payload = JSON.stringify({
      ...data,
      type: 'message',
      timestamp: ts,
    });
    const sent = this._wsSend(peer.socket, payload);
    if (!sent) {
      this._cleanupDeadPeer(peerId);
    }
    return sent;
  }

  /**
   * Send one payload to an explicit set of peers. This deliberately does not
   * fall back to broadcast: callers such as group chat must define the exact
   * recipients for every protocol frame.
   */
  sendMany(peerIds, data) {
    const ids = [...new Set((Array.isArray(peerIds) ? peerIds : []).filter(isValidPeerId))];
    return ids.map((peerId) => ({ peerId, sent: this.sendTo(peerId, data) }));
  }

  broadcast(data) {
    const ts = typeof data?.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : Date.now();
    const payload = JSON.stringify({
      ...data,
      type: 'message',
      timestamp: ts,
    });
    const results = [];
    for (const id of [...this.peers.keys()]) {
      const peer = this._getActivePeer(id);
      if (!peer) continue;
      const sent = this._wsSend(peer.socket, payload);
      if (!sent) {
        this._cleanupDeadPeer(id);
      }
      results.push({ peerId: id, sent });
    }
    return results;
  }

  _cleanupDeadPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        if (typeof peer.socket.terminate === 'function') peer.socket.terminate();
        else peer.socket.destroy();
      } catch {}
      this.peers.delete(peerId);
      this.emit('peer:disconnected', peerId);
      this._scheduleReconnect(peerId);
    }
  }

  disconnectPeer(peerId, options = {}) {
    const peer = this.peers.get(peerId);
    if (peer) {
      this._sendWebSocketClose(peer.socket);
      if (typeof peer.socket.terminate === 'function') peer.socket.terminate();
      else peer.socket.destroy();
      const currentPeer = this.peers.get(peerId);
      if (currentPeer?.socket === peer.socket) {
        this.peers.delete(peerId);
      }
      this.emit('peer:disconnected', peerId);
      if (options.reconnect === true) this._scheduleReconnect(peerId);
      else this._clearReconnect(peerId);
    }
  }

  hostFile(fileMeta) {
    if (!fileMeta || typeof fileMeta.data !== 'string') throw new Error('Invalid file data');
    const normalizedBase64 = fileMeta.data.replace(/\s+/g, '');
    if (!normalizedBase64 || normalizedBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) {
      throw new Error('Invalid base64 file data');
    }
    const fileId = crypto.randomBytes(12).toString('hex');
    let data;
    try {
      data = Buffer.from(normalizedBase64, 'base64');
    } catch (e) {
      throw new Error('Invalid base64 file data');
    }
    if (data.length > MAX_HOSTED_FILE_BYTES) throw new Error('Hosted file exceeds the 8 MB limit');
    while (
      this.hostedFiles.size >= MAX_HOSTED_FILES
      || [...this.hostedFiles.values()].reduce((total, file) => total + file.data.length, 0) + data.length > MAX_TOTAL_HOSTED_FILE_BYTES
    ) {
      const oldestId = this.hostedFiles.keys().next().value;
      if (!oldestId) break;
      this.hostedFiles.delete(oldestId);
    }
    this.hostedFiles.set(fileId, {
      id: fileId,
      name: safeDownloadName(fileMeta.name),
      size: data.length,
      type: safeContentType(fileMeta.type),
      data,
      createdAt: Date.now(),
    });

    this.broadcast({
      kind: 'file-hosted',
      fileId,
      fileName: fileMeta.name,
      fileSize: fileMeta.size,
      fileType: fileMeta.type,
    });

    return { fileId, url: `http://localhost:${this.port}/bt/files/${fileId}` };
  }

  getHostedFiles() {
    const files = [];
    for (const [id, file] of this.hostedFiles) {
      files.push({
        id,
        name: file.name,
        size: file.size,
        type: file.type,
        url: `http://localhost:${this.port}/bt/files/${id}`,
        createdAt: file.createdAt,
      });
    }
    return files;
  }

  async requestFile(peerId, fileId) {
    const peer = this._getActivePeer(peerId);
    if (!peer) throw new Error('Peer not connected');
    const port = peer.info.port;
    const host = peer.info.address;

    if (!/^[a-f0-9]{24}$/.test(String(fileId || ''))) throw new Error('Invalid file id');

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = http.get({ host, port, path: `/bt/files/${fileId}` }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finishReject(new Error(`Peer returned HTTP ${res.statusCode}`));
          return;
        }
        const declaredLength = Number(res.headers['content-length']) || 0;
        if (declaredLength > MAX_HOSTED_FILE_BYTES) {
          request.destroy(new Error('Peer file exceeds the 8 MB limit'));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_HOSTED_FILE_BYTES) {
            request.destroy(new Error('Peer file exceeds the 8 MB limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks);
          const info = {
            fileId,
            data: data.toString('base64'),
            name: safeDownloadName(res.headers['content-disposition']?.match(/filename="([^"]+)"/)?.[1] || 'file'),
            type: safeContentType(res.headers['content-type']),
            size: data.length,
          };
          settled = true;
          this.emit('peer:file-received', info);
          resolve(info);
        });
      });
      request.setTimeout(FILE_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('File request timed out')));
      request.on('error', finishReject);
    });
  }

  getInfo() {
    const addresses = this.getLocalAddresses();
    return {
      id: this.id,
      name: this._getDisplayName(),
      port: this.port,
      ports: [...this.ports],
      addresses,
      endpoints: this._getEndpointList(addresses, this.ports),
      peers: this.getPeers(),
      hostedFiles: this.getHostedFiles(),
    };
  }

  getPeers() {
    const peers = [];
    for (const [id] of this.peers) {
      const peer = this._getActivePeer(id);
      if (!peer) continue;
      peers.push({
        id,
        ...peer.info,
        ports: this._normalizePortList(peer.info.ports, peer.info.port),
      });
    }
    return peers;
  }

  /**
   * After the on-disk store was wiped, reload identity from store (or create a new peer id).
   * Does not start listeners; call start() afterwards.
   */
  reloadIdentityFromStore() {
    // Disconnect all peers before clearing state
    for (const [id, peer] of this.peers) {
      try {
        this._wsSend(peer.socket, JSON.stringify({ type: 'bye' }));
        this._sendWebSocketClose(peer.socket);
        if (typeof peer.socket.terminate === 'function') peer.socket.terminate();
        else peer.socket.destroy();
      } catch {}
    }
    this.peers.clear();
    this.id = this.store.get('peerId') || this._generateId();
    if (!this.store.get('peerId')) {
      this.store.set('peerId', this.id);
    }
    this.hostedFiles.clear();
    this.discoveredPeers.clear();
    this._pendingConnections.clear();
  }

  _sendWebSocketClose(socket) {
    try {
      if (typeof socket?.close === 'function' && typeof socket.readyState === 'number') {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, 'Closing');
        }
        return;
      }
      if (!socket || socket.destroyed || !socket.writable) return;
      const closeFrame = this._encodeFrame('', {
        opcode: 0x08,
        mask: socket._bluetalkMaskOutgoing === true,
      });
      socket.write(closeFrame);
    } catch {}
  }

  /**
   * Re-dial saved contact addresses (best-effort) after network-related settings change.
   */
  reconnectContactsFromStore() {
    const contacts = this.store.get('contacts', []);
    if (!Array.isArray(contacts)) return;
    for (const contact of contacts) {
      if (!contact?.id || !contact?.address || typeof contact.address !== 'string' || contact.blocked === true) continue;
      if (this._getActivePeer(contact.id)) continue;
      this._clearReconnect(contact.id);
      void this.connectTo({ id: contact.id, address: contact.address }).catch(() => {
        this._scheduleReconnect(contact.id);
      });
    }
  }

  /**
   * Close every active peer connection, then re-dial saved contacts and refresh LAN discovery.
   */
  async resetAllConnectionsAndReconnect() {
    const ids = [...this.peers.keys()];
    for (const id of ids) {
      this.disconnectPeer(id);
    }
    // Wait for sockets to fully close before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 500));
    this.reconnectContactsFromStore();
    this.refreshDiscovery();
  }

  stop() {
    this._stopped = true;
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._discoveryTimer) {
      clearInterval(this._discoveryTimer);
      this._discoveryTimer = null;
    }
    if (this.discoverySocket) {
      try {
        this.discoverySocket.removeAllListeners();
        this.discoverySocket.close();
      } catch {}
      this.discoverySocket = null;
    }
    for (const [, peer] of this.peers) {
      try {
        this._wsSend(peer.socket, JSON.stringify({ type: 'bye' }));
        this._sendWebSocketClose(peer.socket);
        if (typeof peer.socket.terminate === 'function') peer.socket.terminate();
        else peer.socket.destroy();
      } catch {}
    }
    this.peers.clear();
    for (const attempt of [...this._activeConnectionAttempts]) {
      try {
        attempt.cancel();
      } catch {}
    }
    this._activeConnectionAttempts.clear();
    for (const timer of this._reconnectTimers.values()) clearTimeout(timer);
    this._reconnectTimers.clear();
    this._reconnectAttempts.clear();
    for (const server of this.servers) {
      try {
        server.removeAllListeners();
        server.close();
      } catch {}
    }
    this.servers = [];
    this.server = null;
    this.ports = [];
    this.port = 0;
    this._pendingConnections.clear();
  }
}

module.exports = { PeerServer, normalizeConnectAddress, isLoopbackConnectAddress };
