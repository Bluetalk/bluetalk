const test = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const http = require('node:http');
const { APIServer } = require('../src/shared/api-server');

class MemoryStore {
  constructor() {
    this.data = {};
  }
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
  }
  delete(key) {
    delete this.data[key];
  }
}

class MockPeerServer extends EventEmitter {
  getInfo() {
    return { id: 'bt-api-test', peers: [] };
  }
  getPeers() {
    return [];
  }
}

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('REST API binds to loopback and requires a bearer token', async () => {
  const store = new MemoryStore();
  const api = new APIServer(new MockPeerServer(), store);
  const server = api.start(0);
  await once(server, 'listening');
  const address = server.address();
  try {
    assert.equal(address.address, '127.0.0.1');
    assert.match(store.get('apiToken', ''), /^[a-f0-9]{64}$/);

    const health = await request(address.port, '/api/health');
    assert.equal(health.status, 200);

    const denied = await request(address.port, '/api/info');
    assert.equal(denied.status, 401);

    const authorized = await request(address.port, '/api/info', {
      headers: { Authorization: `Bearer ${api.token}` },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body.id, 'bt-api-test');

    const browserRequest = await request(address.port, '/api/info', {
      headers: { Authorization: `Bearer ${api.token}`, Origin: 'https://attacker.example' },
    });
    assert.equal(browserRequest.status, 403);
  } finally {
    await new Promise((resolve) => api.stop(resolve));
  }
});

test('REST API rejects malformed JSON without executing actions', async () => {
  const api = new APIServer(new MockPeerServer(), new MemoryStore());
  const server = api.start(0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const result = await request(port, '/api/peers/connect', {
      method: 'POST',
      headers: { Authorization: `Bearer ${api.token}`, 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(result.status, 400);
  } finally {
    await new Promise((resolve) => api.stop(resolve));
  }
});
