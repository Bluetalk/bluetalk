import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIRECT_DEVICE_KEY,
  LEGACY_DEVICE_KEY,
  SessionTable,
  aggregatePeerInfo,
  isValidDeviceId,
  newDeviceId,
  normalizeDeviceKey,
  openerToken,
  parseDeviceList,
  remoteDevicesFromPresence,
  sessionKey,
  shouldOpenTunnel,
  webDeviceName,
} from '../src/bridge/webBridge/sessionMap.js';
import { authHost, parseRelayUrl } from '../src/bridge/webBridge/relayClient.js';
import { httpBaseFromRelayUrl, relayUrlFromLocation } from '../src/renderer/cloudAccount/api.js';

test('normalizeDeviceKey: fehlendes Gerät ist legacy, gültige IDs bleiben', () => {
  assert.equal(normalizeDeviceKey(''), LEGACY_DEVICE_KEY);
  assert.equal(normalizeDeviceKey(null), LEGACY_DEVICE_KEY);
  assert.equal(normalizeDeviceKey('legacy'), LEGACY_DEVICE_KEY);
  assert.equal(normalizeDeviceKey('direct'), DIRECT_DEVICE_KEY);
  assert.equal(normalizeDeviceKey('abcdef12'), 'abcdef12');
  assert.equal(normalizeDeviceKey('no spaces allowed!!'), LEGACY_DEVICE_KEY);
  assert.equal(isValidDeviceId('a'.repeat(32)), true);
  assert.equal(isValidDeviceId('legacy'), false);
});

test('newDeviceId ist 16 Byte hex und vom Server akzeptiert', () => {
  const id = newDeviceId();
  assert.equal(id.length, 32);
  assert.equal(isValidDeviceId(id), true);
});

test('Öffner-Regel: kleineres peerId/deviceId öffnet, Self nie', () => {
  const a = 'bt2_aaa';
  const b = 'bt2_bbb';
  const da = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const db = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(openerToken(a, da), `${a}/${da}`);
  assert.equal(shouldOpenTunnel(a, da, b, db), true);
  assert.equal(shouldOpenTunnel(b, db, a, da), false);
  assert.equal(shouldOpenTunnel(a, da, a, db), false);
  assert.equal(shouldOpenTunnel('', da, b, db), false);
});

test('Öffner-Regel mit 2.3.x (legacy) bleibt eindeutig', () => {
  const us = 'bt2_zzz';
  const them = 'bt2_aaa';
  const ourDevice = 'cccccccccccccccccccccccccccccccc';
  assert.equal(shouldOpenTunnel(us, ourDevice, them, LEGACY_DEVICE_KEY), false);
  assert.equal(shouldOpenTunnel(them, LEGACY_DEVICE_KEY, us, ourDevice), true);
  assert.ok(openerToken(them, LEGACY_DEVICE_KEY) < openerToken(us, ourDevice));
});

test('presence ohne devices → ein Legacy-Tunnel; mit devices → genau diese', () => {
  assert.deepEqual(remoteDevicesFromPresence({ online: false }), []);
  assert.deepEqual(remoteDevicesFromPresence({ online: true }), [
    { id: LEGACY_DEVICE_KEY, name: '' },
  ]);
  assert.deepEqual(remoteDevicesFromPresence({ online: true, devices: [] }), [
    { id: LEGACY_DEVICE_KEY, name: '' },
  ]);
  const devices = remoteDevicesFromPresence({
    online: true,
    devices: [
      { id: 'dev11111', name: 'Windows' },
      { id: 'dev11111', name: 'dup' },
      { id: 'dev22222', name: 'BlueTalk Web · Chrome' },
    ],
  });
  assert.deepEqual(devices, [
    { id: 'dev11111', name: 'Windows' },
    { id: 'dev22222', name: 'BlueTalk Web · Chrome' },
  ]);
  assert.deepEqual(parseDeviceList(['dev11111', { id: 'bad id', name: 'x' }]), [
    { id: 'dev11111', name: '' },
  ]);
});

test('Sitzungs-Map: connected beim ersten, disconnected beim letzten Gerät', () => {
  const table = new SessionTable();
  const peerId = 'bt2_peer';
  table.set({
    peerId,
    deviceKey: 'devAAAAA',
    deviceName: 'Windows',
    transport: 'relay',
    info: { id: peerId, name: 'Ada', transport: 'relay' },
    peer: { sendPayload: async () => true },
  });
  assert.equal(table.hasAny(peerId), true);
  assert.equal(table.has(peerId, 'devAAAAA'), true);
  assert.equal(table.has(peerId, 'devBBBBB'), false);
  let infos = table.peerInfos();
  assert.equal(infos.length, 1);
  assert.deepEqual(infos[0].devices, [
    { id: 'devAAAAA', name: 'Windows', transport: 'relay' },
  ]);

  table.set({
    peerId,
    deviceKey: 'devBBBBB',
    deviceName: 'BlueTalk Web · Chrome',
    info: { id: peerId, name: 'Ada', transport: 'relay' },
    peer: { sendPayload: async () => true },
  });
  assert.equal(table.forPeer(peerId).length, 2);
  assert.equal(table.peerInfos().length, 1);
  assert.equal(table.devices(peerId).length, 2);

  table.delete(peerId, 'devAAAAA');
  assert.equal(table.hasAny(peerId), true);
  table.delete(peerId, 'devBBBBB');
  assert.equal(table.hasAny(peerId), false);
  assert.deepEqual(table.peerInfos(), []);
});

