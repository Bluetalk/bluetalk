/**
 * BlueKart — 3D-Modelle aus Primitiven (Karts, Item-Boxen, Items, Partikel).
 * Alles prozedural: keine externen Dateien, passt zur strikten CSP.
 */

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { colorOf } from './colors.js';

const matCache = new Map();
function standard(color, extra = {}) {
  const key = `${color}|${JSON.stringify(extra)}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, ...extra });
    matCache.set(key, m);
  }
  return m;
}

const paintCache = new Map();
/** Autolack mit Klarlackschicht — glänzt mit der Umgebungsspiegelung. */
function paint(color) {
  let m = paintCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.32, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1,
    });
    paintCache.set(color, m);
  }
  return m;
}

function numberTexture(num, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(64, 64, 60, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = fg;
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.font = '900 70px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(num), 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Additive Flamme mit HDR-Farbe (glüht durch Bloom). */
function hotMaterial(color) {
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
  m.color.multiplyScalar(3.2);
  return m;
}

function shadowed(mesh) {
  mesh.castShadow = true;
  return mesh;
}

/** Kart mit Fahrer. Vorwärts = +z. */
export function makeKartMesh(colorIndex) {
  const palette = colorOf(colorIndex);
  const body = new THREE.Color(palette.hex);
  const accent = new THREE.Color(palette.accent);
  const root = new THREE.Group();

  const bodyMat = paint(body.getHex());
  const accentMat = standard(accent.getHex(), { roughness: 0.5 });
  const darkMat = standard(0x20232b, { roughness: 0.8, metalness: 0.1 });
  const metalMat = standard(0xb8bec9, { roughness: 0.25, metalness: 0.85 });

  const chassis = shadowed(new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.46, 2.7, 3, 0.18), bodyMat));
  chassis.position.set(0, 0.56, 0);
  root.add(chassis);

  const nose = shadowed(new THREE.Mesh(new RoundedBoxGeometry(1.15, 0.36, 1.1, 3, 0.15), bodyMat));
  nose.position.set(0, 0.5, 1.55);
  root.add(nose);

  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.02, 2.5), accentMat);
  stripe.position.set(0, 0.8, 0.05);
  root.add(stripe);

  for (const side of [-1, 1]) {
    const pod = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.36, 0.34, 1.5, 2, 0.1), darkMat));
    pod.position.set(side * 1.0, 0.5, 0.15);
    root.add(pod);
  }

  const seat = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.7, 0.26, 2, 0.08), darkMat));
  seat.position.set(0, 1.0, -0.62);
  root.add(seat);

  // Fahrer
  const torso = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.55, 0.42, 3, 0.12), accentMat));
  torso.position.set(0, 1.02, -0.3);
  root.add(torso);
  const head = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.3, 18, 14), standard(0xffd2a8, { roughness: 0.7 })));
  head.position.set(0, 1.5, -0.25);
  root.add(head);
  const helmet = shadowed(new THREE.Mesh(
    new THREE.SphereGeometry(0.37, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62),
    paint(body.getHex()),
  ));
  helmet.position.set(0, 1.52, -0.25);
  helmet.rotation.x = -0.18;
  root.add(helmet);
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.31, 14, 10, -0.9, 1.8, 0.95, 0.55),
    standard(0x111827, { roughness: 0.1, metalness: 0.6 }),
  );
  visor.position.set(0, 1.5, -0.25);
  visor.rotation.x = -0.1;
  root.add(visor);
  for (const side of [-1, 1]) {
    const arm = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.45, 4, 8), accentMat));
    arm.position.set(side * 0.38, 1.0, 0.0);
    arm.rotation.x = Math.PI / 2.6;
    arm.rotation.z = side * 0.25;
    root.add(arm);
  }
  const wheelRing = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.04, 8, 18), darkMat);
  wheelRing.position.set(0, 1.0, 0.38);
  wheelRing.rotation.x = Math.PI / 2.8;
  root.add(wheelRing);

  // Räder
  const wheels = [];
  const frontPivots = [];
  const makeWheel = (radius, width) => {
    const g = new THREE.Group();
    const tire = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20), darkMat));
    tire.rotation.z = Math.PI / 2;
    g.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.52, radius * 0.52, width + 0.03, 12), metalMat);
    hub.rotation.z = Math.PI / 2;
    g.add(hub);
    const bolt = new THREE.Mesh(new THREE.BoxGeometry(width + 0.05, radius * 0.5, radius * 0.12), darkMat);
    g.add(bolt);
    return g;
  };
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 1.02, 0.4, 1.05);
    const w = makeWheel(0.4, 0.36);
    pivot.add(w);
    root.add(pivot);
    frontPivots.push(pivot);
    wheels.push(w);
    const rear = makeWheel(0.5, 0.48);
    rear.position.set(side * 1.05, 0.5, -1.0);
    root.add(rear);
    wheels.push(rear);
  }

  // Heckflügel + Auspuff
  const wing = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.07, 0.5), accentMat));
  wing.position.set(0, 1.42, -1.42);
  root.add(wing);
  for (const side of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.5, 0.12), darkMat);
    strut.position.set(side * 0.62, 1.15, -1.38);
    root.add(strut);
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.55), bodyMat);
    plate.position.set(side * 0.95, 1.4, -1.42);
    root.add(plate);
  }
  // Scheinwerfer, Rück-/Bremslichter (leuchten mit Bloom), Startnummer
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 1.6 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x7f1d1d, emissive: 0xff2a2a, emissiveIntensity: 0.9 });
  for (const side of [-1, 1]) {
    const head = new THREE.Mesh(new THREE.CircleGeometry(0.13, 14), headMat);
    head.position.set(side * 0.4, 0.55, 2.11);
    root.add(head);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.11, 0.04), tailMat);
    tail.position.set(side * 0.6, 0.66, -1.37);
    root.add(tail);
  }
  const numberPlate = new THREE.Mesh(
    new THREE.CircleGeometry(0.34, 24),
    new THREE.MeshStandardMaterial({ map: numberTexture((Number(colorIndex) || 0) + 1, palette.accent, palette.hex), roughness: 0.5 }),
  );
  numberPlate.rotation.x = -Math.PI / 2;
  numberPlate.position.set(0, 0.69, 1.55);
  root.add(numberPlate);

  const flames = [];
  for (const side of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.4, 10), metalMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(side * 0.42, 0.62, -1.45);
    root.add(pipe);
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.2, 1.1, 10),
      hotMaterial(0xffa726),
    );
    flame.rotation.x = -Math.PI / 2;
    flame.position.set(side * 0.42, 0.62, -2.05);
    flame.visible = false;
    root.add(flame);
    flames.push(flame);
  }

  // Schild
  const shield = new THREE.Mesh(
    new THREE.SphereGeometry(2.3, 22, 16),
    new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  shield.position.y = 0.9;
  shield.visible = false;

  // Schattenfleck (stabil, unabhängig von der Shadow-Map)
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(1, 20),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.scale.set(1.35, 2.1, 1);
  blob.position.y = 0.05;

  // `root` ist das Modell (dreht sich beim Spin-Out); Schild und Schattenfleck
  // hängen am äußeren Knoten und drehen nicht mit.
  const outer = new THREE.Group();
  outer.add(root);
  outer.add(shield);
  outer.add(blob);
  outer.userData = { model: root, wheels, frontPivots, flames, shield, blob, tailMat };
  return outer;
}

/** Macht ein Kart zum durchscheinenden Geisterauto (eigene Materialkopien). */
export function ghostify(group, opacity = 0.4, tint = null) {
  group.traverse((obj) => {
    if (!obj.isMesh) return;
    const apply = (m) => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = Math.min(c.opacity ?? 1, opacity);
      c.depthWrite = false;
      if (tint != null && c.color) c.color.lerp(new THREE.Color(tint), 0.35);
      return c;
    };
    obj.material = Array.isArray(obj.material) ? obj.material.map(apply) : apply(obj.material);
    obj.castShadow = false;
  });
  if (group.userData.blob) group.userData.blob.visible = false;
  return group;
}

/** Namensschild über dem Kart. */
export function makeNameSprite(name, hex) {
  const canvas = document.createElement('canvas');
  canvas.width = 384;
  canvas.height = 80;
  const ctx = canvas.getContext('2d');
  ctx.font = '700 38px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = String(name || '').slice(0, 16);
  const w = Math.min(360, ctx.measureText(text).width + 40);
  ctx.fillStyle = 'rgba(8,12,24,0.72)';
  const x = (canvas.width - w) / 2;
  const r = 24;
  ctx.beginPath();
  ctx.moveTo(x + r, 8);
  ctx.arcTo(x + w, 8, x + w, 72, r);
  ctx.arcTo(x + w, 72, x, 72, r);
  ctx.arcTo(x, 72, x, 8, r);
  ctx.arcTo(x, 8, x + w, 8, r);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = hex;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, 42);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(4.4, 0.92, 1);
  sprite.position.set(0, 3.1, 0);
  sprite.renderOrder = 10;
  return sprite;
}

export function makeItemBoxMesh() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createLinearGradient(0, 0, 128, 128);
  grd.addColorStop(0, '#29b6f6');
  grd.addColorStop(0.5, '#7e57c2');
  grd.addColorStop(1, '#ec407a');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 8;
  ctx.strokeRect(6, 6, 116, 116);
  ctx.fillStyle = '#ffffff';
  ctx.font = '900 84px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', 64, 70);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(1.7, 1.7, 1.7, 3, 0.25),
    new THREE.MeshStandardMaterial({ map: texture, emissive: 0x5c6bc0, emissiveIntensity: 0.55, transparent: true, opacity: 0.92, roughness: 0.3 }),
  );
  const group = new THREE.Group();
  group.add(mesh);
  group.userData.cube = mesh;
  return group;
}

export function makeBananaMesh() {
  const g = new THREE.Group();
  const mat = standard(0xffe135, { roughness: 0.4 });
  const arc = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.2, 10, 18, Math.PI * 1.05), mat));
  arc.position.set(0, 0.62, 0);
  arc.rotation.z = -Math.PI * 0.025;
  g.add(arc);
  for (const sx of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 0.18, 8), standard(0x5d4037));
    tip.position.set(sx * 0.55, 0.62, 0);
    g.add(tip);
  }
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.8, 14), new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.3, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.04;
  g.add(blob);
  return g;
}

export function makeRocketMesh() {
  const g = new THREE.Group();
  const body = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 1.5, 14), standard(0xf5f5f5, { metalness: 0.3 })));
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const nose = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.7, 14), standard(0xe53935)));
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 1.1;
  g.add(nose);
  for (let i = 0; i < 3; i += 1) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 0.5), standard(0xe53935));
    fin.position.z = -0.6;
    fin.rotation.z = (i * Math.PI * 2) / 3;
    fin.position.x = Math.sin(fin.rotation.z) * -0.0;
    g.add(fin);
  }
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.26, 1.4, 10),
    hotMaterial(0xff9800),
  );
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = -1.35;
  g.add(flame);
  g.userData.flame = flame;
  g.position.y = 0.9;
  const holder = new THREE.Group();
  holder.add(g);
  return holder;
}

/** Partikelpool (Funken, Rauch, Flammen, Konfetti) als einzelnes Points-Objekt. */
export function createParticles(scene, max = 700) {
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  const velocities = new Float32Array(max * 3);
  const life = new Float32Array(max);
  const maxLife = new Float32Array(max);
  const base = new Float32Array(max * 3);
  const gravity = new Float32Array(max);

  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grd = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 64, 64);
  const map = new THREE.CanvasTexture(canvas);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.9,
    map,
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  let cursor = 0;
  const tmp = new THREE.Color();
  for (let i = 0; i < max; i += 1) positions[i * 3 + 1] = -999;

  return {
    emit(x, y, z, vx, vy, vz, lifeSec, hex, g = 0) {
      const i = cursor;
      cursor = (cursor + 1) % max;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      velocities[i * 3] = vx;
      velocities[i * 3 + 1] = vy;
      velocities[i * 3 + 2] = vz;
      life[i] = lifeSec;
      maxLife[i] = lifeSec;
      gravity[i] = g;
      tmp.setHex(hex);
      base[i * 3] = tmp.r;
      base[i * 3 + 1] = tmp.g;
      base[i * 3 + 2] = tmp.b;
    },
    update(dt) {
      for (let i = 0; i < max; i += 1) {
        if (life[i] <= 0) {
          if (positions[i * 3 + 1] > -900) positions[i * 3 + 1] = -999;
          continue;
        }
        life[i] -= dt;
        const f = Math.max(0, life[i] / maxLife[i]);
        velocities[i * 3 + 1] -= gravity[i] * dt;
        positions[i * 3] += velocities[i * 3] * dt;
        positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
        positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
        colors[i * 3] = base[i * 3] * f;
        colors[i * 3 + 1] = base[i * 3 + 1] * f;
        colors[i * 3 + 2] = base[i * 3 + 2] * f;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.color.needsUpdate = true;
    },
    dispose() {
      scene.remove(points);
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}
