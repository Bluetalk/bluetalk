/**
 * RaceScene — echter 3D-Renderer für das Autorennen (Three.js).
 *
 * Kernidee: Die Physik bleibt 1D-entlang-der-Strecke (progress) + seitlicher
 * Versatz (x). Aus den Streckenprofilen (turns = Gierkurve, elevation = Höhe,
 * bank = Neigung) wird pro Frame eine *mitrollende* 3D-Bandgeometrie um das
 * eigene Auto integriert. Dadurch braucht die Strecke keine geschlossene
 * Weltschleife (kein Naht-Sprung), und dieselbe Geometrie liefert Position,
 * Tangente und Hoch-Vektor, um jedes Auto exakt auf die Straße zu setzen.
 *
 * Öffentliche API:
 *   const scene = new RaceScene(canvas);
 *   scene.setTrack(track);
 *   scene.update({ track, sim, selfId, input, raceState, t });
 *   scene.resize(); scene.dispose();
 */
import * as THREE from 'three';

const SEG = 15;          // progress-Einheiten pro Bandsegment
const AHEAD = 56;        // sichtbare Segmente vor dem Auto
const BEHIND = 6;        // Segmente hinter dem Auto
const N = AHEAD + BEHIND;
const ROAD_HALF = 9;     // Welt-Halbbreite der Straße bei track.width = 1
const SHOULDER = 4.4;    // Grasrand reicht bis ROAD_HALF * SHOULDER
const KERB = 1.11;       // Randstein-Aussenkante in Halbbreiten
const ELEV_AMP = 30;     // Höhenamplitude (Welt-Einheiten)
const BANK_AMP = 0.62;   // maximale Steilkurven-Neigung (rad)
const TURN_K = 0.09;     // Gieränderung pro Segment je Kurveneinheit
const GRASS_DROP = 0;    // Grasrand koplanar (vermeidet Lücken bei FrontSide)
const CAR_LIFT = 1.05;   // Radaufstandshöhe über der Fahrbahn

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (v, len) => ((v % len) + len) % len;

function sampleProfile(arr, length, s) {
  if (!arr || !arr.length) return 0;
  const d = wrap(s, length);
  const seg = (d / length) * arr.length;
  const i = Math.floor(seg) % arr.length;
  const f = seg - Math.floor(seg);
  const a = arr[i] || 0;
  const b = arr[(i + 1) % arr.length] || 0;
  return a + (b - a) * f;
}

// Lateral-Grenzen der 5 Bänder (in Halbbreiten): GrasL | RandL | Straße | RandR | GrasR
const BOUNDS = [-SHOULDER, -KERB, -1, 1, KERB, SHOULDER];
const BANDS = BOUNDS.length - 1; // 5
const VERTS_PER_SEG = BANDS * 6; // 2 Dreiecke je Band

export class RaceScene {
  constructor(canvas) {
    this.canvas = canvas;
    this.trackId = null;
    this.track = null;
    this._lastContS = 0;
    this._camReady = false;
    this._prevX = new Map();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // Pixelratio hart auf 1 kappen: im maximierten Fenster ist die Füllrate der
    // Flaschenhals — High-DPI würde den Framebuffer vervierfachen.
    this.renderer.setPixelRatio(1);
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 16 / 9, 0.5, 6000);
    this.camPos = new THREE.Vector3(0, 8, 18);
    this.camLook = new THREE.Vector3(0, 2, -30);