test('sessionKey trennt Peer und Gerät; aggregatePeerInfo hängt devices an', () => {
  const key = sessionKey('bt2_x', 'devCCCCC');
  assert.ok(key.startsWith('bt2_x'));
  assert.ok(key.includes('devCCCCC'));
  assert.notEqual(sessionKey('bt2_x', 'devCCCCC'), sessionKey('bt2_x', 'devDDDDD'));
  const aggregated = aggregatePeerInfo([
    {
      deviceKey: 'devCCCCC',
      deviceName: 'Phone',
      info: { id: 'bt2_x', name: 'Bo', transport: 'relay' },
    },
  ]);
  assert.equal(aggregated.id, 'bt2_x');
  assert.equal(aggregated.devices[0].id, 'devCCCCC');
  assert.equal(aggregatePeerInfo([]), null);
});

test('peer.send Fan-out: true wenn mindestens eine Sitzung klappt', async () => {
  const table = new SessionTable();
  table.set({
    peerId: 'bt2_p',
    deviceKey: 'dev11111',
    info: { id: 'bt2_p' },
    peer: { sendPayload: async () => { throw new Error('fail'); } },
  });
  table.set({
    peerId: 'bt2_p',
    deviceKey: 'dev22222',
    info: { id: 'bt2_p' },
    peer: { sendPayload: async () => true },
  });
  const results = await Promise.all(table.forPeer('bt2_p').map(async (entry) => {
    try {
      return Boolean(await entry.peer.sendPayload({}));
    } catch {
      return false;
    }
  }));
  assert.equal(results.some(Boolean), true);
  assert.equal(results.filter(Boolean).length, 1);
});

test('Web-Relay folgt der Herkunft; ws:// nur Loopback; Auth-Host inkl. Port', () => {
  assert.equal(
    relayUrlFromLocation({ protocol: 'https:', host: 'bt.example.com', hostname: 'bt.example.com' }),
    'wss://bt.example.com/v1/ws',
  );
  assert.equal(
    relayUrlFromLocation({ protocol: 'http:', host: '127.0.0.1:18080', hostname: '127.0.0.1' }),
    'ws://127.0.0.1:18080/v1/ws',
  );
  assert.equal(
    relayUrlFromLocation({ protocol: 'http:', host: 'localhost:18080', hostname: 'localhost' }),
    'ws://localhost:18080/v1/ws',
  );
  assert.equal(
    relayUrlFromLocation({ protocol: 'http:', host: 'relay.example.com', hostname: 'relay.example.com' }),
    'wss://relay.example.com/v1/ws',
  );
  assert.equal(relayUrlFromLocation({ protocol: 'file:' }), 'wss://bt.henny.dev/v1/ws');

  const local = parseRelayUrl('ws://127.0.0.1:18080/v1/ws');
  assert.equal(authHost(local), '127.0.0.1:18080');
  assert.equal(httpBaseFromRelayUrl(local.toString()), 'http://127.0.0.1:18080');
  assert.equal(httpBaseFromRelayUrl('wss://bt.henny.dev/v1/ws'), 'https://bt.henny.dev');
  assert.throws(() => parseRelayUrl('ws://example.com/v1/ws'));
  parseRelayUrl('wss://bt.henny.dev/v1/ws');
  parseRelayUrl('ws://localhost:18080/v1/ws');
});

test('webDeviceName erkennt Browser aus dem UA', () => {
  assert.equal(
    webDeviceName('Mozilla/5.0 Edg/120.0 Chrome/120.0 Safari/537.36'),
    'BlueTalk Web · Edge',
  );
  assert.equal(
    webDeviceName('Mozilla/5.0 Chrome/120.0 Safari/537.36'),
    'BlueTalk Web · Chrome',
  );
  assert.equal(
    webDeviceName('Mozilla/5.0 Firefox/121.0'),
    'BlueTalk Web · Firefox',
  );
  assert.equal(
    webDeviceName('Mozilla/5.0 Version/17.0 Safari/605.1.15'),
    'BlueTalk Web · Safari',
  );
  assert.equal(webDeviceName(''), 'BlueTalk Web · Browser');
});
