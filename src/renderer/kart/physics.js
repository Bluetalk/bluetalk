/**
 * BlueKart — Arcade-Fahrphysik.
 *
 * Koordinaten: x/z-Ebene, y ist oben. Fahrtrichtung eines Karts mit Winkel ψ
 * ist f = (sin ψ, cos ψ); „rechts“ ist r = (−cos ψ, sin ψ). Ein größerer
 * Winkel dreht also nach links, positives Lenken (rechts) verkleinert ψ.
 *
 * Das Fahrverhalten basiert auf einer Geschwindigkeit entlang der Fahrtrichtung
 * plus einer seitlichen Rutschkomponente, die je nach Haftung abklingt. Driften
 * senkt die Haftung und lädt Mini-Turbos auf.
 */

export const KART = {
  maxSpeed: 56,
  accel: 40,
  brake: 75,
  reverseMax: 14,
  coastDrag: 0.2,
  offroadMax: 22,
  offroadDrag: 1.6,
  baseTurn: 2.35,
  radius: 1.6,
  gripNormal: 12,
  gripDrift: 2.6,
  boostMul: 1.36,
  boostAccel: 70,
  driftMinSpeed: 20,
  driftLevels: [0.9, 1.8, 3.0],
  driftBoost: [0.55, 1.0, 1.5],
  spinDuration: 1.25,
  invulnDuration: 1.4,
};

export function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Neues Kart auf einem Startplatz (Index in der Aufstellung). */
export function createKartState(track, slot) {
  const g = track.gridSlot(slot);
  return {
    x: g.x,
    z: g.z,
    heading: g.heading,
    vx: 0,
    vz: 0,
    speed: 0, // vorzeichenbehaftet entlang der Fahrtrichtung
    steer: 0, // geglätteter Lenkeinschlag (−1..1, rechts positiv)
    yaw: 0,
    // Streckenfortschritt
    idx: g.index,
    lastIdx: g.index,
    lap: 0,
    lat: 0,
    // Zustände
    offroad: false,
    drift: { active: false, dir: 0, time: 0, level: 0 },
    boostT: 0,
    boostPower: 1,
    spinT: 0,
    spinAngle: 0,
    invulnT: 0,
    shieldT: 0,
    hopT: 0,
    slipT: 0,
    scrape: 0,
    wrongWayT: 0,
    // Rennen
    finished: false,
    finishTime: 0,
    item: null,
    itemRoll: 0,
    itemCooldown: 0,
  };
}

/** Gesamtfortschritt in Abtastpunkten (monoton im Rennen). */
export function progressOf(state, track) {
  return state.lap * track.N + state.idx;
}

function startBoost(state, seconds, power = 1) {
  if (seconds > state.boostT) state.boostT = seconds;
  state.boostPower = Math.max(power, state.boostPower);
}

export function applyBoost(state, seconds, power = 1) {
  startBoost(state, seconds, power);
}

export function applySpin(state, hazardKind = 'banana') {
  if (state.invulnT > 0 || state.shieldT > 0 || state.finished) return false;
  state.spinT = hazardKind === 'rocket' ? KART.spinDuration * 1.35 : KART.spinDuration;
  state.invulnT = state.spinT + KART.invulnDuration;
  state.drift.active = false;
  state.drift.time = 0;
  state.drift.level = 0;
  state.boostT = 0;
  return true;
}

/**
 * Ein Physikschritt. `input`: { throttle 0..1, brake 0..1, steer −1..1, drift }.
 * `env`: { gripMul, frozen }.
 * Gibt Ereignisse zurück ({ lapCrossed: ±1, driftBoost: level }).
 */
