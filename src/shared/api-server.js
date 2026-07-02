const http = require('http');
const crypto = require('crypto');

const MAX_API_BODY_BYTES = 12 * 1024 * 1024;
const API_BIND_HOST = '127.0.0.1';

/**
 * APIServer - HTTP REST API for external real-time actions.
 * Runs on a configurable port and exposes endpoints for:
 *  - Sending messages
 *  - Managing peers
 *  - Hosting/requesting files
 *  - Subscribing to events via SSE (Server-Sent Events)
 */
class APIServer {
  constructor(peerServer, store, options = {}) {
    this.peerServer = peerServer;
    this.store = store;
    this.server = null;
    this.sseClients = new Set();
    // Callback des Main-Prozesses, damit REST-Settings-Writes dieselben
    // Seiteneffekte auslösen wie Änderungen über die UI (Port-Rebind etc.).
    this.onSettingsChanged = typeof options.onSettingsChanged === 'function' ? options.onSettingsChanged : null;
    this.token = store.get('apiToken', '') || store.get('settings.apiToken', '') || crypto.randomBytes(32).toString('hex');
    if (!store.get('apiToken', '')) store.set('apiToken', this.token);
    store.delete?.('settings.apiToken');
    this._setupEventForwarding();
  }

  _setupEventForwarding() {
    if (this._eventForwarders) {
      // Remove old listeners if re-initializing
      for (const [event, handler] of this._eventForwarders) {
        this.peerServer.removeListener(event, handler);
      }
    }
    this._eventForwarders = new Map();
    const events = ['peer:connected', 'peer:disconnected', 'peer:message', 'peer:file-offered', 'peer:file-received'];
    for (const event of events) {
      const handler = (data) => {
        this._broadcastSSE(event, data);
      };
      this._eventForwarders.set(event, handler);
      this.peerServer.on(event, handler);
    }
  }

