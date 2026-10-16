/** Öffentlicher Relay, wenn keine eigene Herkunft greift. */
const PUBLIC_RELAY_URL = 'wss://bt.henny.dev/v1/ws';

function isWebBuild() {
  return typeof __BLUETALK_WEB__ !== 'undefined' && Boolean(__BLUETALK_WEB__);
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/** Aus http(s)-Herkunft die Relay-URL ableiten; ws:// nur Loopback, sonst wss. */
export function relayUrlFromLocation(loc) {
  const protocol = loc?.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return PUBLIC_RELAY_URL;
  const host = loc.host;
  if (!host) return PUBLIC_RELAY_URL;
  const scheme = protocol === 'http:' && isLoopbackHostname(loc.hostname) ? 'ws' : 'wss';
  return `${scheme}://${host}/v1/ws`;
}

/** Web-Build: eigene Herkunft. Desktop bleibt beim öffentlichen Relay. */
export function defaultRelayUrl() {
  if (isWebBuild()) {
    try {
      return relayUrlFromLocation(globalThis.location);
    } catch {
      /* Fallback */
    }
  }
  return PUBLIC_RELAY_URL;
}

export class CloudApiError extends Error {
  constructor(code, message, status = 0) {
    super(safeMessage(code, message));
    this.name = 'CloudApiError';
    this.code = code || 'error';
    this.status = status;
  }
}

function safeMessage(code, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return code || 'error';
  if (/token|authKey|password|encKey|macKey|seed|vault/i.test(text) && text.length > 80) {
    return code || 'error';
  }
  return text;
}

export function httpBaseFromRelayUrl(relayUrl) {
  try {
    const fallback = defaultRelayUrl();
    const url = new URL(String(relayUrl || fallback).trim() || fallback);
    const loopback = isLoopbackHostname(url.hostname);
    const insecure = url.protocol === 'ws:' || url.protocol === 'http:';
    const protocol = insecure && loopback ? 'http:' : 'https:';
    return `${protocol}//${url.host}`;
  } catch {
    try {
      if (isWebBuild() && (location.protocol === 'http:' || location.protocol === 'https:') && location.origin) {
        return location.origin;
      }
    } catch {
      /* öffentlicher Fallback */
    }
    return 'https://bt.henny.dev';
  }
}

async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const code = body?.error || (response.status === 401 ? 'unauthorized' : `http_${response.status}`);
  const message = body?.message || response.statusText || code;
  return new CloudApiError(code, message, response.status);
}

export function createCloudApi(baseUrl, getToken) {
  const root = String(baseUrl || '').replace(/\/+$/, '');

  async function request(method, path, body, options = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!options.noAuth) {
      const token = typeof getToken === 'function' ? getToken() : '';
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetch(`${root}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new CloudApiError('network', 'Cloud-Server ist nicht erreichbar.');
    }
    if (response.status === 204) return null;
    if (!response.ok) throw await readError(response);
    if (response.status === 201 || response.headers.get('content-type')?.includes('json')) {
      try {
        return await response.json();
      } catch {
        return null;
      }
    }
    return response.json();
  }

  return {
    prelogin: (username) => request('POST', '/v1/account/prelogin', { username }, { noAuth: true }),
    register: (payload) => request('POST', '/v1/account/register', payload, { noAuth: true }),
    login: (payload) => request('POST', '/v1/account/login', payload, { noAuth: true }),
    me: () => request('GET', '/v1/account/me'),
    logout: () => request('POST', '/v1/account/logout'),
    changePassword: (payload) => request('POST', '/v1/account/password', payload),
    deleteAccount: (payload) => request('DELETE', '/v1/account', payload),
    lookup: (username) => request(
      'GET',
      `/v1/account/lookup?username=${encodeURIComponent(username)}`,
      undefined,
      { noAuth: true },
    ),
    push: (items) => request('POST', '/v1/sync/push', { items }),
    pull: (after = 0, limit = 200) => request(
      'GET',
      `/v1/sync/pull?after=${encodeURIComponent(String(after || 0))}&limit=${encodeURIComponent(String(limit || 200))}`,
    ),
    deleteKeys: (keys) => request('POST', '/v1/sync/delete', { keys }),
  };
}
