/**
 * BlueKart — Bot-Fahrer.
 *
 * Folgt der Mittellinie mit einem leicht versetzten Fahrstreifen, bremst vor
 * Kurven und driftet in engen Bögen. Gummiband-Effekt: Bots weit hinter dem
 * Führenden fahren minimal schneller, Bots weit vorn minimal langsamer.
 */

import { KART, clamp, wrapAngle } from './physics.js';

export function createBotBrain(index) {
  // Deterministische, aber unterschiedliche „Charaktere“.
  const seeds = [0.92, 0.97, 0.9, 1.0, 0.94, 0.88, 0.96];
  const lanes = [-0.38, 0.28, 0.0, -0.18, 0.4, -0.3, 0.12];
  return {
    skill: seeds[index % seeds.length],
    lane: lanes[index % lanes.length],
    itemDelay: 0,
    swerve: 0,
  };
}

export function botInput(bot, brain, track, dt, ctx = {}) {
  const speed = bot.speed;
  const lookSamples = clamp(Math.round((Math.max(speed, 8) * 0.55) / track.step) + 5, 7, 38);
  const targetIdx = (bot.idx + lookSamples) % track.N;
  // Ideallinie: vor Kurven auf die Innenseite ziehen (Normale zeigt nach rechts,
  // eine Linkskurve hat positive Krümmung → innen = negative Seite).
  let curveAhead = 0;
  for (let o = 6; o < lookSamples + 18; o += 3) curveAhead += track.curvature[(bot.idx + o) % track.N];
  curveAhead /= Math.max(1, Math.floor((lookSamples + 12) / 3));
  const inside = clamp(-curveAhead * 90, -0.62, 0.62);
  const laneFactor = clamp(brain.lane * 0.45 + inside, -0.7, 0.7);
  const lane = laneFactor * track.halfWidth;
  const tp = track.pointAt(targetIdx, lane);

  const dx = tp.x - bot.x;
  const dz = tp.z - bot.z;
  const desired = Math.atan2(dx, dz);
  const diff = wrapAngle(desired - bot.heading);
  const steer = clamp(-diff * 2.3, -1, 1);

  // Maximale Krümmung der nächsten Meter bestimmt die Wunschgeschwindigkeit
  let maxCurv = 0;
  const horizon = clamp(Math.round(speed * 0.9 / track.step) + 6, 10, 46);
  for (let o = 0; o < horizon; o += 2) {
    const c = Math.abs(track.curvature[(bot.idx + o) % track.N]);
    if (c > maxCurv) maxCurv = c;
  }
  const latAccel = 58 * (ctx.gripMul || 1);
  let target = maxCurv > 1e-5 ? Math.sqrt(latAccel / maxCurv) : KART.maxSpeed;
  target = clamp(target, 20, KART.maxSpeed * 1.02) * brain.skill;
  if (ctx.rubber) target *= ctx.rubber;
  if (bot.offroad) target = Math.min(target, KART.offroadMax);

  let throttle = 0;
  let brake = 0;
  if (speed < target) throttle = 1;
  else if (speed > target * 1.12) brake = clamp((speed - target) / 16, 0.2, 1);
  else throttle = 0.35;

  const drift = Math.abs(diff) > 0.2 && speed > 30 && maxCurv > 0.006;

  // Items
  let useItem = false;
  if (bot.item && bot.itemRoll <= 0) {
    brain.itemDelay -= dt;
    if (brain.itemDelay <= 0) {
      if (bot.item === 'turbo') useItem = Math.abs(diff) < 0.12 && maxCurv < 0.004;
      else if (bot.item === 'shield') useItem = Boolean(ctx.threat);
      else if (bot.item === 'rocket') useItem = Boolean(ctx.targetAhead);
      else if (bot.item === 'banana') useItem = Boolean(ctx.chaserBehind) || Math.random() < 0.002;
      if (!useItem) brain.itemDelay = 0.4;
    }
  } else {
    brain.itemDelay = 0.6 + Math.random() * 1.4;
  }

  return { throttle, brake, steer, drift, useItem };
}