export function stepKart(k, input, dt, track, env = {}) {
  const events = { lapCrossed: 0, driftBoost: 0, scraped: false };
  const gripMul = env.gripMul || 1;
  const frozen = Boolean(env.frozen);

  const throttle = frozen ? 0 : clamp(input.throttle || 0, 0, 1);
  const brake = frozen ? 0 : clamp(input.brake || 0, 0, 1);
  const steerIn = frozen ? 0 : clamp(input.steer || 0, -1, 1);
  const wantDrift = frozen ? false : Boolean(input.drift);

  // Zustands-Timer
  if (k.boostT > 0) {
    k.boostT -= dt;
    if (k.boostT <= 0) { k.boostT = 0; k.boostPower = 1; }
  }
  if (k.invulnT > 0) k.invulnT = Math.max(0, k.invulnT - dt);
  if (k.hopT > 0) k.hopT = Math.max(0, k.hopT - dt);
  if (k.shieldT > 0) k.shieldT = Math.max(0, k.shieldT - dt);
  const spinning = k.spinT > 0;
  if (spinning) {
    k.spinT = Math.max(0, k.spinT - dt);
    k.spinAngle += dt * 13;
  } else {
    k.spinAngle = 0;
  }

  // Untergrund
  const here = track.nearest(k.x, k.z, k.lastIdx);
  k.offroad = Math.abs(here.d) > track.halfWidth + 0.4;

  const fx = Math.sin(k.heading);
  const fz = Math.cos(k.heading);
  let along = k.vx * fx + k.vz * fz;
  let latX = k.vx - fx * along;
  let latZ = k.vz - fz * along;

  let maxSpeed = KART.maxSpeed;
  if (k.boostT > 0) maxSpeed *= KART.boostMul * (k.boostPower > 1 ? 1.08 : 1);
  if (k.offroad && k.boostT <= 0) maxSpeed = Math.min(maxSpeed, KART.offroadMax);

  if (!spinning) {
    if (throttle > 0) {
      const ratio = clamp(along / maxSpeed, 0, 1.2);
      const a = (k.boostT > 0 ? KART.boostAccel : KART.accel) * throttle * (1 - Math.pow(Math.min(ratio, 1), 1.6));
      along += a * dt;
    }
    if (brake > 0) {
      if (along > 0.6) along -= KART.brake * brake * dt;
      else along = Math.max(-KART.reverseMax, along - 24 * brake * dt);
    }
    if (k.boostT > 0 && throttle === 0 && !frozen) {
      along += KART.boostAccel * 0.6 * dt; // Boost schiebt auch ohne Gas
    }
  }
  // Hangabtrieb: bergauf bremst, bergab schiebt
  if (track.slope) {
    const slopeAlong = track.slope[here.i] * Math.cos(k.heading - track.heading[here.i]);
    along -= 9.81 * 0.85 * slopeAlong * dt;
  }

  // Rollwiderstand / Übergeschwindigkeit
  along -= along * (KART.coastDrag + (k.offroad ? KART.offroadDrag : 0)) * dt;
  if (along > maxSpeed) along -= (along - maxSpeed) * Math.min(1, 3.2 * dt);
  if (spinning) along *= Math.max(0, 1 - 2.2 * dt);

  // Driften
  const d = k.drift;
  if (!spinning && wantDrift && !d.active && Math.abs(steerIn) > 0.3 && along > KART.driftMinSpeed && !k.offroad) {
    d.active = true;
    k.hopT = 0.26;
    d.dir = steerIn > 0 ? 1 : -1;
    d.time = 0;
    d.level = 0;
  }
  if (d.active) {
    if (!wantDrift || along < KART.driftMinSpeed * 0.65 || spinning) {
      if (d.level > 0) {
        startBoost(k, KART.driftBoost[d.level - 1], 1);
        events.driftBoost = d.level;
      }
      d.active = false;
      d.time = 0;
      d.level = 0;
    } else {
      d.time += dt;
      let lvl = 0;
      for (let i = 0; i < KART.driftLevels.length; i += 1) if (d.time >= KART.driftLevels[i]) lvl = i + 1;
      d.level = lvl;
    }
  }

  // Lenken
  const speedAbs = Math.abs(along);
  const lowSpeed = clamp(speedAbs / 9, 0, 1);
  const highSpeed = 1 - 0.34 * clamp(speedAbs / KART.maxSpeed, 0, 1);
  let yawInput = steerIn;
  if (d.active) yawInput = clamp(d.dir * 0.95 + steerIn * 0.7, -1.5, 1.5);
  const reverse = along < -0.5 ? -1 : 1;
  const targetYaw = spinning ? 0 : yawInput * KART.baseTurn * lowSpeed * highSpeed * reverse;
  k.yaw += (targetYaw - k.yaw) * Math.min(1, 14 * dt);
  k.heading -= k.yaw * dt;
  k.steer += (steerIn - k.steer) * Math.min(1, 10 * dt);

  // Haftung / Rutschen
  let grip = d.active ? KART.gripDrift : KART.gripNormal * gripMul;
  if (spinning) grip = 3;
  const damp = Math.exp(-grip * dt);
  latX *= damp;
  latZ *= damp;
  // Beim Driften schiebt das Heck: etwas Querimpuls in Gegenrichtung
  if (d.active) {
    const rx = -Math.cos(k.heading);
    const rz = Math.sin(k.heading);
    latX += -rx * d.dir * 0.9 * dt * speedAbs * 0.5;
    latZ += -rz * d.dir * 0.9 * dt * speedAbs * 0.5;
  }

  const nfx = Math.sin(k.heading);
  const nfz = Math.cos(k.heading);
  k.vx = nfx * along + latX;
  k.vz = nfz * along + latZ;
  k.speed = along;

  k.x += k.vx * dt;
  k.z += k.vz * dt;

  // Bande
  const after = track.nearest(k.x, k.z, here.i);
  const limit = track.wallOffset;
  k.scrape = Math.max(0, k.scrape - dt);
  if (Math.abs(after.d) > limit) {
    const side = after.d > 0 ? 1 : -1;
    const over = Math.abs(after.d) - limit;
    k.x -= track.nx[after.i] * side * over;
    k.z -= track.nz[after.i] * side * over;
    const vn = k.vx * track.nx[after.i] + k.vz * track.nz[after.i];
    if (vn * side > 0) {
      k.vx -= track.nx[after.i] * vn * 1.35;
      k.vz -= track.nz[after.i] * vn * 1.35;
    }
    const slow = 1 - Math.min(0.35, 0.12 + Math.abs(vn) * 0.01);
    k.vx *= slow;
    k.vz *= slow;
    k.speed *= slow;
    // Fahrzeug an die Strecke ausrichten, damit es nicht an der Bande klebt
    const diff = wrapAngle(track.heading[after.i] - k.heading);
    k.heading += diff * Math.min(1, 3.2 * dt);
    k.scrape = 0.25;
    events.scraped = true;
  }

  // Streckenfortschritt (Runden über die Ziellinie)
  const now = track.nearest(k.x, k.z, k.lastIdx);
  const delta = now.i - k.lastIdx;
  if (delta < -track.N / 2) { k.lap += 1; events.lapCrossed = 1; }
  else if (delta > track.N / 2) { k.lap -= 1; events.lapCrossed = -1; }
  k.lastIdx = now.i;
  k.idx = now.i;
  k.lat = now.d;

  // Falsche Richtung
  const align = Math.sin(k.heading) * track.tx[now.i] + Math.cos(k.heading) * track.tz[now.i];
  if (align < -0.25 && Math.abs(k.speed) > 4) k.wrongWayT += dt; else k.wrongWayT = Math.max(0, k.wrongWayT - dt * 2);

  return events;
}

/** Weicher Kart-Kart-Kontakt: verschiebt nur `k`, der andere macht dasselbe bei sich. */
export function collideKarts(k, others) {
  let bumped = false;
  const minDist = KART.radius * 2;
  for (const o of others) {
    const dx = k.x - o.x;
    const dz = k.z - o.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= minDist * minDist || d2 < 1e-6) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const nz = dz / d;
    const overlap = minDist - d;
    k.x += nx * overlap * 0.55;
    k.z += nz * overlap * 0.55;
    const rel = (k.vx - (o.vx || 0)) * nx + (k.vz - (o.vz || 0)) * nz;
    if (rel < 0) {
      k.vx -= nx * rel * 1.1;
      k.vz -= nz * rel * 1.1;
      k.speed *= 0.985;
    }
    bumped = true;
  }
  return bumped;
}

/** Rang-Hilfen ------------------------------------------------------------- */

export function rankKarts(entries) {
  // entries: [{ id, progress, finished, finishTime }]
  return [...entries].sort((a, b) => {
    if (a.finished && b.finished) return a.finishTime - b.finishTime;
    if (a.finished) return -1;
    if (b.finished) return 1;
    return b.progress - a.progress;
  });
}
