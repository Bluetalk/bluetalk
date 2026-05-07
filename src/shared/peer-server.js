const { EventEmitter } = require('events');
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

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
const MAX_PROFILE_PICTURE_DATA_URL_CHARS = 2 * 1024 * 1024;
/** Reject absurd frames to avoid OOM (chat attachments are large but not multi‑GB over this JSON transport). */
/** Large chat attachments (base64 JSON). 512 MiB cap per assembled WS text frame. */
const MAX_WEBSOCKET_PAYLOAD_BYTES = 512 * 1024 * 1024;
const DISCOVERY_PORT = 41234;
const DISCOVERY_INTERVAL = 5000;
const DISCOVERY_MAGIC = 'BLUETALK_V2';
const CONNECTION_TIMEOUT_MS = 3000;

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
    const started = await this._startListeningServers();
    if (!started) {
      console.error('[PeerServer] Failed to bind to any port');
      return;
    }

    this.store.set('settings.peerPort', this.port);
    this.store.set('settings.peerPorts', this.ports);
    console.log(`[PeerServer] Listening on ports ${this.ports.join(', ')}`);
    this._startDiscovery();
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
      if (req.url === '/bt/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this.getInfo()));
        return;
      }

      if (req.url?.startsWith('/bt/files/')) {
        const fileId = req.url.split('/bt/files/')[1];
        const file = this.hostedFiles.get(fileId);
        if (file) {
          res.writeHead(200, {
            'Content-Type': file.type || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${file.name}"`,
            'Content-Length': file.data.length,
          });
          res.end(file.data);
          return;
        }
        res.writeHead(404);
        res.end('File not found');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
    });

    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/bt/ws') {
        socket.destroy();
        return;
      }
      this._handleWebSocketUpgrade(req, socket, head);
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

          const discoveredPeer = this._rememberDiscoveredPeer(data, rinfo);

          if (!data.response) {
            this._broadcastPresence([this._normalizeAddress(rinfo.address)], { response: true });
          }

          if (this.peers.has(discoveredPeer.id)) {
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
      if (!id || id === this.id || this.peers.has(id)) continue;
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
      return {
        peerId: target.id || target.peerId,
        name: target.name,
        host: this._normalizeAddress(target.host || target.address || target.sourceAddress || ''),
        address: this._normalizeAddress(target.address || target.host || target.sourceAddress || ''),
        addresses: this._uniqueStrings([
          target.host,
          target.address,
          target.sourceAddress,
          ...(target.addresses || []),
        ].map((address) => this._normalizeAddress(address))),
        ports: this._normalizePortList(target.ports, target.port, target.primaryPort),
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

    const ports = this._normalizePortList(
      descriptor.ports,
      discovered?.ports,
      this.store.get('settings.peerPorts', []),
      this.store.get('settings.peerPort', 0),
      PORT_CANDIDATES
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
    const normalized = typeof target === 'string' ? normalizeConnectAddress(target) : target;
    const descriptor = this._createConnectionDescriptor(normalized);

    if (descriptor.peerId && this.peers.has(descriptor.peerId)) {
      return this.peers.get(descriptor.peerId).info;
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

    for (const candidate of candidates) {
      if (descriptor.peerId && this.peers.has(descriptor.peerId)) {
        return this.peers.get(descriptor.peerId).info;
      }

      try {
        return await this._connectToCandidate(candidate, descriptor);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('Connection failed');
  }

  _connectToCandidate(candidate, descriptor) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: candidate.host,
        port: candidate.port,
        path: '/bt/ws',
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
        },
      });

      let settled = false;
      let pendingPromise = null;

      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      req.on('response', (res) => {
        finishReject(new Error(`Peer returned HTTP ${res.statusCode || 500}`));
      });

      req.on('upgrade', (res, socket) => {
        let peerId = descriptor.peerId || null;

        socket.setTimeout(30000);
        socket.on('timeout', () => {
          socket.destroy();
        });

        this._wsSend(socket, JSON.stringify({
          type: 'handshake',
          peerId: this.id,
          name: this._getDisplayName(),
          port: this.port,
          ports: this.ports,
          addresses: this.getLocalAddresses(),
          ...this._getProfileFields(),
        }));

        socket._bluetalkWsRx = Buffer.alloc(0);
        socket.on('data', (chunk) => {
          socket._bluetalkWsRx = Buffer.concat([socket._bluetalkWsRx, chunk]);
          this._pumpWebSocketRx(socket, (message) => {
            try {
              const data = JSON.parse(message);

              if (data.type === 'handshake-ack') {
                peerId = data.peerId;

                if (this.peers.has(peerId)) {
                  socket.destroy();
                  finishResolve(this.peers.get(peerId).info);
                  return;
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

                this.peers.set(peerId, { socket, info });
                this._mergePeerDiscovery(peerId, info);
                this.emit('peer:connected', info);
                finishResolve(info);
                return;
              }

              if (data.type === 'message') {
                this.emit('peer:message', { from: peerId, ...data });
                return;
              }

              if (data.type === 'file-offer') {
                this.emit('peer:file-offered', { from: peerId, ...data });
              }
            } catch (e) {
              console.error('[PeerServer] Parse error:', e.message);
            }
          });
        });

        const cleanup = () => {
          if (!peerId) {
            // If handshake never completed, ensure pending connection is cleared
            this._pendingConnections.forEach((value, key) => {
              if (value === pendingPromise) {
                this._pendingConnections.delete(key);
              }
            });
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

      // Store reference to this promise for cleanup handlers
      pendingPromise = this._pendingConnections.get(
        descriptor.peerId || candidates.map((c) => `${c.host}:${c.port}`).sort().join('|')
      );
    });
  }

  // --- WebSocket handling ---
  _handleWebSocketUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
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

    socket._bluetalkWsRx = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    const onWsText = (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'handshake') {
          peerId = data.peerId;
          if (this.peers.has(peerId)) {
            socket.destroy();
            return;
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

          this.peers.set(peerId, { socket, info });
          this._mergePeerDiscovery(peerId, {
            ...info,
            addresses: this._uniqueStrings([remoteAddress, ...(data.addresses || [])]),
          });

          this._wsSend(socket, JSON.stringify({
            type: 'handshake-ack',
            peerId: this.id,
            name: this._getDisplayName(),
            port: this.port,
            ports: this.ports,
            addresses: this.getLocalAddresses(),
            ...this._getProfileFields(),
          }));
          this.emit('peer:connected', info);
        } else if (data.type === 'message') {
          this.emit('peer:message', { from: peerId, ...data });
        } else if (data.type === 'file-offer') {
          this.emit('peer:file-offered', { from: peerId, ...data });
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
      if (!peerId) return;
      const currentPeer = this.peers.get(peerId);
      if (currentPeer?.socket !== socket) return;
      this.peers.delete(peerId);
      this.emit('peer:disconnected', peerId);
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  _encodeFrame(data) {
    const payload = Buffer.from(data);
    const frame = [];
    frame.push(0x81);
    if (payload.length < 126) {
      frame.push(payload.length);
    } else if (payload.length < 65536) {
      frame.push(126);
      frame.push((payload.length >> 8) & 0xff);
      frame.push(payload.length & 0xff);
    } else {
      frame.push(127);
      for (let i = 7; i >= 0; i--) {
        frame.push((payload.length >> (i * 8)) & 0xff);
      }
    }
    return Buffer.concat([Buffer.from(frame), payload]);
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
      if (!socket || socket.destroyed || !socket.writable) return false;
      const frame = this._encodeFrame(data);
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
    const peer = this.peers.get(peerId);
    if (!peer || !peer.socket) return false;
    const ts = typeof data?.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : Date.now();
    const payload = JSON.stringify({
      type: 'message',
      ...data,
      timestamp: ts,
    });
    const sent = this._wsSend(peer.socket, payload);
    if (!sent) {
      this._cleanupDeadPeer(peerId);
    }
    return sent;
  }

  broadcast(data) {
    const ts = typeof data?.timestamp === 'number' && Number.isFinite(data.timestamp) ? data.timestamp : Date.now();
    const payload = JSON.stringify({
      type: 'message',
      ...data,
      timestamp: ts,
    });
    const results = [];
    for (const [id, peer] of this.peers) {
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
        peer.socket.destroy();
      } catch {}
      this.peers.delete(peerId);
      this.emit('peer:disconnected', peerId);
    }
  }

  disconnectPeer(peerId) {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.socket.destroy();
      const currentPeer = this.peers.get(peerId);
      if (currentPeer?.socket === peer.socket) {
        this.peers.delete(peerId);
      }
      this.emit('peer:disconnected', peerId);
    }
  }

  hostFile(fileMeta) {
    const fileId = crypto.randomBytes(6).toString('hex');
    let data;
    try {
      data = Buffer.from(fileMeta.data, 'base64');
    } catch (e) {
      throw new Error('Invalid base64 file data');
    }
    this.hostedFiles.set(fileId, {
      id: fileId,
      name: fileMeta.name,
      size: fileMeta.size,
      type: fileMeta.type,
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
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Peer not connected');
    const port = peer.info.port;
    const host = peer.info.address;

    return new Promise((resolve, reject) => {
      http.get(`http://${host}:${port}/bt/files/${fileId}`, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Peer returned HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          const info = {
            fileId,
            data: data.toString('base64'),
            name: res.headers['content-disposition']?.match(/filename="(.+)"/)?.[1] || 'file',
            type: res.headers['content-type'],
            size: data.length,
          };
          this.emit('peer:file-received', info);
          resolve(info);
        });
      }).on('error', reject);
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
    for (const [id, peer] of this.peers) {
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
        this._sendWebSocketClose(peer.socket);
        peer.socket.destroy();
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
      if (!socket || socket.destroyed || !socket.writable) return;
      // WebSocket close frame: opcode 0x08
      const closeFrame = Buffer.from([0x88, 0x00]);
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
      if (!contact?.address || typeof contact.address !== 'string') continue;
      void this.connectTo(contact.address).catch(() => {});
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
        this._sendWebSocketClose(peer.socket);
        peer.socket.destroy();
      } catch {}
    }
    this.peers.clear();
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

module.exports = { PeerServer, normalizeConnectAddress };
