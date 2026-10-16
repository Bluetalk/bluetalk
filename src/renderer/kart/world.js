/**
 * BlueKart — 3D-Welt.
 *
 * Fahrbahn mit Höhenprofil und überhöhten Kurven, Gelände mit Hügeln rund um
 * die Strecke, Spiegelungs-Umgebung für Lack und Metall, Himmel mit Sonne,
 * Startampel, Boost-Felder, Item-Boxen und themenabhängige Szenerie.
 * Alles prozedural und instanziert; Detailgrad richtet sich nach der Qualität.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeItemBoxMesh } from './models.js';

export const QUALITY = {
  high: { shadows: 2048, props: 1, terrainSeg: 200, bloom: true, pixelRatio: 1.6 },
  medium: { shadows: 1024, props: 0.7, terrainSeg: 150, bloom: true, pixelRatio: 1.25 },
  low: { shadows: 0, props: 0.4, terrainSeg: 100, bloom: false, pixelRatio: 1 },
};

// Hügel-Charakter je Thema: Amplitude (m) und Grundhöhe
const HILLS = {
  forest: { amp: 34, base: 2, scale: 1 / 260 },
  palms: { amp: 22, base: 0, scale: 1 / 300 },
  rocks: { amp: 60, base: 6, scale: 1 / 200 },
  city: { amp: 0, base: 0, scale: 1 / 300 },
  pines: { amp: 80, base: 6, scale: 1 / 240 },
  canyon: { amp: 26, base: 0, scale: 1 / 220 },
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Wertrauschen 2D + fBm (deterministisch je Strecke). */
function makeNoise(seed) {
  const hash = (x, y) => {
    let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  const value = (x, y) => {
    const xi = Math.floor(x); const yi = Math.floor(y);
    const xf = x - xi; const yf = y - yi;
    const a = hash(xi, yi); const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1); const d = hash(xi + 1, yi + 1);
    const u = smooth(xf); const v = smooth(yf);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  return (x, y) => {
    let sum = 0; let amp = 0.5; let freq = 1; let norm = 0;
    for (let o = 0; o < 4; o += 1) {
      sum += value(x * freq, y * freq) * amp;
      norm += amp;
      amp *= 0.5;
      freq *= 2.03;
    }
    return sum / norm; // 0..1
  };
}

function canvasTexture(w, h, draw, { repeat = false, srgb = true } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  tex.anisotropy = 8;
  return tex;
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function speckle(ctx, w, h, count, alpha, light = 255) {
  for (let i = 0; i < count; i += 1) {
    const v = Math.floor(Math.random() * 60 + (light - 60));
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

/**
 * Band entlang der Strecke zwischen zwei seitlichen Versätzen, auf der
 * Fahrbahnoberfläche (Höhe + Querneigung) plus `lift`.
 */
function ribbonRange(track, i0, i1, offA, offB, lift, tileLen, uvAcross = true, yFn = null) {
  const count = i1 - i0 + 1;
  const pos = new Float32Array(count * 2 * 3);
  const uv = new Float32Array(count * 2 * 2);
  const idx = [];
  for (let k = 0; k < count; k += 1) {
    const i = track.wrap(i0 + k);
    const ax = track.px[i] + track.nx[i] * offA;
    const az = track.pz[i] + track.nz[i] * offA;
    const bx = track.px[i] + track.nx[i] * offB;
    const bz = track.pz[i] + track.nz[i] * offB;
    const ay = yFn ? yFn(i, offA, ax, az) : track.surfaceY(i, offA) + lift;
    const by = yFn ? yFn(i, offB, bx, bz) : track.surfaceY(i, offB) + lift;
    pos.set([ax, ay, az, bx, by, bz], k * 6);
    const v = (k * track.step) / tileLen;
    uv.set(uvAcross ? [0, v, 1, v] : [v, 0, v, 1], k * 4);
    if (k < count - 1) {
      const a0 = k * 2;
      const b0 = k * 2 + 1;
      const a1 = (k + 1) * 2;
      const b1 = (k + 1) * 2 + 1;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function buildWorld(scene, renderer, track, opts = {}) {
  const quality = QUALITY[opts.quality] || QUALITY.high;
  const theme = track.theme;
  const seed = hashString(track.id);
  const rand = mulberry32(seed);
  const noise = makeNoise(seed % 100000);
  const hills = HILLS[theme.props] || HILLS.forest;
  const disposables = [];
  const animated = { pads: null, sea: null };

  // Begrenzungsrahmen der Strecke
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < track.N; i += 1) {
    minX = Math.min(minX, track.px[i]); maxX = Math.max(maxX, track.px[i]);
    minZ = Math.min(minZ, track.pz[i]); maxZ = Math.max(maxZ, track.pz[i]);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;

  // Raster für Abstand/Höhe zur Strecke
  const cell = 40;
  const grid = new Map();
  for (let i = 0; i < track.N; i += 2) {
    const key = `${Math.floor(track.px[i] / cell)},${Math.floor(track.pz[i] / cell)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(i);
  }
  const reach = 150;
  /** Nächster Streckenpunkt + gewichteter Höhenmittelwert der Umgebung. */
  const probe = (x, z) => {
    let best = Infinity;
    let bestI = -1;
    let wSum = 0;
    let hSum = 0;
    if (x < minX - reach || x > maxX + reach || z < minZ - reach || z > maxZ + reach) {
      return { d: Infinity, i: -1, avg: 0 };
    }
    const gx = Math.floor(x / cell);
    const gz = Math.floor(z / cell);
    for (let dx = -4; dx <= 4; dx += 1) {
      for (let dz = -4; dz <= 4; dz += 1) {
        const list = grid.get(`${gx + dx},${gz + dz}`);
        if (!list) continue;
        for (const i of list) {
          const d = Math.hypot(x - track.px[i], z - track.pz[i]);
          if (d < best) { best = d; bestI = i; }
          if (d < reach) {
            const w = 1 / (d * d * d * d + 40);
            wSum += w;
            hSum += w * track.py[i];
          }
        }
      }
    }
    return { d: best, i: bestI, avg: wSum > 0 ? hSum / wSum : 0 };
  };

  /** Geländehöhe: an der Strecke knapp unter der Fahrbahn, nach außen Hügel. */
  const terrainHeight = (x, z) => {
    const p = probe(x, z);
    const hillRaw = hills.amp > 0 ? hills.base + noise(x * hills.scale, z * hills.scale) * hills.amp : 0;
    let h;
    if (p.i < 0) {
      h = hillRaw;
    } else {
      const lat = (x - track.px[p.i]) * track.nx[p.i] + (z - track.pz[p.i]) * track.nz[p.i];
      const clampedLat = Math.max(-track.wallOffset, Math.min(track.wallOffset, lat));
      const roadY = track.surfaceY(p.i, clampedLat) - 1.1;
      const baseY = roadY + (p.avg - track.py[p.i]) * smoothstep(track.wallOffset + 6, track.wallOffset + 70, p.d);
      const t = smoothstep(track.wallOffset + 5, track.wallOffset + 120, p.d);
      // nach außen verschwindet der Streckenbezug ganz (nahtlos zum Fernbereich)
      const fade = 1 - smoothstep(reach - 40, reach, p.d);
      h = baseY * (1 - t) + (hillRaw + baseY * 0.3 * fade) * t;
      // nie über die Fahrbahn ragen, solange man direkt daneben ist
      if (p.d < track.wallOffset + 22) h = Math.min(h, roadY);
    }
    if (theme.props === 'palms' && z < minZ - 90) h -= (minZ - 90 - z) * 0.09;
    return h;
  };

  // --- Licht, Nebel, Umgebung ---------------------------------------------------
  scene.fog = new THREE.Fog(theme.fog, theme.fogNear * 1.15, theme.fogFar * 1.3);
  scene.background = new THREE.Color(theme.fog);
  const hemi = new THREE.HemisphereLight(theme.skyTop, theme.ground, theme.ambient * 0.85);
  scene.add(hemi);
  const sunOffset = new THREE.Vector3(160, 240, 110);
  const sun = new THREE.DirectionalLight(theme.sun, theme.sunIntensity);
  sun.position.copy(sunOffset);
  sun.castShadow = quality.shadows > 0;
  if (sun.castShadow) {
    sun.shadow.mapSize.set(quality.shadows, quality.shadows);
    const sc = sun.shadow.camera;
    sc.left = -75; sc.right = 75; sc.top = 75; sc.bottom = -75; sc.near = 20; sc.far = 700;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }
  scene.add(sun);
  scene.add(sun.target);

  // Spiegelungs-Umgebung (für Klarlack und Metall)
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new RoomEnvironment();
    const envTex = pmrem.fromScene(envScene, 0.04).texture;
    scene.environment = envTex;
    if ('environmentIntensity' in scene) scene.environmentIntensity = theme.night ? 0.35 : 0.75;
    envScene.dispose?.();
    pmrem.dispose();
    disposables.push(envTex);
  } catch (err) {
    console.warn('[BlueKart] Umgebungsspiegelung nicht verfügbar:', err?.message || err);
  }

  // --- Himmel mit Sonne -----------------------------------------------------------
  const sunDir = sunOffset.clone().normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(theme.skyTop) },
      bottom: { value: new THREE.Color(theme.skyBottom) },
      sunColor: { value: new THREE.Color(theme.night ? 0x9fb4ff : theme.sun) },
      sunDir: { value: sunDir },
      sunSize: { value: theme.night ? 2400.0 : 900.0 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 bottom; uniform vec3 sunColor; uniform vec3 sunDir; uniform float sunSize; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 col = mix(bottom, top, pow(h, 0.6));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += sunColor * (pow(s, sunSize) * 2.5 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(2800, 32, 20), skyMat);
  sky.renderOrder = -10;
  scene.add(sky);
  disposables.push(sky.geometry, skyMat);

  if (theme.night) {
    const n = 900;
    const p = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const a = rand() * Math.PI * 2;
      const e = Math.acos(1 - rand() * 0.95);
      p.set([Math.sin(e) * Math.cos(a) * 2500, Math.cos(e) * 2500, Math.sin(e) * Math.sin(a) * 2500], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, depthWrite: false });
    const stars = new THREE.Points(g, m);
    sky.add(stars);
    disposables.push(g, m);
  } else {
    const ash = theme.props === 'rocks';
    const cloudMat = new THREE.MeshLambertMaterial({
      color: ash ? 0x5b4038 : 0xffffff, emissive: ash ? 0x2a120a : 0x9fb4c8, emissiveIntensity: ash ? 0.6 : 0.45,
      transparent: true, opacity: ash ? 0.85 : 0.9, fog: false, depthWrite: false,
    });
    const cloudGeo = new THREE.IcosahedronGeometry(1, 2);
    const count = 46;
    const clouds = new THREE.InstancedMesh(cloudGeo, cloudMat, count * 3);
    const m4 = new THREE.Matrix4();
    let n = 0;
    for (let i = 0; i < count; i += 1) {
      const a = rand() * Math.PI * 2;
      const r = 450 + rand() * 1600;
      const s = 50 + rand() * 90;
      const y = 230 + rand() * 140;
      for (let k = 0; k < 3; k += 1) {
        m4.compose(
          new THREE.Vector3(cx + Math.cos(a) * r + (k - 1) * s * 1.1, y + rand() * 20, cz + Math.sin(a) * r + (rand() - 0.5) * s),
          new THREE.Quaternion(),
          new THREE.Vector3(s * (1.4 + rand()), s * (0.32 + rand() * 0.15), s * (0.9 + rand() * 0.5)),
        );
        clouds.setMatrixAt(n, m4);
        n += 1;
      }
    }
    clouds.count = n;
    scene.add(clouds);
    disposables.push(cloudGeo, cloudMat);
  }

  // --- Gelände ---------------------------------------------------------------------
  const groundTex = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i += 1) {
      const v = 200 + Math.floor(Math.random() * 55);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 2 + Math.random() * 6);
    }
  }, { repeat: true, srgb: false });
  groundTex.repeat.set(160, 160);
  const size = 3400;
  const seg = quality.terrainSeg;
  const terrainGeo = new THREE.PlaneGeometry(size, size, seg, seg);
  terrainGeo.rotateX(-Math.PI / 2);
  terrainGeo.translate(cx, 0, cz);
  const tpos = terrainGeo.attributes.position;
  const colors = new Float32Array(tpos.count * 3);
  const cGround = new THREE.Color(theme.ground);
  const cAlt = new THREE.Color(theme.groundAlt);
  const cRock = new THREE.Color(theme.props === 'pines' ? 0x9aa7b4 : theme.props === 'canyon' ? 0xa0522d : theme.props === 'rocks' ? 0x1c1716 : 0x7b7064);
  const cPeak = new THREE.Color(theme.props === 'pines' ? 0xffffff : theme.props === 'rocks' ? 0x3a2622 : theme.groundAlt);
  const tmpC = new THREE.Color();
  for (let v = 0; v < tpos.count; v += 1) {
    const x = tpos.getX(v);
    const z = tpos.getZ(v);
    const y = terrainHeight(x, z);
    tpos.setY(v, y);
    const n2 = noise(x * 0.02, z * 0.02);
    tmpC.copy(cGround).lerp(cAlt, n2);
    const rocky = smoothstep(hills.base + hills.amp * 0.45, hills.base + hills.amp * 0.85, y);
    tmpC.lerp(cRock, rocky * 0.7);
    tmpC.lerp(cPeak, smoothstep(hills.base + hills.amp * 0.8, hills.base + hills.amp, y) * 0.8);
    colors.set([tmpC.r, tmpC.g, tmpC.b], v * 3);
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainGeo.computeVertexNormals();
  const terrainMat = new THREE.MeshStandardMaterial({ map: groundTex, vertexColors: true, roughness: 1, metalness: 0 });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);
  disposables.push(terrainGeo, terrainMat, groundTex);

  // --- Fahrbahn -----------------------------------------------------------------------
  const roadTex = canvasTexture(256, 512, (ctx, w, h) => {
    ctx.fillStyle = hex(theme.road);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, 6000, 0.16, 125);
    // Fahrspur-Abnutzung
    const grd = ctx.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0.28, 'rgba(0,0,0,0)');
    grd.addColorStop(0.36, 'rgba(0,0,0,0.12)');
    grd.addColorStop(0.44, 'rgba(0,0,0,0)');
    grd.addColorStop(0.56, 'rgba(0,0,0,0)');
    grd.addColorStop(0.64, 'rgba(0,0,0,0.12)');
    grd.addColorStop(0.72, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillRect(w * 0.025, 0, w * 0.022, h);
    ctx.fillRect(w * 0.953, 0, w * 0.022, h);
    ctx.fillStyle = theme.night ? 'rgba(0,229,255,0.95)' : 'rgba(255,235,120,0.95)';
    ctx.fillRect(w * 0.492, h * 0.04, w * 0.016, h * 0.4);
    ctx.fillRect(w * 0.492, h * 0.54, w * 0.016, h * 0.4);
  }, { repeat: true });
  roadTex.wrapS = THREE.ClampToEdgeWrapping;
  const roadMat = new THREE.MeshStandardMaterial({
    map: roadTex, roughness: theme.night ? 0.55 : 0.9, metalness: 0, envMapIntensity: theme.night ? 0.8 : 0.25,
  });
  const roadGeo = ribbonRange(track, 0, track.N, -track.halfWidth, track.halfWidth, 0.02, 16);
  const road = new THREE.Mesh(roadGeo, roadMat);
  road.receiveShadow = true;
  scene.add(road);
  disposables.push(roadGeo, roadMat, roadTex);

  // Seitenstreifen bis zur Bande + Böschung zum Gelände
  const shoulderTex = canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = hex(theme.groundAlt);
    ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, 900, 0.2, 140);
  }, { repeat: true });
  const shoulderMat = new THREE.MeshStandardMaterial({ map: shoulderTex, roughness: 1 });
  for (const [a, b] of [[-track.wallOffset, -track.halfWidth], [track.halfWidth, track.wallOffset]]) {
    const g = ribbonRange(track, 0, track.N, a, b, 0.012, 8);
    const m = new THREE.Mesh(g, shoulderMat);
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g);
  }
  const bankFn = (i, off, x, z) => {
    const edge = Math.abs(off) <= track.wallOffset + 0.01;
    return edge ? track.surfaceY(i, off) + 0.01 : Math.min(terrainHeight(x, z), track.surfaceY(i, Math.sign(off) * track.wallOffset)) - 0.05;
  };
  for (const [a, b] of [[-track.wallOffset - 14, -track.wallOffset], [track.wallOffset, track.wallOffset + 14]]) {
    const g = ribbonRange(track, 0, track.N, a, b, 0, 8, true, bankFn);
    const m = new THREE.Mesh(g, shoulderMat);
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g);
  }
  disposables.push(shoulderMat, shoulderTex);

  // Randsteine in Kurven (Innenseite)
  const curbTex = canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = hex(theme.curb[0]);
    ctx.fillRect(0, 0, w, h / 2);
    ctx.fillStyle = hex(theme.curb[1]);
    ctx.fillRect(0, h / 2, w, h / 2);
  }, { repeat: true });
  const curbMat = new THREE.MeshStandardMaterial({ map: curbTex, roughness: 0.6 });
  disposables.push(curbMat, curbTex);
  {
    let runStart = -1;
    let runSide = 0;
    const flush = (end) => {
      if (runStart < 0 || end - runStart < 6) { runStart = -1; return; }
      const off = runSide > 0 ? -track.halfWidth : track.halfWidth;
      const inner = runSide > 0 ? -track.halfWidth - 1.6 : track.halfWidth + 1.6;
      const g = ribbonRange(track, runStart, end, Math.min(off, inner), Math.max(off, inner), 0.05, 6, false);
      const m = new THREE.Mesh(g, curbMat);
      m.receiveShadow = true;
      scene.add(m);
      disposables.push(g);
      runStart = -1;
    };
    for (let i = 0; i < track.N; i += 1) {
      const c = track.curvature[i];
      const side = c > 0.0032 ? 1 : c < -0.0032 ? -1 : 0;
      if (side !== 0 && side === runSide && runStart >= 0) continue;
      if (runStart >= 0) flush(i);
      if (side !== 0) { runStart = i; runSide = side; }
    }
    flush(track.N - 1);
  }

  // --- Banden --------------------------------------------------------------------------
  if (track.def.barrier) {
    const count = Math.floor(track.N / 2) * 2;
    const geo = new THREE.BoxGeometry(0.8, 1.2, 4.1);
    const neon = theme.props === 'city';
    const mat = neon
      ? new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0xffffff, emissiveIntensity: 1.4, roughness: 0.4 })
      : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, emissive: 0x5a1a08, emissiveIntensity: 0.6 });
    const inst = new THREE.InstancedMesh(geo, mat, count);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (let i = 0; i < track.N; i += 2) {
      for (const side of [-1, 1]) {
        q.setFromAxisAngle(up, track.heading[i]);
        const off = side * (track.wallOffset + 0.45);
        m4.compose(
          new THREE.Vector3(track.px[i] + track.nx[i] * off, track.surfaceY(i, off) + 0.6, track.pz[i] + track.nz[i] * off),
          q,
          new THREE.Vector3(1, 1, 1),
        );
        inst.setMatrixAt(n, m4);
        col.setHex(theme.curb[(i / 2) % 2 === 0 ? 0 : 1]);
        if (!neon) col.multiplyScalar(0.55);
        inst.setColorAt(n, col);
        n += 1;
      }
    }
    inst.count = n;
    inst.castShadow = !neon;
    inst.receiveShadow = true;
    scene.add(inst);
    disposables.push(geo, mat);
  }

  // --- Start / Ziel + Startampel ---------------------------------------------------------
  const startLights = [];
  {
    const checker = canvasTexture(256, 64, (ctx, w, h) => {
      const cols = 16; const rows = 4;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          ctx.fillStyle = (r + c) % 2 === 0 ? '#ffffff' : '#111111';
          ctx.fillRect((c * w) / cols, (r * h) / rows, w / cols + 1, h / rows + 1);
        }
      }
    });
    const g = ribbonRange(track, 0, 2, -track.halfWidth, track.halfWidth, 0.045, 4);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: checker, roughness: 0.7 }));
    m.receiveShadow = true;
    scene.add(m);
    disposables.push(g, m.material, checker);

    const banner = canvasTexture(1024, 160, (ctx, w, h) => {
      const grd = ctx.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, '#0f172a');
      grd.addColorStop(1, '#1e293b');
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 32; i += 1) {
        ctx.fillStyle = i % 2 ? '#ffffff' : '#111111';
        ctx.fillRect(i * (w / 32), 0, w / 32, 14);
        ctx.fillRect(i * (w / 32), h - 14, w / 32, 14);
      }
      ctx.fillStyle = '#ffffff';
      ctx.font = '900 92px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('BLUEKART · START / ZIEL', w / 2, h / 2 + 2);
    });
    const p0 = track.pointAt(0, 0);
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.6 });
    const half = track.halfWidth + 2.2;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.2, 12, 1.2), postMat);
      post.position.set(side * half, 5, 0);
      post.castShadow = true;
      gantry.add(post);
    }
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.5, metalness: 0.4 });
    const frontMat = new THREE.MeshBasicMaterial({ map: banner });
    const beam = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 1.2, 2.6, 0.8), [sideMat, sideMat, sideMat, sideMat, frontMat, frontMat]);
    beam.position.set(0, 10.6, 0);
    beam.castShadow = true;
    gantry.add(beam);
    // Startampel: 4 Lampen unter dem Balken, nach hinten zur Startaufstellung
    const housing = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.4, 0.6), sideMat);
    housing.position.set(0, 8.6, -0.1);
    gantry.add(housing);
    for (let k = 0; k < 4; k += 1) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x220707, emissive: 0xff1a1a, emissiveIntensity: 0, roughness: 0.3 });
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.5, 20), mat);
      lamp.position.set(-2.25 + k * 1.5, 8.6, -0.42);
      lamp.rotation.y = Math.PI;
      gantry.add(lamp);
      startLights.push(mat);
      disposables.push(mat);
    }
    gantry.position.set(p0.x, track.py[0], p0.z);
    gantry.rotation.y = p0.heading;
    scene.add(gantry);
    disposables.push(postMat, sideMat, frontMat, banner);
  }

  // --- Boost-Felder ------------------------------------------------------------------------
  const padTex = canvasTexture(128, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    for (let k = 0; k < 3; k += 1) {
      const y = 30 + k * 78;
      ctx.beginPath();
      ctx.moveTo(w * 0.1, y + 44);
      ctx.lineTo(w * 0.5, y);
      ctx.lineTo(w * 0.9, y + 44);
      ctx.lineTo(w * 0.9, y + 66);
      ctx.lineTo(w * 0.5, y + 22);
      ctx.lineTo(w * 0.1, y + 66);
      ctx.closePath();
      ctx.fill();
    }
  }, { repeat: true });
  const padMat = new THREE.MeshBasicMaterial({
    map: padTex, color: 0x22e6ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const padBase = new THREE.MeshStandardMaterial({ color: 0x0b2a4a, emissive: 0x06345a, emissiveIntensity: 0.8, roughness: 0.4 });
  padMat.color.setRGB(0.45, 2.6, 3.2); // HDR-Farbe: leuchtet auch tagsüber über die Bloom-Schwelle
  const boostPads = [];
  for (const u of track.def.boostPads || []) {
    const i0 = track.wrap(Math.round(u * track.N));
    const gBase = ribbonRange(track, i0, i0 + 6, -3.4, 3.4, 0.05, 12);
    const gTop = ribbonRange(track, i0, i0 + 6, -3.4, 3.4, 0.07, 12);
    scene.add(new THREE.Mesh(gBase, padBase));
    scene.add(new THREE.Mesh(gTop, padMat));
    const mid = track.pointAt(i0 + 3, 0);
    boostPads.push({ x: mid.x, z: mid.z, idx: track.wrap(i0 + 3) });
    disposables.push(gBase, gTop);
  }
  disposables.push(padMat, padBase, padTex);
  animated.pads = padTex;

  // --- Item-Boxen ---------------------------------------------------------------------------
  const itemBoxes = [];
  const lanes = track.halfWidth > 11 ? [-0.55, 0, 0.55] : [-0.4, 0.4];
  for (const u of track.def.itemBoxes || []) {
    const i0 = track.wrap(Math.round(u * track.N));
    for (const lane of lanes) {
      const lat = lane * track.halfWidth;
      const p = track.pointAt(i0, lat);
      const mesh = makeItemBoxMesh();
      const baseY = track.surfaceY(i0, lat) + 1.55;
      mesh.position.set(p.x, baseY, p.z);
      scene.add(mesh);
      itemBoxes.push({ x: p.x, z: p.z, mesh, baseY, respawn: 0, phase: rand() * Math.PI * 2 });
    }
  }

  // --- Szenerie ---------------------------------------------------------------------------------
  const spread = 460;
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const place = (inst, n, x, y, z, sx, sy, sz, ry = 0, color = null) => {
    tmpE.set(0, ry, 0);
    tmpQ.setFromEuler(tmpE);
    tmpM.compose(new THREE.Vector3(x, y, z), tmpQ, new THREE.Vector3(sx, sy, sz));
    inst.setMatrixAt(n, tmpM);
    if (color) inst.setColorAt(n, color);
  };
  const scatter = (countRaw, minOff, maxOff, fn) => {
    const count = Math.max(1, Math.round(countRaw * quality.props));
    let placed = 0;
    let guard = 0;
    while (placed < count && guard < count * 25) {
      guard += 1;
      const x = minX - spread + rand() * (maxX - minX + spread * 2);
      const z = minZ - spread + rand() * (maxZ - minZ + spread * 2);
      const p = probe(x, z);
      if (p.d < track.wallOffset + minOff || p.d > track.wallOffset + maxOff) continue;
      fn(x, terrainHeight(x, z) - 0.3, z, placed);
      placed += 1;
    }
    return placed;
  };
  const addInstanced = (geo, mat, count, shadow = true) => {
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, Math.round(count * quality.props)));
    inst.castShadow = shadow;
    inst.receiveShadow = true;
    scene.add(inst);
    disposables.push(geo, mat);
    return inst;
  };
  const col = new THREE.Color();

  if (theme.props === 'forest' || theme.props === 'pines') {
    const pines = theme.props === 'pines';
    const count = 620;
    const trunk = addInstanced(new THREE.CylinderGeometry(0.35, 0.5, 3, 7), new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 1 }), count);
    const lower = addInstanced(new THREE.ConeGeometry(2.6, 5, 9), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), count);
    const upper = addInstanced(new THREE.ConeGeometry(1.9, 4.2, 9), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), count);
    const n = scatter(count, 5, 200, (x, y, z, k) => {
      const s = 0.8 + rand() * 1.5;
      const hue = pines ? 0.38 + rand() * 0.05 : 0.27 + rand() * 0.1;
      col.setHSL(hue, pines ? 0.35 : 0.55, pines ? 0.3 + rand() * 0.1 : 0.28 + rand() * 0.12);
      place(trunk, k, x, y + 1.5 * s, z, s, s, s, 0);
      place(lower, k, x, y + 5 * s, z, s, s, s, rand() * 6, col);
      if (pines) col.lerp(new THREE.Color(0xffffff), 0.55);
      place(upper, k, x, y + 8.2 * s, z, s, s, s, rand() * 6, col);
    });
    trunk.count = n; lower.count = n; upper.count = n;
    if (!pines) {
      const bush = addInstanced(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), 300);
      const b = scatter(300, 3, 120, (x, y, z, k) => {
        const s = 0.8 + rand() * 1.4;
        col.setHSL(0.27 + rand() * 0.08, 0.5, 0.25 + rand() * 0.1);
        place(bush, k, x, y + s * 0.5, z, s * 1.3, s, s * 1.3, rand() * 6, col);
      });
      bush.count = b;
    }
  }

  if (theme.props === 'palms') {
    const count = 280;
    const trunk = addInstanced(new THREE.CylinderGeometry(0.3, 0.45, 9, 7), new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 1 }), count);
    const crown = addInstanced(new THREE.SphereGeometry(3.2, 10, 6), new THREE.MeshStandardMaterial({ color: 0x2e9d4f, roughness: 0.8 }), count);
    const n = scatter(count, 5, 160, (x, y, z, k) => {
      const s = 0.8 + rand() * 0.8;
      col.setHSL(0.31 + rand() * 0.05, 0.6, 0.3 + rand() * 0.1);
      place(trunk, k, x, y + 4.5 * s, z, s, s, s, 0);
      place(crown, k, x, y + 9.4 * s, z, s * 1.2, s * 0.32, s * 1.2, rand() * 6, col);
    });
    trunk.count = n; crown.count = n;
    const umbrella = addInstanced(new THREE.ConeGeometry(2.2, 1.1, 10), new THREE.MeshStandardMaterial({ color: 0xffffff }), 60);
    const pole = addInstanced(new THREE.CylinderGeometry(0.08, 0.08, 3, 6), new THREE.MeshStandardMaterial({ color: 0xeeeeee }), 60);
    const u = scatter(60, 6, 60, (x, y, z, k) => {
      col.setHSL(rand(), 0.8, 0.55);
      place(umbrella, k, x, y + 3.1, z, 1, 1, 1, 0, col);
      place(pole, k, x, y + 1.5, z, 1, 1, 1);
    });
    umbrella.count = u; pole.count = u;
    const seaTex = canvasTexture(256, 256, (ctx, w, h) => {
      ctx.fillStyle = hex(theme.sea);
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 260; i += 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 2;
        const x = Math.random() * w; const y = Math.random() * h;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 14, y - 5, x + 30, y); ctx.stroke();
      }
    }, { repeat: true });
    seaTex.repeat.set(60, 40);
    const seaMat = new THREE.MeshStandardMaterial({ map: seaTex, roughness: 0.12, metalness: 0.2, envMapIntensity: 1.2 });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(5000, 2400), seaMat);
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(cx, -4, minZ - 90 - 1200);
    scene.add(sea);
    disposables.push(sea.geometry, seaMat, seaTex);
    animated.sea = seaTex;
  }

  if (theme.props === 'rocks') {
    const count = 380;
    const rock = addInstanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), count);
    const n = scatter(count, 3, 180, (x, y, z, k) => {
      const s = 2 + rand() * 8;
      col.setHSL(0.04 + rand() * 0.04, 0.2, 0.1 + rand() * 0.12);
      place(rock, k, x, y + s * 0.4, z, s, s * (0.6 + rand() * 0.7), s, rand() * 6, col);
    });
    rock.count = n;
    const lavaMat = new THREE.MeshStandardMaterial({ color: 0x220800, emissive: theme.lava, emissiveIntensity: 2.2, roughness: 0.6 });
    const lavaGeo = new THREE.CircleGeometry(1, 22);
    for (let i = 0; i < 26; i += 1) {
      let x = 0; let z = 0; let tries = 0; let flat = false;
      do {
        x = minX - spread + rand() * (maxX - minX + spread * 2);
        z = minZ - spread + rand() * (maxZ - minZ + spread * 2);
        tries += 1;
        const h0 = terrainHeight(x, z);
        flat = Math.abs(terrainHeight(x + 12, z) - h0) < 2 && Math.abs(terrainHeight(x, z + 12) - h0) < 2;
      } while (tries < 60 && (probe(x, z).d < track.wallOffset + 18 || !flat));
      const lava = new THREE.Mesh(lavaGeo, lavaMat);
      lava.rotation.x = -Math.PI / 2;
      const r = 7 + rand() * 18;
      lava.scale.set(r, r * (0.6 + rand() * 0.5), 1);
      lava.position.set(x, terrainHeight(x, z) + 0.35, z);
      scene.add(lava);
    }
    disposables.push(lavaMat, lavaGeo);
    const vm = new THREE.Mesh(new THREE.ConeGeometry(320, 420, 28, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c1d1a, roughness: 1, flatShading: true, side: THREE.DoubleSide }));
    vm.position.set(cx - 300, 200, minZ - 950);
    scene.add(vm);
    const crater = new THREE.Mesh(new THREE.CircleGeometry(72, 22), new THREE.MeshBasicMaterial({ color: 0xff7a30, fog: false }));
    crater.rotation.x = -Math.PI / 2;
    crater.position.set(cx - 300, 408, minZ - 950);
    scene.add(crater);
    disposables.push(vm.geometry, vm.material, crater.geometry, crater.material);
  }

  if (theme.props === 'city') {
    const count = 260;
    const winTex = canvasTexture(128, 256, (ctx, w, h) => {
      ctx.fillStyle = '#0a0c1d';
      ctx.fillRect(0, 0, w, h);
      for (let y = 6; y < h - 6; y += 12) {
        for (let x = 6; x < w - 6; x += 12) {
          const on = Math.random() < 0.55;
          ctx.fillStyle = on ? (Math.random() < 0.3 ? '#7be4ff' : '#ffd98a') : '#14172e';
          ctx.fillRect(x, y, 6, 8);
        }
      }
    }, { repeat: true });
    const bMat = new THREE.MeshStandardMaterial({ map: winTex, emissiveMap: winTex, emissive: 0xffffff, emissiveIntensity: 1.1, roughness: 0.35, metalness: 0.3 });
    const b = addInstanced(new THREE.BoxGeometry(1, 1, 1), bMat, count, false);
    const n = scatter(count, 6, 220, (x, y, z, k) => {
      const w = 16 + rand() * 38;
      const d = 16 + rand() * 38;
      const h = 30 + Math.pow(rand(), 1.8) * 170;
      col.setHSL(0.6 + rand() * 0.2, 0.25, 0.7 + rand() * 0.3);
      place(b, k, x, y + h / 2, z, w, h, d, rand() < 0.5 ? 0 : Math.PI / 2, col);
    });
    b.count = n;
    disposables.push(winTex);
    // Neon-Laternen entlang der Strecke
    const lampGeo = new THREE.CylinderGeometry(0.12, 0.12, 7, 6);
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x1e1b4b, roughness: 0.5 });
    const glowGeo = new THREE.SphereGeometry(0.45, 10, 8);
    const glowMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff2bd6, emissiveIntensity: 3 });
    const glowMat2 = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x00e5ff, emissiveIntensity: 3 });
    const poles = new THREE.InstancedMesh(lampGeo, lampMat, Math.ceil(track.N / 20) * 2);
    const glowsA = new THREE.InstancedMesh(glowGeo, glowMat, Math.ceil(track.N / 20));
    const glowsB = new THREE.InstancedMesh(glowGeo, glowMat2, Math.ceil(track.N / 20));
    let pn = 0; let ga = 0; let gb = 0;
    for (let i = 0; i < track.N; i += 20) {
      for (const side of [-1, 1]) {
        const off = side * (track.wallOffset + 2.2);
        const x = track.px[i] + track.nx[i] * off;
        const z = track.pz[i] + track.nz[i] * off;
        const y = track.surfaceY(i, off);
        place(poles, pn, x, y + 3.5, z, 1, 1, 1);
        pn += 1;
        if (side < 0) { place(glowsA, ga, x, y + 7.1, z, 1, 1, 1); ga += 1; } else { place(glowsB, gb, x, y + 7.1, z, 1, 1, 1); gb += 1; }
      }
    }
    poles.count = pn; glowsA.count = ga; glowsB.count = gb;
    scene.add(poles, glowsA, glowsB);
    disposables.push(lampGeo, lampMat, glowGeo, glowMat, glowMat2);
  }

  if (theme.props === 'canyon') {
    const count = 160;
    const mesa = addInstanced(new THREE.CylinderGeometry(1, 1.25, 1, 8), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), count);
    const n = scatter(count, 8, 240, (x, y, z, k) => {
      const r = 14 + rand() * 40;
      const h = 25 + rand() * 90;
      col.setHSL(0.05 + rand() * 0.04, 0.55, 0.35 + rand() * 0.15);
      place(mesa, k, x, y + h / 2, z, r, h, r * (0.7 + rand() * 0.6), rand() * 6, col);
    });
    mesa.count = n;
    const cactus = addInstanced(new THREE.CylinderGeometry(0.5, 0.6, 5, 8), new THREE.MeshStandardMaterial({ color: 0x3f8f4b, roughness: 0.9 }), 160);
    const arm = addInstanced(new THREE.CylinderGeometry(0.35, 0.35, 2.4, 8), new THREE.MeshStandardMaterial({ color: 0x3f8f4b, roughness: 0.9 }), 160);
    const c = scatter(160, 5, 120, (x, y, z, k) => {
      const s = 0.8 + rand() * 1.3;
      place(cactus, k, x, y + 2.5 * s, z, s, s, s);
      place(arm, k, x + 0.9 * s, y + 3.3 * s, z, s, s, s);
    });
    cactus.count = c; arm.count = c;
    const rock = addInstanced(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), 240);
    const r = scatter(240, 4, 140, (x, y, z, k) => {
      const s = 1 + rand() * 4;
      col.setHSL(0.07, 0.4, 0.3 + rand() * 0.15);
      place(rock, k, x, y + s * 0.4, z, s, s * 0.7, s, rand() * 6, col);
    });
    rock.count = r;
  }

  // Ferne Berge
  if (theme.props !== 'city') {
    const colors = { forest: 0x6d8f78, pines: 0xdbe6f0, palms: 0x8fb0c4, rocks: 0x2b1b18, canyon: 0xb8794a };
    const mGeo = new THREE.ConeGeometry(1, 1, 7);
    const mMat = new THREE.MeshStandardMaterial({ color: colors[theme.props] || 0x7a8a7a, roughness: 1, flatShading: true });
    const mount = new THREE.InstancedMesh(mGeo, mMat, 30);
    for (let i = 0; i < 30; i += 1) {
      const a = (i / 30) * Math.PI * 2 + rand() * 0.2;
      const r = 1350 + rand() * 300;
      const s = 170 + rand() * 230;
      const h = 150 + rand() * 300;
      place(mount, i, cx + Math.cos(a) * r, h / 2 - 10, cz + Math.sin(a) * r, s, h, s, rand() * 6);
    }
    scene.add(mount);
    disposables.push(mGeo, mMat);
  }

  // --- Update ---------------------------------------------------------------------------------
  return {
    boostPads,
    itemBoxes,
    track,
    terrainHeight,
    // Bloom nur für wirklich helle Quellen (Lichter, Neon, Lava, Sonne, Boost):
    // die Schwelle liegt bei Tag über der Helligkeit sonnenbeschienener Flächen.
    bloomStrength: theme.night ? 0.95 : theme.props === 'rocks' ? 0.75 : theme.props === 'pines' ? 0.28 : 0.38,
    bloomThreshold: theme.night ? 0.72 : theme.props === 'rocks' ? 1.0 : theme.props === 'pines' ? 3.4 : 2.4,
    /** Startampel: n rote Lampen (0–4) oder 'go' = alle grün, 'off'. */
    setStartLights(state) {
      startLights.forEach((m, k) => {
        if (state === 'go') {
          m.emissive.setHex(0x22ff66);
          m.emissiveIntensity = 4.5;
        } else if (state === 'off') {
          m.emissiveIntensity = 0;
        } else {
          m.emissive.setHex(0xff1a1a);
          m.emissiveIntensity = k < state ? 4.5 : 0.05;
        }
      });
    },
    update(dt, time, focus) {
      if (focus) {
        sun.position.set(focus.x + sunOffset.x, (focus.y || 0) + sunOffset.y, focus.z + sunOffset.z);
        sun.target.position.set(focus.x, focus.y || 0, focus.z);
        sky.position.set(focus.x, 0, focus.z);
      }
      if (animated.pads) animated.pads.offset.y -= dt * 1.6;
      if (animated.sea) { animated.sea.offset.x += dt * 0.004; animated.sea.offset.y += dt * 0.002; }
      for (const box of itemBoxes) {
        if (box.respawn > 0) {
          box.respawn -= dt;
          box.mesh.visible = box.respawn <= 0;
        }
        if (box.mesh.visible) {
          box.mesh.rotation.y = time * 1.6 + box.phase;
          box.mesh.position.y = box.baseY + Math.sin(time * 2.2 + box.phase) * 0.22;
        }
      }
    },
    dispose() {
      for (const d of disposables) d?.dispose?.();
      scene.environment = null;
    },
  };
}
