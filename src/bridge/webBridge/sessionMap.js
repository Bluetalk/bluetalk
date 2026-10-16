/** Reine Multi-Device-Logik: Öffner-Regel, Geräte-Keys, Sitzungs-Map. */

export const LEGACY_DEVICE_KEY = 'legacy';
export const DIRECT_DEVICE_KEY = 'direct';
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const DEVICE_NAME_MAX = 64;

/** Server- und Store-fähige Geräte-ID (16 Byte hex oder bereits gespeicherte UUID). */
export function isValidDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID_RE.test(value);
}

export function normalizeDeviceKey(value) {
  const id = String(value || '').trim();
  if (!id || id === LEGACY_DEVICE_KEY) return LEGACY_DEVICE_KEY;
  if (id === DIRECT_DEVICE_KEY) return DIRECT_DEVICE_KEY;
  if (DEVICE_ID_RE.test(id)) return id;
  return LEGACY_DEVICE_KEY;
}

export function newDeviceId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function webDeviceName(userAgent) {
  const ua = String(
    userAgent
    || (typeof navigator !== 'undefined' ? navigator.userAgent : '')
    || '',
  );
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
  else if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua) || /FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return `BlueTalk Web · ${browser}`.slice(0, DEVICE_NAME_MAX);
}

export function sessionKey(peerId, deviceKey) {
  return `${peerId}\x1f${normalizeDeviceKey(deviceKey)}`;
}

export function openerToken(peerId, deviceKey) {
  return `${peerId}/${normalizeDeviceKey(deviceKey)}`;
}

/**
 * Wer den Relay-Tunnel öffnet: das Paar mit dem lexikografisch kleineren
 * `peerId + "/" + deviceId`. Gegenstellen ohne Gerät zählen als `legacy`.
 */
export function shouldOpenTunnel(ourPeerId, ourDeviceKey, remotePeerId, remoteDeviceKey) {
  const ours = String(ourPeerId || '');
  const theirs = String(remotePeerId || '');
  if (!ours || !theirs || ours === theirs) return false;
  return openerToken(ours, ourDeviceKey) < openerToken(theirs, remoteDeviceKey);
}

export function parseDeviceList(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const rawId = typeof item === 'string' ? item : item?.id;
    const trimmed = String(rawId || '').trim();
    if (
      !isValidDeviceId(trimmed)
      && trimmed !== LEGACY_DEVICE_KEY
      && trimmed !== DIRECT_DEVICE_KEY
    ) {
      continue;
    }
    const id = normalizeDeviceKey(trimmed);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof item === 'object' && item
      ? String(item.name || '').slice(0, DEVICE_NAME_MAX)
      : '';
    out.push({ id, name });
  }
  return out;
}

/** 2.3.x ohne `devices` → ein virtueller Tunnel ohne device-Feld. */
export function remoteDevicesFromPresence(payload) {
  if (!payload?.online) return [];
  if (Array.isArray(payload.devices) && payload.devices.length) {
    const parsed = parseDeviceList(payload.devices);
    if (parsed.length) return parsed;
  }
  return [{ id: LEGACY_DEVICE_KEY, name: '' }];
}

export function deviceListOfSessions(sessions) {
  return (sessions || []).map((entry) => ({
    id: normalizeDeviceKey(entry.deviceKey),
    name: String(entry.deviceName || ''),
    transport: entry.transport || entry.info?.transport || 'relay',
  }));
}

export function aggregatePeerInfo(sessions) {
  if (!sessions?.length) return null;
  const primary = sessions[0].info;
  return {
    ...primary,
    devices: deviceListOfSessions(sessions),
  };
}

export class SessionTable {
  constructor() {
    this.sessions = new Map();
  }

  key(peerId, deviceKey) {
    return sessionKey(peerId, deviceKey);
  }

  get(peerId, deviceKey) {
    return this.sessions.get(this.key(peerId, deviceKey));
  }

  has(peerId, deviceKey) {
    return this.sessions.has(this.key(peerId, deviceKey));
  }

  hasAny(peerId) {
    return this.forPeer(peerId).length > 0;
  }

  set(entry) {
    const peerId = entry.peerId || entry.info?.id;
    const deviceKey = normalizeDeviceKey(entry.deviceKey);
    this.sessions.set(this.key(peerId, deviceKey), {
      ...entry,
      peerId,
      deviceKey,
    });
  }

  delete(peerId, deviceKey) {
    return this.sessions.delete(this.key(peerId, deviceKey));
  }

  clear() {
    this.sessions.clear();
  }

  get size() {
    return this.sessions.size;
  }

  values() {
    return [...this.sessions.values()];
  }

  forPeer(peerId) {
    return this.values().filter((entry) => entry.peerId === peerId);
  }

  peerIds() {
    return [...new Set(this.values().map((entry) => entry.peerId))];
  }

  peerInfos() {
    const ids = this.peerIds();
    return ids.map((id) => aggregatePeerInfo(this.forPeer(id))).filter(Boolean);
  }

  devices(peerId) {
    return deviceListOfSessions(this.forPeer(peerId));
  }
}