  _broadcastSSE(event, data) {
    let serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > 1024 * 1024) {
      serialized = JSON.stringify({
        from: data?.from,
        kind: data?.kind,
        messageId: data?.messageId,
        timestamp: data?.timestamp,
        payloadOmitted: true,
      });
    }
    const payload = `event: ${event}\ndata: ${serialized}\n\n`;
    for (const client of this.sseClients) {
      try {
        if (!client.write(payload)) {
          client.end();
          this.sseClients.delete(client);
        }
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  _json(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }

  _isAuthorized(req) {
    const value = String(req.headers.authorization || '');
    const provided = value.startsWith('Bearer ') ? value.slice(7).trim() : '';
    const expected = Buffer.from(this.token);
    const actual = Buffer.from(provided);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooLarge = false;
      req.on('data', (chunk) => {
        if (tooLarge) return;
        size += chunk.length;
        if (size > MAX_API_BODY_BYTES) {
          tooLarge = true;
          chunks.length = 0;
          const error = new Error('Request body too large');
          error.statusCode = 413;
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return;
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          const error = new Error('Invalid JSON body');
          error.statusCode = 400;
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  start(port) {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
    }

    const listenPort = Number(port);
    if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535) {
      throw new Error('Invalid API port');
    }

    this.server = http.createServer(async (req, res) => {
      if (req.headers.origin) {
        return this._json(res, 403, { error: 'Browser-origin requests are not allowed' });
      }

      if (req.method === 'OPTIONS') {
        res.writeHead(204, { Allow: 'GET, POST, PUT, DELETE, OPTIONS' });
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${API_BIND_HOST}:${listenPort}`);
      const path = url.pathname;

      try {
        if (path === '/api/health' && req.method === 'GET') {
          return this._json(res, 200, { ok: true });
        }
        if (!this._isAuthorized(req)) {
          return this._json(res, 401, { error: 'Unauthorized' });
        }

        // -- SSE Events Stream --
        if (path === '/api/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Content-Type-Options': 'nosniff',
          });
          res.write('event: connected\ndata: {"status":"ok"}\n\n');
          this.sseClients.add(res);
          const removeClient = () => this.sseClients.delete(res);
          req.on('close', removeClient);
          res.on('error', removeClient);
          return;
        }

        // -- Info --
        if (path === '/api/info' && req.method === 'GET') {
          return this._json(res, 200, this.peerServer.getInfo());
        }

        // -- Peers --
        if (path === '/api/peers' && req.method === 'GET') {
          return this._json(res, 200, { peers: this.peerServer.getPeers() });
        }

        if (path === '/api/peers/connect' && req.method === 'POST') {
          const body = await this._readBody(req);
          const peerInfo = await this.peerServer.connectTo(body.address);
          return this._json(res, 200, { ok: true, peer: peerInfo });
        }

        if (path === '/api/peers/disconnect' && req.method === 'POST') {
          const body = await this._readBody(req);
          this.peerServer.disconnectPeer(body.peerId);
          return this._json(res, 200, { ok: true });
        }

        // -- Messages --
        if (path === '/api/send' && req.method === 'POST') {
          const body = await this._readBody(req);
          const ok = this.peerServer.sendTo(body.peerId, body.data);
          return this._json(res, ok ? 200 : 404, { ok });
        }

        if (path === '/api/broadcast' && req.method === 'POST') {
          const body = await this._readBody(req);
          this.peerServer.broadcast(body.data);
          return this._json(res, 200, { ok: true });
        }

        // -- Files --
        if (path === '/api/files' && req.method === 'GET') {
          return this._json(res, 200, { files: this.peerServer.getHostedFiles() });
        }

        if (path === '/api/files/host' && req.method === 'POST') {
          const body = await this._readBody(req);
          const result = this.peerServer.hostFile(body);
          return this._json(res, 200, { ok: true, ...result });
        }

        if (path === '/api/files/request' && req.method === 'POST') {
          const body = await this._readBody(req);
          const file = await this.peerServer.requestFile(body.peerId, body.fileId);
          return this._json(res, 200, { ok: true, file });
        }

        // -- Settings --
        if (path === '/api/settings' && req.method === 'GET') {
          return this._json(res, 200, {
            displayName: this.store.get('settings.displayName', 'Anonymous'),
            peerPort: this.store.get('settings.peerPort', 0),
            peerPorts: this.store.get('settings.peerPorts', []),
            apiPort: this.store.get('settings.apiPort', 19876),
            autoUpdateEnabled: this.store.get('settings.autoUpdateEnabled', true),
            autoDownloadUpdates: this.store.get('settings.autoDownloadUpdates', true),
            minimizeToTray: this.store.get('settings.minimizeToTray', true),
            theme: this.store.get('settings.theme', 'dark'),
          });
        }

        if (path === '/api/settings' && req.method === 'PUT') {
          const body = await this._readBody(req);
          // Nur die auch per GET exponierten Einstellungen sind schreibbar,
          // mit Typprüfung — sonst könnten beliebige settings.*-Schlüssel
          // mit beliebigen Typen überschrieben werden.
          const validators = {
            displayName: (v) => typeof v === 'string' && v.length <= 80,
            peerPort: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
            peerPorts: (v) => Array.isArray(v) && v.every((p) => Number.isInteger(p) && p >= 0 && p <= 65535),
            apiPort: (v) => Number.isInteger(v) && v >= 0 && v <= 65535,
            autoUpdateEnabled: (v) => typeof v === 'boolean',
            autoDownloadUpdates: (v) => typeof v === 'boolean',
            minimizeToTray: (v) => typeof v === 'boolean',
            theme: (v) => v === 'dark' || v === 'light',
          };
          const rejected = [];
          const applied = [];
          for (const [key, value] of Object.entries(body)) {
            if (!validators[key] || !validators[key](value)) {
              rejected.push(key);
              continue;
            }
            this.store.set(`settings.${key}`, value);
            applied.push(key);
            try {
              this.onSettingsChanged?.(`settings.${key}`);
            } catch { /* ignore */ }
          }
          return this._json(res, 200, { ok: rejected.length === 0, applied, rejected });
        }

        // -- 404 --
        this._json(res, 404, { error: 'Not found' });
      } catch (err) {
        if (!res.headersSent) this._json(res, err.statusCode || 500, { error: err.message });
        else res.end();
      }
    });

    this.server.on('error', (error) => {
      console.error(`[APIServer] Could not listen on ${API_BIND_HOST}:${listenPort}:`, error.message);
    });
    this.server.listen(listenPort, API_BIND_HOST, () => {
      const actualPort = this.server?.address()?.port || listenPort;
      console.log(`[APIServer] REST API listening on ${API_BIND_HOST}:${actualPort}`);
    });
    return this.server;
  }

  stop(callback) {
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    this.sseClients.clear();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      srv.close(() => {
        if (callback) callback();
      });
    } else if (callback) {
      callback();
    }
  }
}

module.exports = { APIServer };
