const http = require('http');

/**
 * APIServer - HTTP REST API for external real-time actions.
 * Runs on a configurable port and exposes endpoints for:
 *  - Sending messages
 *  - Managing peers
 *  - Hosting/requesting files
 *  - Subscribing to events via SSE (Server-Sent Events)
 */
class APIServer {
  constructor(peerServer, store) {
    this.peerServer = peerServer;
    this.store = store;
    this.server = null;
    this.sseClients = new Set();
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
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  _json(res, statusCode, data) {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end(JSON.stringify(data));
  }

  _readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve({});
        }
      });
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

    this.server = http.createServer(async (req, res) => {
      // CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const path = url.pathname;

      try {
        // -- SSE Events Stream --
        if (path === '/api/events' && req.method === 'GET') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
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
          for (const [key, value] of Object.entries(body)) {
            this.store.set(`settings.${key}`, value);
          }
          return this._json(res, 200, { ok: true });
        }

        // -- 404 --
        this._json(res, 404, { error: 'Not found' });
      } catch (err) {
        this._json(res, 500, { error: err.message });
      }
    });

    this.server.listen(port, () => {
      console.log(`[APIServer] REST API listening on port ${port}`);
    });
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
