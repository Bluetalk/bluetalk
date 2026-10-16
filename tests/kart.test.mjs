/**
 * BlueKart: Streckengeometrie, Fahrphysik/Bot-KI und Host-Engine (ohne UI/3D).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACKS, buildTrackData, analyzeTrack } from '../src/renderer/kart/tracks.js';
import { createKartState, stepKart } from '../src/renderer/kart/physics.js';
import { botInput, createBotBrain } from '../src/renderer/kart/ai.js';
import { createHost, sanitizeSettings } from '../assets/bundled-plugins/kart/engine.js';
import { KART_TRACK_IDS } from '../assets/bundled-plugins/kart/tracks.js';

test('mindestens fünf Strecken, Plugin-Liste passt zu den Streckendaten', () => {
  assert.ok(TRACKS.length >= 5);
  assert.deepEqual([...KART_TRACK_IDS].sort(), TRACKS.map((t) => t.id).sort());
});

test('Strecken sind fahrbar: ausreichend weite Kurven, keine Überschneidungen', () => {
  for (const def of TRACKS) {
    const a = analyzeTrack(buildTrackData(def));
    assert.ok(a.minRadius >= 22, `${def.id}: Kurvenradius ${a.minRadius.toFixed(1)} m zu eng`);
    assert.ok(a.minGap >= def.width + def.shoulder * 2 + 8, `${def.id}: Streckenteile zu nah (${a.minGap.toFixed(1)} m)`);
  }
});

test('Bots fahren auf jeder Strecke drei Runden ohne hängen zu bleiben', () => {
  for (const def of TRACKS) {
    const track = buildTrackData(def);
    const kart = createKartState(track, 0);
    const brain = createBotBrain(2);
    const grip = track.theme.grip || 1;
    for (let n = 0; n < 60 * 60 * 5 && kart.lap <= 3; n += 1) {
      const input = botInput(kart, brain, track, 1 / 60, { gripMul: grip });
      stepKart(kart, input, 1 / 60, track, { gripMul: grip });
    }
    assert.ok(kart.lap > 3, `${def.id}: nur Runde ${kart.lap} erreicht`);
  }
});

test('Host-Engine: Lobby, Rennstart, Fahrdaten, Zielwertung', async () => {
  const deps = {
    api: { storage: { set() {} }, peers: () => [], chat: { send: async () => {} } },
    sendWire() {},
    broadcastWire() {},
    isContactBlocked: () => false,
  };
  const host = createHost({ bots: 1, laps: 1, lobbyAccess: 'public' }, () => {}, () => {}, { id: 'A', name: 'Host' }, deps);
  host.bootstrapHost();
  host.onWire('B', { wire: 'join', gameId: host.gameId, name: 'Gast' });
  assert.equal(host.publicState().players.length, 3); // Host, Gast, 1 Bot

  assert.ok(host.startRace());
  const { raceId } = host.publicState();
  host.applyAction('A', { type: 'car', raceId, c: { x: 1, z: 1, a: 0, v: 5, p: 2 }, h: [], bots: [] });
  assert.ok(host.carsSnapshot().cars.A);

  host.applyAction('A', { type: 'finish', timeMs: 70_000 }); // vor dem Start ignoriert
  assert.equal(host.publicState().results.length, 0);
  host.destroy();
});

test('Einstellungen werden begrenzt', () => {
  const s = sanitizeSettings({ laps: 99, bots: 50, trackId: 'gibt-es-nicht' });
  assert.equal(s.laps, 5);
  assert.equal(s.bots, 7);
  assert.equal(s.trackId, KART_TRACK_IDS[0]);
});