    // Licht
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x30302a, 0.95);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.15);
    this.sun.position.set(-120, 220, 60);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Himmelskuppel (vertikaler Farbverlauf über Vertex-Farben)
    const skyGeo = new THREE.SphereGeometry(4200, 24, 16);
    const skyCount = skyGeo.attributes.position.count;
    skyGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(skyCount * 3), 3));
    this.skyGeo = skyGeo;
    this.sky = new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    this.scene.add(this.sky);

    // Straßenband (dynamisch, non-indexed für flache Segmentfarben)
    const roadGeo = new THREE.BufferGeometry();
    const vCount = N * VERTS_PER_SEG;
    this._roadPos = new Float32Array(vCount * 3);
    this._roadCol = new Float32Array(vCount * 3);
    this._roadNor = new Float32Array(vCount * 3);
    roadGeo.setAttribute('position', new THREE.BufferAttribute(this._roadPos, 3));
    roadGeo.setAttribute('color', new THREE.BufferAttribute(this._roadCol, 3));
    roadGeo.setAttribute('normal', new THREE.BufferAttribute(this._roadNor, 3));
    this.roadGeo = roadGeo;
    // Lambert statt Standard (viel günstiger pro Pixel) + FrontSide halbiert
    // die Fragmentlast. Normalen liefern wir selbst aus den Frame-Up-Vektoren.
    this.road = new THREE.Mesh(roadGeo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide }));
    this.road.frustumCulled = false;
    this.scene.add(this.road);

    // wiederverwendbare Frames
    this.frames = [];
    for (let i = 0; i <= N; i++) {
      this.frames.push({
        s: 0,
        center: new THREE.Vector3(),
        tangent: new THREE.Vector3(0, 0, -1),
        right: new THREE.Vector3(1, 0, 0),
        up: new THREE.Vector3(0, 1, 0),
      });
    }
    this.baseS = 0;
    this.halfWidth = ROAD_HALF;

    // Pools
    this.cars = new Map();
    this.propMesh = null;
    this.cones = this._makePool(() => this._makeCone(), 14);
    this.pads = this._makePool(() => this._makePad(), 8);
    this.startLine = this._makeStartLine();
    this.scene.add(this.startLine);
    this.startLine.visible = false;

    // temporäre Vektoren / Objekte (einmalig, um GC-Ruckler zu vermeiden)
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._dummy = new THREE.Object3D();
    this._euler = new THREE.Euler();
    this._fc1 = new THREE.Vector3();
    this._fc2 = new THREE.Vector3();
    this._fc3 = new THREE.Vector3();
    this._fc4 = new THREE.Vector3();
    this._tmpCol = new THREE.Color();
    this._selfTangent = new THREE.Vector3();
    this._selfUp = new THREE.Vector3();
    this._selfFrame = { tangent: this._selfTangent, up: this._selfUp };
    this._tmpFrameA = { center: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), tangent: new THREE.Vector3() };
    this._tmpFrameB = { center: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), tangent: new THREE.Vector3() };
    // Feste Farben (Grasfarben werden pro Strecke gesetzt)
    this._colRoadA = new THREE.Color('#39414f');
    this._colRoadB = new THREE.Color('#2f3644');
    this._colKerbA = new THREE.Color('#dc2626');
    this._colKerbB = new THREE.Color('#e5e7eb');
    this._colBoost = new THREE.Color('#164e63');
    this._colGroundA = new THREE.Color('#1c2b23');
    this._colGroundB = new THREE.Color('#16231c');

    this.resize();
  }

  // ---- Aufbau-Helfer ----

  _makePool(factory, count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const m = factory();
      m.visible = false;
      this.scene.add(m);
      arr.push(m);
    }
    return arr;
  }

  _makeCone() {
    const g = new THREE.ConeGeometry(1.4, 4.2, 10);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xf97316, roughness: 0.7 }));
    return m;
  }

  _makePad() {
    const g = new THREE.PlaneGeometry(6, SEG * 1.1);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    return m;
  }

  _makeStartLine() {
    // Karierte Start-/Ziellinie als Textur auf einem Quad
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const ctx = c.getContext('2d');
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#0b0f19' : '#f8fafc';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.repeat.set(6, 1);
    const g = new THREE.PlaneGeometry(ROAD_HALF * 2, SEG * 0.9);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    return m;
  }

  _makeCarMesh(color) {
    const group = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.35, metalness: 0.45 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0b0f19, roughness: 0.5, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x0f2436, roughness: 0.15, metalness: 0.6 });
    // Karosserie (Nase zeigt in -Z)
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.7, 4.4), paint);
    body.position.y = 0.55;
    group.add(body);
    const nose = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.4, 1.1), paint);
    nose.position.set(0, 0.4, -2.1);
    group.add(nose);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 1.9), glass);
    cabin.position.set(0, 1.0, 0.1);
    group.add(cabin);
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.5), dark);
    spoiler.position.set(0, 1.0, 2.2);
    group.add(spoiler);
    // Räder
    const wheelGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.5, 12);
    const wheels = [];
    for (const [wx, wz] of [[-1.05, -1.4], [1.05, -1.4], [-1.05, 1.5], [1.05, 1.5]]) {
      const w = new THREE.Mesh(wheelGeo, dark);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.55, wz);
      group.add(w);
      wheels.push(w);
    }
    // Bremslicht-/Boost-Glow hinten
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.set(0, 0.6, 2.35);
    group.add(glow);
    // Blob-Schatten
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.4, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.05;
    group.add(shadow);

    group.userData = { wheels, glow, paint, body };
    return group;
  }

  // ---- Track-Setup ----

  setTrack(track) {
    this.track = track;
    this.trackId = track.id;
    this.halfWidth = ROAD_HALF * (track.width || 1);
    this._colGroundA.set(track.ground?.[0] || '#1c2b23');
    this._colGroundB.set(track.ground?.[1] || '#16231c');

    const pal = track.palette || ['#38bdf8', '#164e63', '#e0f2fe'];
    const horizon = new THREE.Color(pal[0]).lerp(new THREE.Color('#0b1020'), 0.4);
    const top = new THREE.Color(pal[1]).lerp(new THREE.Color('#03040a'), 0.55);

    // Himmels-Gradient einfärben
    const pos = this.skyGeo.attributes.position;
    const col = this.skyGeo.attributes.color;
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const f = clamp((y / 4200) * 0.5 + 0.5, 0, 1);
      tmp.copy(horizon).lerp(top, Math.pow(f, 0.7));
      col.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    col.needsUpdate = true;

    this.scene.fog = new THREE.Fog(horizon.getHex(), 140, AHEAD * SEG * 0.95);
    this.renderer.setClearColor(horizon.getHex(), 1);

    const night = track.scenery === 'city' || track.scenery === 'volcano';
    this.hemi.color.copy(new THREE.Color(pal[0]).lerp(new THREE.Color('#ffffff'), 0.3));
    this.hemi.groundColor.set(track.ground?.[1] || '#20281c');
    this.hemi.intensity = night ? 0.6 : 1.0;
    this.sun.intensity = night ? 0.6 : 1.2;
    this.sun.color.set(night ? 0xaecbff : 0xfff2d8);

    this._buildProps(track);
    this._camReady = false;
  }

  _buildProps(track) {
    if (this.propMesh) {
      this.scene.remove(this.propMesh);
      this.propMesh.geometry.dispose();
      this.propMesh.material.dispose();
      this.propMesh = null;
    }
    const scenery = track.scenery;
    let geo; let color; let scaleY = 1; let half = 6;
    if (scenery === 'forest' || scenery === 'mountain') {
      geo = new THREE.ConeGeometry(3.2, 12, 7); color = scenery === 'forest' ? 0x1f7a3d : 0x2f5a44; half = 6;
    } else if (scenery === 'city') {
      geo = new THREE.BoxGeometry(7, 30, 7); color = 0x1b2440; half = 15;
    } else if (scenery === 'desert') {
      geo = new THREE.IcosahedronGeometry(3.4, 0); color = 0x8a5a2c; half = 3.4;
    } else {
      geo = new THREE.ConeGeometry(3.6, 16, 5); color = 0x3a1c17; half = 8; // volcano spires
    }
    this.propHalf = half;
    const mat = new THREE.MeshLambertMaterial({ color, flatShading: true });
    const count = 44;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(mesh);
    this.propMesh = mesh;
    this.propScaleY = scaleY;

    // deterministische Slots über eine Runde
    const len = track.length;
    const step = 62;
    const slots = [];
    let seed = 987654321 ^ track.id.length;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let s = 0; s < len; s += step) {
      const side = rnd() < 0.5 ? -1 : 1;
      slots.push({ s, side, lat: rnd() * 2.7, scale: 0.7 + rnd() * 0.8, rot: rnd() * Math.PI });
      if (rnd() < 0.55) {
        slots.push({ s: s + step * 0.5, side: -side, lat: rnd() * 2.8, scale: 0.7 + rnd() * 0.9, rot: rnd() * Math.PI });
      }
    }
    this.propSlots = slots;
  }

  // ---- pro Frame ----

  _buildRibbon(track, contS) {
    const length = track.length;
    const baseS = contS - BEHIND * SEG;
    this.baseS = baseS;
    const frames = this.frames;
    // Integration der Mittellinie
    let heading = 0;
    let px = 0; let pz = 0;
    for (let i = 0; i <= N; i++) {
      const s = baseS + i * SEG;
      const y = sampleProfile(track.elevation, length, s) * ELEV_AMP;
      const f = frames[i];
      f.s = s;
      f.center.set(px, y, pz);
      const curve = sampleProfile(track.turns, length, s);
      heading += curve * TURN_K;
      px += Math.sin(heading) * SEG;
      pz += -Math.cos(heading) * SEG;
    }
    // Tangenten, Neigung, Rechts-/Hoch-Vektoren
    for (let i = 0; i <= N; i++) {
      const f = frames[i];
      const a = frames[Math.max(0, i - 1)];
      const b = frames[Math.min(N, i + 1)];
      f.tangent.copy(b.center).sub(a.center).normalize();
      const right0 = this._v.copy(f.tangent).cross(WORLD_UP);
      if (right0.lengthSq() < 1e-6) right0.set(1, 0, 0);
      right0.normalize();
      const upT = this._v2.copy(right0).cross(f.tangent).normalize();
      const bankA = sampleProfile(track.bank, length, f.s) * BANK_AMP;
      const cos = Math.cos(bankA); const sin = Math.sin(bankA);
      f.right.copy(right0).multiplyScalar(cos).addScaledVector(upT, -sin).normalize();
      f.up.copy(f.right).cross(f.tangent).normalize();
    }
    this._fillRoad(track);
  }

  _nearList(list, s, len, range) {
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      let d = wrap(s - list[i], len);
      if (d > len / 2) d -= len;
      if (Math.abs(d) < range) return true;
    }
    return false;
  }

  _fillRoad(track) {
    const pos = this._roadPos;
    const col = this._roadCol;
    const nor = this._roadNor;
    const hw = this.halfWidth;
    const len = track.length;
    const frames = this.frames;
    const cA = this._fc1; const cB = this._fc2; const pA = this._fc3; const pB = this._fc4;
    const tmp = this._tmpCol;

    let o = 0; // Vertex-Offset
    for (let i = 0; i < N; i++) {
      const fa = frames[i];
      const fb = frames[i + 1];
      const alt = Math.floor(wrap(fa.s, len) / SEG) % 2;
      const boost = this._nearList(track.boosts, fa.s, len, 45);
      for (let band = 0; band < BANDS; band++) {
        const bL = BOUNDS[band];
        const bR = BOUNDS[band + 1];
        const isGrass = band === 0 || band === BANDS - 1;
        const isKerb = band === 1 || band === BANDS - 2;

        // vier Eckpunkte (Grasrand koplanar, GRASS_DROP = 0)
        cA.copy(fa.center).addScaledVector(fa.right, bL * hw);
        cB.copy(fa.center).addScaledVector(fa.right, bR * hw);
        pA.copy(fb.center).addScaledVector(fb.right, bL * hw);
        pB.copy(fb.center).addScaledVector(fb.right, bR * hw);

        if (isGrass) tmp.copy(alt ? this._colGroundA : this._colGroundB);
        else if (isKerb) tmp.copy(alt ? this._colKerbA : this._colKerbB);
        else { tmp.copy(alt ? this._colRoadA : this._colRoadB); if (boost) tmp.lerp(this._colBoost, 0.5); }

        // 2 Dreiecke: (cA,cB,pB) (cA,pB,pA) — Normalen aus den Frame-Up-Vektoren
        this._vert(pos, col, nor, o++, cA, fa.up, tmp);
        this._vert(pos, col, nor, o++, cB, fa.up, tmp);
        this._vert(pos, col, nor, o++, pB, fb.up, tmp);
        this._vert(pos, col, nor, o++, cA, fa.up, tmp);
        this._vert(pos, col, nor, o++, pB, fb.up, tmp);
        this._vert(pos, col, nor, o++, pA, fb.up, tmp);
      }
    }
    this.roadGeo.attributes.position.needsUpdate = true;
    this.roadGeo.attributes.color.needsUpdate = true;
    this.roadGeo.attributes.normal.needsUpdate = true;
  }

  _vert(pos, col, nor, o, p, n, color) {
    const k = o * 3;
    pos[k] = p.x; pos[k + 1] = p.y; pos[k + 2] = p.z;
    nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z;
    col[k] = color.r; col[k + 1] = color.g; col[k + 2] = color.b;
  }

  // Interpoliertes Frame an absoluter Strecken-Position (oder null ausserhalb)
  _frameAt(s, out) {
    const idx = (s - this.baseS) / SEG;
    if (idx < 0 || idx > N) return null;
    const i0 = Math.floor(idx);
    const i1 = Math.min(N, i0 + 1);
    const f = idx - i0;
    const a = this.frames[i0];
    const b = this.frames[i1];
    out.center.copy(a.center).lerp(b.center, f);
    out.right.copy(a.right).lerp(b.right, f).normalize();
    out.up.copy(a.up).lerp(b.up, f).normalize();
    out.tangent.copy(a.tangent).lerp(b.tangent, f).normalize();
    return out;
  }

  _jumpLift(track, contS, speed) {
    const jumps = track.jumps || [];
    if (!jumps.length) return 0;
    const loop = wrap(contS, track.length);
    for (const js of jumps) {
      let d = loop - js;
      if (d < -track.length / 2) d += track.length;
      if (d > track.length / 2) d -= track.length;
      const air = clamp(speed * 0.9, 40, 130);
      if (d > 0 && d < air) {
        const f = d / air;             // 0..1 über die Flugphase
        return Math.sin(f * Math.PI) * (6 + speed * 0.16);
      }
    }
    return 0;
  }

  update({ track, sim, selfId, input, raceState, t }) {
    if (!track) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (track.id !== this.trackId) this.setTrack(track);
    const length = track.length;
    const self = sim.get(selfId);
    const selfContS = self ? (self.lap - 1) * length + self.progress : this._lastContS;
    // grosser Sprung (Reset/Join) -> Kamera hart nachziehen
    const jumped = Math.abs(selfContS - this._lastContS) > length * 0.5 + 200;
    this._lastContS = selfContS;

    this._buildRibbon(track, selfContS);

    const selfLoop = wrap(selfContS, length);
    const tmpFrame = this._tmpFrameA;

    // Autos platzieren
    const seen = new Set();
    let selfWorld = null; let selfFrame = null; let selfSpeed = 0;
    for (const p of sim.values()) {
      const contS = (p.lap - 1) * length + p.progress;
      const pLoop = wrap(contS, length);
      let rel = pLoop - selfLoop;
      if (rel > length / 2) rel -= length;
      if (rel < -length / 2) rel += length;
      const renderS = selfContS + rel;
      const fr = this._frameAt(renderS, tmpFrame);
      seen.add(p.peerId);
      let car = this.cars.get(p.peerId);
      if (!car) { car = this._makeCarMesh(p.color); this.scene.add(car); this.cars.set(p.peerId, car); }
      if (!fr) { car.visible = false; continue; }
      car.visible = true;

      const isSelf = p.peerId === selfId;
      const lift = CAR_LIFT + this._jumpLift(track, contS, p.speed || 0);
      const worldPos = fr.center.clone()
        .addScaledVector(fr.right, (p.x || 0) * this.halfWidth)
        .addScaledVector(fr.up, lift);
      car.position.copy(worldPos);
      this._m.makeBasis(fr.right, fr.up, this._v.copy(fr.tangent).negate());
      car.quaternion.setFromRotationMatrix(this._m);

      // Lenk-Neigung
      const prevX = this._prevX.get(p.peerId) ?? (p.x || 0);
      const dx = (p.x || 0) - prevX;
      this._prevX.set(p.peerId, p.x || 0);
      const steer = isSelf ? (input?.steer || 0) : clamp(dx * 8, -1, 1);
      this._euler.set(0, steer * 0.10, -steer * 0.16);
      this._q.setFromEuler(this._euler);
      car.quaternion.multiply(this._q);

      // Räder drehen + Effekte
      const ud = car.userData;
      const spin = (p.speed || 0) * 0.06;
      for (const w of ud.wheels) w.rotation.x -= spin;
      const boosting = isSelf ? Boolean(input?.boost && (p.boostFuel || 0) > 0) : (p.speed || 0) > 95;
      const braking = isSelf ? Boolean(input?.brake) : false;
      ud.glow.material.color.set(braking ? 0xef4444 : 0x22d3ee);
      ud.glow.material.opacity = braking ? 0.85 : (boosting ? 0.7 + 0.3 * Math.sin(t / 45) : 0.0);
      const crashed = (p.crashedUntil || 0) > t;
      car.scale.setScalar(crashed ? 0.94 + 0.06 * Math.abs(Math.sin(t / 60)) : 1);

      if (isSelf) {
        selfWorld = worldPos;
        // fr zeigt auf das wiederverwendete tmpFrame — Vektoren kopieren,
        // sonst überschreibt das nächste Auto die Kamera-Basis.
        this._selfTangent.copy(fr.tangent);
        this._selfUp.copy(fr.up);
        selfFrame = this._selfFrame;
        selfSpeed = p.speed || 0;
      }
    }
    for (const [id, car] of this.cars) {
      if (!seen.has(id)) { this.scene.remove(car); this.cars.delete(id); this._prevX.delete(id); }
    }

    this._placeDecor(track, selfContS, t);
    this._updateCamera(selfWorld, selfFrame, selfSpeed, jumped);

    this.renderer.render(this.scene, this.camera);
  }

  _placeDecor(track, selfContS, t) {
    const tmpFrame = this._tmpFrameB;
    const windowLen = N * SEG;
    const nearestOcc = (s0) => {
      let occ = s0 + Math.ceil((this.baseS - s0) / track.length) * track.length;
      return occ;
    };

    // Requisiten
    if (this.propMesh && this.propSlots) {
      let idx = 0;
      const dummy = this._dummy;
      for (const slot of this.propSlots) {
        if (idx >= this.propMesh.count) break;
        const occ = nearestOcc(slot.s);
        if (occ > this.baseS + windowLen) continue;
        const fr = this._frameAt(occ, tmpFrame);
        if (!fr) continue;
        const lat = (1.35 + slot.lat) * this.halfWidth * slot.side;
        const rise = this.propHalf * slot.scale - GRASS_DROP;
        dummy.position.copy(fr.center).addScaledVector(fr.right, lat).addScaledVector(fr.up, rise);
        dummy.rotation.set(0, slot.rot, 0);
        dummy.scale.set(slot.scale, slot.scale * this.propScaleY, slot.scale);
        dummy.updateMatrix();
        this.propMesh.setMatrixAt(idx, dummy.matrix);
        idx++;
      }
      for (let k = idx; k < this.propMesh.count; k++) {
        dummy.position.set(0, -9999, 0); dummy.scale.setScalar(0.0001); dummy.updateMatrix();
        this.propMesh.setMatrixAt(k, dummy.matrix);
      }
      this.propMesh.instanceMatrix.needsUpdate = true;
    }

    // Hütchen (Hindernisse)
    let ci = 0;
    for (const hs of (track.hazards || [])) {
      const occ = nearestOcc(hs);
      if (occ > this.baseS + windowLen) continue;
      const fr = this._frameAt(occ, tmpFrame);
      if (!fr) continue;
      for (const side of [-0.28, 0.28]) {
        if (ci >= this.cones.length) break;
        const c = this.cones[ci++];
        c.visible = true;
        c.position.copy(fr.center).addScaledVector(fr.right, side * this.halfWidth).addScaledVector(fr.up, 2.1);
        this._m.makeBasis(fr.right, fr.up, this._v.copy(fr.tangent).negate());
        c.quaternion.setFromRotationMatrix(this._m);
      }
    }
    for (let k = ci; k < this.cones.length; k++) this.cones[k].visible = false;

    // Boost-Pads
    let pi = 0;
    for (const bs of (track.boosts || [])) {
      const occ = nearestOcc(bs);
      if (occ > this.baseS + windowLen) continue;
      const fr = this._frameAt(occ, tmpFrame);
      if (!fr || pi >= this.pads.length) continue;
      const pad = this.pads[pi++];
      pad.visible = true;
      pad.position.copy(fr.center).addScaledVector(fr.up, 0.2);
      this._m.makeBasis(fr.right, fr.up, this._v.copy(fr.tangent).negate());
      pad.quaternion.setFromRotationMatrix(this._m);
      pad.rotateX(Math.PI / 2);
      pad.material.opacity = 0.4 + 0.25 * Math.sin(t / 160 + bs);
    }
    for (let k = pi; k < this.pads.length; k++) this.pads[k].visible = false;

    // Start-/Ziellinie (bei s ≡ 0)
    const occ0 = nearestOcc(0);
    const fr0 = occ0 <= this.baseS + windowLen ? this._frameAt(occ0, tmpFrame) : null;
    if (fr0) {
      this.startLine.visible = true;
      this.startLine.scale.set(track.width || 1, 1, 1);
      this.startLine.position.copy(fr0.center).addScaledVector(fr0.up, 0.15);
      this._m.makeBasis(fr0.right, fr0.up, this._v.copy(fr0.tangent).negate());
      this.startLine.quaternion.setFromRotationMatrix(this._m);
      this.startLine.rotateX(Math.PI / 2);
    } else {
      this.startLine.visible = false;
    }
  }

  _updateCamera(selfWorld, selfFrame, speed, snap) {
    if (!selfWorld || !selfFrame) return;
    const back = 15 + speed * 0.06;
    const height = 6.2 + speed * 0.015;
    const targetPos = this._v.copy(selfWorld)
      .addScaledVector(selfFrame.tangent, -back)
      .addScaledVector(selfFrame.up, height);
    const look = this._v2.copy(selfWorld)
      .addScaledVector(selfFrame.tangent, 26)
      .addScaledVector(selfFrame.up, 2.5);
    const a = snap || !this._camReady ? 1 : 0.16;
    this.camPos.lerp(targetPos, a);
    this.camLook.lerp(look, snap || !this._camReady ? 1 : 0.2);
    this._camReady = true;
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(selfFrame.up);
    this.camera.lookAt(this.camLook);
    // Himmel + Sonne folgen der Kamera (statischer Horizont)
    this.sky.position.copy(this.camPos);
    this.sun.position.set(selfWorld.x - 120, selfWorld.y + 240, selfWorld.z + 60);
    this.sun.target.position.copy(selfWorld);
  }

  resize() {
    const w = this.canvas.clientWidth || this.canvas.width || 960;
    const h = this.canvas.clientHeight || this.canvas.height || 540;
    // Render-Auflösung deckeln (Downscale, per CSS wieder hochskaliert): begrenzt
    // die Füllrate im maximierten Fenster und schützt schwache/Software-GPUs.
    const ratio = Math.min(1, 1366 / Math.max(1, w));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    try {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose?.();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
          else o.material.dispose?.();
        }
      });
      this.renderer.dispose();
    } catch { /* ignore */ }
  }
}

export default RaceScene;
