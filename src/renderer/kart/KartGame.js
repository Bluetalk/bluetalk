/**
 * BlueKart — Spiel-Controller (läuft im Spielfenster).
 *
 * Jedes Fenster simuliert sein eigenes Kart (und als Host die Bots) lokal und
 * sendet 20× pro Sekunde den Zustand. Fremde Karts werden aus den Snapshots
 * des Hosts mit kurzer Verzögerung interpoliert (flüssig statt ruckelnd).
 * Items (Bananen, Raketen) gehören dem Fenster, das sie erzeugt hat; Treffer
 * meldet das Opfer.
 *
 * Darstellung: Bloom-Nachbearbeitung, Spiegelungen, Bodenhaftung auf Hügeln
 * und überhöhten Kurven, Bremsspuren, Startampel. Qualität: high/medium/low.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildTrackData, getTrack, medalFor, medalLimits } from './tracks.js';
import {
  KART, createKartState, stepKart, collideKarts, applyBoost, applySpin, progressOf, wrapAngle, clamp,
} from './physics.js';
import { botInput, createBotBrain } from './ai.js';
import { buildWorld, QUALITY } from './world.js';
import { makeKartMesh, makeNameSprite, makeBananaMesh, makeRocketMesh, createParticles, ghostify } from './models.js';
import { colorOf } from './colors.js';

const SEND_INTERVAL = 50;
const HUD_INTERVAL = 100;
const BOARD_INTERVAL = 250;
const INTERP_DELAY = 110; // ms Darstellungsverzögerung für fremde Karts
const SPEED_UNIT = 3.8; // m/s → angezeigte „km/h“
const ITEMS = ['turbo', 'banana', 'rocket', 'shield'];
const SKID_MAX = 1400;

const r2 = (v) => Math.round(v * 100) / 100;

export class KartGame {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.minimap = opts.minimap || null;
    this.onHud = opts.onHud || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.audio = opts.audio || null;
    this.selfId = opts.selfId;
    this.isHost = Boolean(opts.isHost);
    this.quality = QUALITY[opts.quality] ? opts.quality : 'high';
    // Zeitfahren (Trackmania-Stil): keine Items, keine Kollisionen, Geisterautos, Bestzeit-Geist
    this.trial = opts.mode === 'trial';
    this.itemsEnabled = opts.itemsEnabled !== false && !this.trial;
    this.laps = opts.laps || 3;
    this.trackDef = getTrack(opts.trackId);
    this.track = buildTrackData(this.trackDef);
    this.gripMul = this.track.theme.grip || 1;
    this.players = [];
    this.karts = new Map();
    this.hazards = []; // eigene Gefahrenobjekte
    this.remoteHazards = new Map();
    this.hazardMeshes = new Map();
    this.consumed = new Map();
    this.hazardSeq = 0;
    this.keys = new Set();
    this.race = { state: 'idle', raceId: '', goAt: 0, start: 0 };
    this.disposed = false;
    this.lastFrame = performance.now();
    this.time = 0;
    this.sendClock = 0;
    this.hudClock = 0;
    this.boardClock = 0;
    this.lapStart = 0;
    this.bestLap = 0;
    this.lastLapTime = 0;
    this.banner = '';
    this.bannerT = 0;
    this.shake = 0;
    this.camHeading = 0;
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this.lastCountdownShown = 5;
    this.board = [];
    this.lastRank = 0;
    // Raketenstart
    this.throttleSince = 0;
    this.launchDone = false;
    // Zeitfahren
    this.runStart = 0;
    this.cpM = 5; // Checkpoints je Runde (der letzte ist die Ziellinie)
    this.cpSeen = 0;
    this.splits = [];
    this.splitPopup = null;
    this.lastCpIdx = null;
    this.ghostRec = [];
    this.ghostClock = 0;
    this.ghostMesh = null;
    this.pb = this.trial ? this.loadPB() : null;

    this.initRenderer();
    this.world = buildWorld(this.scene, this.renderer, this.track, { quality: this.quality });
    this.initComposer();
    if (this.trial) this.createGhost();
    this.particles = createParticles(this.scene, 1100);
    this.initSkids();
    this.buildMinimapBase();
    this.bindInput();
    this.setPlayers(opts.players || []);
    this.resize();
    this.world.setStartLights('off');
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // --- Aufbau ----------------------------------------------------------------

  initRenderer() {
    const q = QUALITY[this.quality];
    const renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
    renderer.shadowMap.enabled = q.shadows > 0;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = this.track.theme.night ? 1.2 : 1.0;
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(66, 16 / 9, 0.3, 3600);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement || this.canvas);
  }

  initComposer() {
    const q = QUALITY[this.quality];
    this.composer = null;
    if (!q.bloom) return;
    try {
      const composer = new EffectComposer(this.renderer);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), this.world.bloomStrength, 0.55, this.world.bloomThreshold ?? 1);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      this.composer = composer;
      this.bloom = bloom;
    } catch (err) {
      console.warn('[BlueKart] Bloom nicht verfügbar:', err);
      this.composer = null;
    }
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const w = Math.max(320, host.clientWidth || 640);
    const h = Math.max(200, host.clientHeight || 360);
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  initSkids() {
    const geo = new THREE.PlaneGeometry(0.34, 0.9);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a, transparent: true, opacity: 0.42, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    });
    const skids = new THREE.InstancedMesh(geo, mat, SKID_MAX);
    skids.frustumCulled = false;
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < SKID_MAX; i += 1) skids.setMatrixAt(i, hidden);
    skids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(skids);
    this.skids = skids;
    this.skidCursor = 0;
    this.skidTmp = { m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(1, 1, 1), e: new THREE.Euler() };
  }

  addSkid(x, y, z, heading) {
    const t = this.skidTmp;
    t.e.set(0, heading, 0);
    t.q.setFromEuler(t.e);
    t.p.set(x, y + 0.04, z);
    t.m.compose(t.p, t.q, t.s);
    this.skids.setMatrixAt(this.skidCursor, t.m);
    this.skidCursor = (this.skidCursor + 1) % SKID_MAX;
    this.skids.instanceMatrix.needsUpdate = true;
  }

  buildMinimapBase() {
    if (!this.minimap) return;
    const size = this.minimap.width;
    const t = this.track;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (let i = 0; i < t.N; i += 1) {
      minX = Math.min(minX, t.px[i]); maxX = Math.max(maxX, t.px[i]);
      minZ = Math.min(minZ, t.pz[i]); maxZ = Math.max(maxZ, t.pz[i]);
    }
    const pad = 14;
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    const offX = (size - (maxX - minX) * scale) / 2;
    const offZ = (size - (maxZ - minZ) * scale) / 2;
    this.mm = {
      scale,
      toX: (x) => offX + (x - minX) * scale,
      toY: (z) => offZ + (z - minZ) * scale,
    };
    const base = document.createElement('canvas');
    base.width = size;
    base.height = size;
    const ctx = base.getContext('2d');
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const path = () => {
      ctx.beginPath();
      for (let i = 0; i <= t.N; i += 3) {
        const k = i % t.N;
        const x = this.mm.toX(t.px[k]);
        const y = this.mm.toY(t.pz[k]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = Math.max(8, t.width * scale * 1.25 + 4);
    path();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(226,232,240,0.92)';
    ctx.lineWidth = Math.max(5, t.width * scale * 1.25);
    path();
    ctx.stroke();
    // Boost-Felder
    ctx.fillStyle = '#22d3ee';
    for (const pad of this.world.boostPads) {
      ctx.beginPath();
      ctx.arc(this.mm.toX(pad.x), this.mm.toY(pad.z), 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // Start/Ziel als Querstrich
    const i0 = 0;
    const sx = this.mm.toX(t.px[i0]);
    const sy = this.mm.toY(t.pz[i0]);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(sx - t.nx[i0] * 7, sy - t.nz[i0] * 7);
    ctx.lineTo(sx + t.nx[i0] * 7, sy + t.nz[i0] * 7);
    ctx.stroke();
    this.mmBase = base;
  }

  bindInput() {
    this.onKeyDown = (e) => {
      if (e.repeat && ['KeyE', 'Enter', 'ControlLeft', 'KeyF', 'KeyR', 'Backspace'].includes(e.code)) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      this.audio?.resume();
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
      if (['KeyE', 'ControlLeft', 'KeyF'].includes(e.code) || (e.code === 'Enter' && !this.trial)) this.wantItem = true;
      if (e.code === 'Enter' && this.trial) this.wantRestart = true;
      if (e.code === 'KeyR' || (this.trial && e.code === 'Backspace')) this.wantReset = true;
    };
    this.onKeyUp = (e) => { this.keys.delete(e.code); };
    this.onBlur = () => { this.keys.clear(); };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  // --- Spieler & Rennen ------------------------------------------------------------

  setPlayers(players) {
    this.players = players.map((p, i) => ({ ...p, slot: i }));
    const ids = new Set(this.players.map((p) => p.id));
    for (const [id, entity] of this.karts) {
      if (!ids.has(id)) this.removeEntity(id, entity);
    }
    for (const p of this.players) {
      if (!this.karts.has(p.id)) this.addEntity(p);
      else {
        const e = this.karts.get(p.id);
        e.slot = p.slot;
        e.name = p.name;
      }
    }
  }

  addEntity(player) {
    const isLocal = player.id === this.selfId;
    const sim = isLocal || (this.isHost && player.bot);
    const mesh = makeKartMesh(player.color);
    if (this.trial && !isLocal) ghostify(mesh, 0.4);
    this.scene.add(mesh);
    let label = null;
    if (!isLocal) {
      label = makeNameSprite(player.bot ? `🤖 ${player.name}` : player.name, colorOf(player.color).hex);
      mesh.add(label);
    }
    const g = this.track.gridSlot(player.slot);
    const entity = {
      id: player.id,
      name: player.name,
      color: player.color,
      bot: Boolean(player.bot),
      slot: player.slot,
      isLocal,
      sim,
      mesh,
      label,
      state: createKartState(this.track, player.slot),
      brain: createBotBrain(player.slot),
      net: null,
      buf: [],
      vis: { x: g.x, z: g.z, y: this.track.surfaceY(g.index, 0), heading: g.heading, speed: 0, spin: 0, boost: false, drift: 0, hint: g.index, pitch: 0, roll: 0 },
      wheelSpin: 0,
      finished: false,
      finishTime: 0,
      progress: 0,
      reportedFinish: false,
      lastSkid: 0,
      launchPlan: Math.random(),
    };
    this.karts.set(player.id, entity);
    return entity;
  }

  removeEntity(id, entity) {
    this.scene.remove(entity.mesh);
    this.karts.delete(id);
  }

  /** Rennen vorbereiten: Aufstellung, Countdown bis `goAt` (lokale Zeit in ms). */
  startRace(raceId, goAt) {
    if (this.race.raceId === raceId && this.race.state !== 'idle') {
      this.race.goAt = goAt;
      return;
    }
    this.race = { state: 'countdown', raceId, goAt, start: goAt };
    this.hazards = [];
    this.remoteHazards.clear();
    this.consumed.clear();
    for (const id of [...this.hazardMeshes.keys()]) this.dropHazardMesh(id);
    for (const e of this.karts.values()) {
      e.state = createKartState(this.track, e.slot);
      e.finished = false;
      e.finishTime = 0;
      e.reportedFinish = false;
      e.net = null;
      e.buf = [];
      e.progress = 0;
      const g = this.track.gridSlot(e.slot);
      e.vis.x = g.x; e.vis.z = g.z; e.vis.heading = g.heading; e.vis.speed = 0; e.vis.hint = g.index;
    }
    for (const box of this.world.itemBoxes) { box.respawn = 0; box.mesh.visible = true; }
    this.runStart = goAt;
    this.cpSeen = 0;
    this.splits = [];
    this.ghostRec = [];
    this.ghostClock = 0;
    this.splitPopup = null;
    this.lastCpIdx = this.karts.get(this.selfId)?.state.idx ?? null;
    this.bestLap = 0;
    this.lastLapTime = 0;
    this.lastCountdownShown = 5;
    this.throttleSince = 0;
    this.launchDone = false;
    this.banner = '';
    this.camHeading = this.karts.get(this.selfId)?.state.heading || 0;
    const me = this.karts.get(this.selfId);
    if (me) {
      const f = new THREE.Vector3(Math.sin(me.state.heading), 0, Math.cos(me.state.heading));
      const y = this.track.surfaceY(me.state.idx, 0);
      this.camPos.set(me.state.x - f.x * 9, y + 4, me.state.z - f.z * 9);
      this.camLook.set(me.state.x, y + 1.2, me.state.z);
    }
    this.world.setStartLights(0);
  }

  endRace() {
    if (this.race.state !== 'idle') this.race.state = 'ended';
  }

  // --- Netzwerk ---------------------------------------------------------------------

  applyNet(net) {
    if (!net) return;
    const now = performance.now();
    if (Array.isArray(net.x)) {
      for (const hid of net.x) this.consumed.set(hid, now + 6000);
    }
    const remote = new Map();
    const cars = net.cars || {};
    for (const [id, entry] of Object.entries(cars)) {
      const e = this.karts.get(id);
      if (!e || e.sim) continue;
      const c = entry?.c;
      if (c) {
        const last = e.buf[e.buf.length - 1];
        if (!last || last.x !== c.x || last.z !== c.z || last.a !== c.a) {
          e.buf.push({ ...c, t: now });
          if (e.buf.length > 12) e.buf.shift();
        }
        e.net = { ...c, t: now };
      }
      if (Array.isArray(entry?.h)) {
        for (const h of entry.h) remote.set(h.i, { id: h.i, k: h.k === 'r' ? 'rocket' : 'banana', x: h.x, z: h.z, a: h.a || 0, owner: id });
      }
    }
    this.remoteHazards = remote;
  }

  compactState(e) {
    const s = e.state;
    return {
      x: r2(s.x), z: r2(s.z), a: r2(s.heading), v: r2(s.speed),
      l: s.lap, p: r2(progressOf(s, this.track)),
      sp: s.spinT > 0 ? 1 : 0, b: s.boostT > 0 ? 1 : 0, d: s.drift.active ? s.drift.level + 1 : 0,
      s: s.shieldT > 0 ? 1 : 0, f: e.finished ? Math.round(e.finishTime) : 0,
      st: r2(s.steer),
    };
  }

  hazardsOf(ownerId) {
    return this.hazards
      .filter((h) => h.owner === ownerId)
      .map((h) => ({ i: h.id, k: h.k === 'rocket' ? 'r' : 'b', x: r2(h.x), z: r2(h.z), a: r2(h.heading || 0) }));
  }

  sendNet() {
    const me = this.karts.get(this.selfId);
    if (!me) return;
    const payload = { c: this.compactState(me), h: this.hazardsOf(me.id) };
    if (this.isHost) {
      payload.bots = [];
      for (const e of this.karts.values()) {
        if (e.sim && e.bot) payload.bots.push({ id: e.id, c: this.compactState(e), h: this.hazardsOf(e.id) });
      }
    }
    this.onEvent({ type: 'send', payload });
  }

  // --- Items ---------------------------------------------------------------------------

  rankOf(id) {
    const order = this.rankedIds();
    return Math.max(0, order.indexOf(id));
  }

  rankedIds() {
    const rows = [];
    for (const e of this.karts.values()) rows.push({ id: e.id, progress: e.progress, finished: e.finished, finishTime: e.finishTime });
    rows.sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    return rows.map((r) => r.id);
  }

  rollItem(e) {
    const total = this.karts.size;
    const rank = this.rankOf(e.id);
    const t = total > 1 ? rank / (total - 1) : 0.5; // 0 = Erster, 1 = Letzter
    const weights = {
      turbo: 26 + t * 24,
      banana: 36 - t * 30,
      rocket: 8 + t * 34,
      shield: 18 + t * 4,
    };
    let sum = 0;
    for (const k of ITEMS) sum += weights[k];
    let r = Math.random() * sum;
    for (const k of ITEMS) {
      r -= weights[k];
      if (r <= 0) return k;
    }
    return 'turbo';
  }

  useItem(e) {
    const s = e.state;
    if (!s.item || s.itemRoll > 0) return;
    const type = s.item;
    s.item = null;
    s.itemCooldown = 0.5;
    if (type === 'turbo') {
      applyBoost(s, 1.7, 1.1);
      if (e.isLocal) this.audio?.sfx('boost');
    } else if (type === 'shield') {
      s.shieldT = 4.5;
      if (e.isLocal) this.audio?.sfx('shield');
    } else if (type === 'banana') {
      const back = 3.6;
      this.hazards.push({
        id: `${e.id}:b${this.hazardSeq += 1}`, k: 'banana', owner: e.id,
        x: s.x - Math.sin(s.heading) * back, z: s.z - Math.cos(s.heading) * back, heading: Math.random() * 6, ttl: 45,
      });
      if (e.isLocal) this.audio?.sfx('banana');
    } else if (type === 'rocket') {
      const idxF = s.idx + 3;
      this.hazards.push({
        id: `${e.id}:r${this.hazardSeq += 1}`, k: 'rocket', owner: e.id,
        idxF, lat: s.lat, speed: Math.max(84, s.speed + 28), ttl: 8,
        x: s.x + Math.sin(s.heading) * 3, z: s.z + Math.cos(s.heading) * 3, heading: s.heading,
      });
      if (e.isLocal) this.audio?.sfx('rocket');
    }
  }

  kartPos(e) {
    return e.sim ? { x: e.state.x, z: e.state.z } : { x: e.vis.x, z: e.vis.z };
  }

  updateHazards(dt) {
    const t = this.track;
    const now = performance.now();
    for (const [hid, expiry] of this.consumed) if (expiry < now) this.consumed.delete(hid);
    const keep = [];
    for (const h of this.hazards) {
      h.ttl -= dt;
      if (h.ttl <= 0 || this.consumed.has(h.id)) { this.puff(h.x, this.groundY(h.x, h.z) + 0.8, h.z, 0xffffff, 6); continue; }
      if (h.k === 'rocket') {
        // folgt der Strecke und zieht leicht zum nächsten Gegner davor
        let targetLat = h.lat;
        let best = Infinity;
        for (const e of this.karts.values()) {
          if (e.id === h.owner) continue;
          const p = this.kartPos(e);
          const dx = p.x - h.x;
          const dz = p.z - h.z;
          const d = Math.hypot(dx, dz);
          if (d < 70 && d < best) {
            const fx = Math.sin(h.heading); const fz = Math.cos(h.heading);
            if (dx * fx + dz * fz > 0) {
              best = d;
              targetLat = t.nearest(p.x, p.z, Math.round(h.idxF) % t.N).d;
            }
          }
        }
        h.lat += clamp(targetLat - h.lat, -7 * dt, 7 * dt);
        h.idxF += (h.speed * dt) / t.step;
        const i0 = Math.floor(h.idxF);
        const f = h.idxF - i0;
        const a = t.pointAt(i0, h.lat);
        const b = t.pointAt(i0 + 1, h.lat);
        h.x = a.x + (b.x - a.x) * f;
        h.z = a.z + (b.z - a.z) * f;
        h.heading = Math.atan2(b.x - a.x, b.z - a.z);
        const gy = t.surfaceY(i0, h.lat);
        this.particles.emit(h.x - Math.sin(h.heading) * 1.4, gy + 0.9, h.z - Math.cos(h.heading) * 1.4, 0, 0.5, 0, 0.35, 0xffa040);
      }
      keep.push(h);
    }
    this.hazards = keep;
  }

  checkHazardHits(e) {
    if (e.finished || this.race.state !== 'racing') return;
    const s = e.state;
    const test = (h) => {
      if (h.owner === e.id || this.consumed.has(h.id)) return;
      const r = h.k === 'rocket' ? 2.5 : 1.9;
      if (Math.hypot(s.x - h.x, s.z - h.z) > r) return;
      if (applySpin(s, h.k)) {
        this.puff(s.x, this.groundY(s.x, s.z, s.idx) + 1, s.z, 0xffd54f, 22);
        if (e.isLocal) { this.audio?.sfx('hit'); this.shake = 1; }
        const own = this.hazards.find((x) => x.id === h.id);
        if (own) {
          this.hazards = this.hazards.filter((x) => x.id !== h.id);
        } else {
          this.consumed.set(h.id, performance.now() + 6000);
          this.onEvent({ type: 'hit', hid: h.id });
        }
      }
    };
    for (const h of this.hazards) test(h);
    for (const h of this.remoteHazards.values()) test(h);
  }

  syncHazardMeshes() {
    const seen = new Set();
    const handle = (h) => {
      if (this.consumed.has(h.id)) return;
      seen.add(h.id);
      let mesh = this.hazardMeshes.get(h.id);
      if (!mesh) {
        mesh = h.k === 'rocket' ? makeRocketMesh() : makeBananaMesh();
        this.scene.add(mesh);
        this.hazardMeshes.set(h.id, mesh);
      }
      mesh.position.set(h.x, this.groundY(h.x, h.z), h.z);
      mesh.rotation.y = h.k === 'rocket' ? (h.heading ?? h.a ?? 0) : this.time * 2 + (h.heading ?? h.a ?? 0);
    };
    for (const h of this.hazards) handle(h);
    for (const h of this.remoteHazards.values()) handle(h);
    for (const id of [...this.hazardMeshes.keys()]) if (!seen.has(id)) this.dropHazardMesh(id);
  }

  dropHazardMesh(id) {
    const mesh = this.hazardMeshes.get(id);
    if (mesh) this.scene.remove(mesh);
    this.hazardMeshes.delete(id);
  }

  groundY(x, z, hint = -1) {
    return this.track.groundAt(x, z, hint).y;
  }

  // --- Schleife ---------------------------------------------------------------------------------

  frame(now) {
    if (this.disposed) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.time += dt;
    this.update(dt);
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);
  }

  localInput() {
    const k = this.keys;
    const up = k.has('ArrowUp') || k.has('KeyW');
    const down = k.has('ArrowDown') || k.has('KeyS');
    const left = k.has('ArrowLeft') || k.has('KeyA');
    const right = k.has('ArrowRight') || k.has('KeyD');
    return {
      throttle: up ? 1 : 0,
      brake: down ? 1 : 0,
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      drift: k.has('Space') || k.has('ShiftLeft') || k.has('ShiftRight'),
    };
  }

  /** Raketenstart: Gas im richtigen Moment vor dem Start (ca. bei „1“). */
  evaluateLaunch(e, wall) {
    if (e.isLocal) {
      const held = this.localInput().throttle > 0;
      if (!held || !this.throttleSince) return;
      const lead = this.race.goAt - this.throttleSince; // wie lange vor dem Start gedrückt
      if (lead >= 350 && lead <= 1300) {
        applyBoost(e.state, 1.4, 1.1);
        this.setBanner('Raketenstart!', 1.4);
        this.audio?.sfx('boost');
        this.puff(e.state.x, this.groundY(e.state.x, e.state.z, e.state.idx) + 0.6, e.state.z, 0x7dd3fc, 14);
      } else if (lead > 2400) {
        e.state.spinT = 0.7;
        e.state.spinAngle = 0;
        this.setBanner('Fehlstart!', 1.2);
        this.audio?.sfx('scrape');
      }
      void wall;
    } else if (e.bot && e.launchPlan > 0.45) {
      applyBoost(e.state, 1.2, 1);
    }
  }

  update(dt) {
    const wall = Date.now();
    const race = this.race;

    if (race.state === 'countdown') {
      const remain = race.goAt - wall;
      const n = Math.ceil(remain / 1000);
      // Gas während des Countdowns merken (Raketenstart)
      const held = this.localInput().throttle > 0;
      if (held && !this.throttleSince) this.throttleSince = wall;
      if (!held) this.throttleSince = 0;
      if (remain <= 0) {
        race.state = 'racing';
        race.start = race.goAt;
        this.runStart = race.goAt;
        this.lapStart = wall;
        this.audio?.sfx('go');
        this.setBanner('LOS!', 1.1);
        this.world.setStartLights('go');
        this.goLightsOffAt = wall + 2500;
        for (const e of this.karts.values()) if (e.sim) this.evaluateLaunch(e, wall);
      } else if (n !== this.lastCountdownShown && n <= 3) {
        this.lastCountdownShown = n;
        this.audio?.sfx('count');
        this.world.setStartLights(4 - n);
      }
    }
    if (this.goLightsOffAt && wall > this.goLightsOffAt) {
      this.goLightsOffAt = 0;
      this.world.setStartLights('off');
    }
    const racing = race.state === 'racing';
    const frozen = !racing;
    const localHold = this.trial && wall < this.runStart;

    const me = this.karts.get(this.selfId);
    const sub = Math.max(1, Math.ceil(dt / (1 / 60)));
    const h = dt / sub;

    // Fortschritte vorab (für Rang/Items)
    for (const e of this.karts.values()) {
      if (e.sim) e.progress = progressOf(e.state, this.track);
      else if (e.net) e.progress = e.net.p || 0;
    }
    const leader = Math.max(0, ...[...this.karts.values()].map((e) => e.progress));

    for (const e of this.karts.values()) {
      if (!e.sim) continue;
      const s = e.state;
      let input;
      const auto = e.bot || (e.isLocal && e.finished);
      if (auto) {
        const ctx = this.aiContext(e, leader);
        input = botInput(s, e.brain, this.track, dt, ctx);
        if (input.useItem && s.item && s.itemRoll <= 0) this.useItem(e);
      } else {
        input = this.localInput();
      }
      e.lastInput = input;
      const ev = { lapCrossed: 0, driftBoost: 0, scraped: false };
      for (let i = 0; i < sub; i += 1) {
        const step = stepKart(s, input, h, this.track, { gripMul: this.gripMul, frozen: frozen || (e.isLocal && localHold) });
        if (step.lapCrossed) ev.lapCrossed = step.lapCrossed;
        if (step.driftBoost) ev.driftBoost = step.driftBoost;
        if (step.scraped) ev.scraped = true;
      }
      if (racing && !this.trial) {
        const others = [];
        for (const o of this.karts.values()) {
          if (o.id === e.id) continue;
          others.push(o.sim ? { x: o.state.x, z: o.state.z, vx: o.state.vx, vz: o.state.vz } : { x: o.vis.x, z: o.vis.z, vx: 0, vz: 0 });
        }
        const bumped = collideKarts(s, others);
        if (bumped && e.isLocal) { if (Math.random() < 0.15) this.audio?.sfx('scrape'); this.shake = Math.max(this.shake, 0.25); }
        this.updateSlipstream(e, dt);
      }
      if (ev.scraped && e.isLocal) {
        if (Math.random() < 0.2) this.audio?.sfx('scrape');
        this.sparks(s, 0xffe082, 3);
        this.shake = Math.max(this.shake, 0.2);
      }
      if (ev.driftBoost) {
        if (e.isLocal) { this.audio?.sfx('boost'); this.shake = Math.max(this.shake, 0.15); }
        this.puff(s.x, this.groundY(s.x, s.z, s.idx) + 1, s.z, ev.driftBoost >= 3 ? 0xd8b4fe : ev.driftBoost === 2 ? 0xfdba74 : 0x7dd3fc, 12);
      }

      // Item-Roulette & Item-Nutzung (lokal)
      if (s.itemRoll > 0) {
        s.itemRoll -= dt;
        if (s.itemRoll <= 0) { s.itemRoll = 0; s.item = s.pendingItem || 'turbo'; s.pendingItem = null; }
      }
      s.itemCooldown = Math.max(0, s.itemCooldown - dt);
      if (e.isLocal && this.wantItem) {
        this.wantItem = false;
        if (racing && !e.finished) this.useItem(e);
      }
      if (e.isLocal && this.wantReset) {
        this.wantReset = false;
        if (racing && !e.finished) this.resetToTrack(e);
      }
      if (e.isLocal && this.wantRestart) {
        this.wantRestart = false;
        if (racing && !e.finished) this.restartRun(e, wall);
      }

      // Rundenlogik
      if (racing && ev.lapCrossed === 1 && !e.finished) {
        if (s.lap > this.laps) {
          e.finished = true;
          e.finishTime = wall - (e.isLocal && this.trial ? this.runStart : race.start);
          s.finished = true;
          if (e.isLocal) this.completeLap(e, wall);
          if (!e.reportedFinish) {
            e.reportedFinish = true;
            this.onEvent({
              type: 'finish', id: e.id, timeMs: Math.round(e.finishTime), bestLapMs: e.isLocal ? Math.round(this.bestLap || 0) : 0,
            });
          }
          if (e.isLocal) {
            this.audio?.sfx('finish');
            this.setBanner('ZIEL!', 3);
            this.confetti(s);
          }
        } else if (s.lap >= 2 && e.isLocal) {
          this.completeLap(e, wall);
          if (s.lap === this.laps) this.audio?.sfx('finalLap'); else this.audio?.sfx('lap');
          if (!(this.trial && this.bannerT > 0)) this.setBanner(s.lap === this.laps ? 'Letzte Runde!' : `Runde ${s.lap}`, 1.6);
        } else if (s.lap === 1 && e.isLocal) {
          this.lapStart = wall;
          this.cpSeen = 0;
          this.splits = [];
          this.ghostRec = [];
          this.ghostClock = 0;
        }
      }
      if (e.isLocal && this.trial && racing && !e.finished && s.lap >= 1 && wall >= this.runStart) {
        this.updateCheckpoints(e, wall);
        this.recordGhost(e, dt);
      }

      // Boost-Felder & Item-Boxen
      if (racing) {
        for (const pad of this.world.boostPads) {
          const d = Math.min(Math.abs(s.idx - pad.idx), this.track.N - Math.abs(s.idx - pad.idx));
          if (d <= 3 && Math.abs(s.lat) < 4.2 && s.boostT < 1.1) {
            applyBoost(s, 1.2, 1);
            if (e.isLocal) { this.audio?.sfx('boost'); this.shake = Math.max(this.shake, 0.12); }
          }
        }
        if (this.itemsEnabled && !e.finished) {
          for (const box of this.world.itemBoxes) {
            if (!box.mesh.visible) continue;
            if (Math.hypot(s.x - box.x, s.z - box.z) < 3.1) {
              box.mesh.visible = false;
              box.respawn = 4.5;
              this.puff(box.x, box.baseY, box.z, 0x7e57c2, 16);
              if (!s.item && s.itemRoll <= 0) {
                s.itemRoll = 1.1;
                s.pendingItem = this.rollItem(e);
                if (e.isLocal) this.audio?.sfx('item');
              }
            }
          }
        }
        this.checkHazardHits(e);
      }
    }

    this.updateHazards(dt);
    this.syncHazardMeshes();
    this.updateRemote();
    this.updateGhost(wall);
    if (this.splitPopup) { this.splitPopup.t -= dt; if (this.splitPopup.t <= 0) this.splitPopup = null; }
    this.updateMeshes(dt);
    this.updateEffects(dt);
    this.updateCamera(dt, me);
    this.world.update(dt, this.time, me ? { x: me.vis.x, y: me.vis.y, z: me.vis.z } : null);
    this.particles.update(dt);
    if (this.bannerT > 0) this.bannerT -= dt;

    // Ton
    if (me && this.audio) {
      const st = me.state;
      const ratio = Math.abs(me.sim ? st.speed : me.vis.speed) / KART.maxSpeed;
      this.audio.setEngine(ratio, st.boostT > 0, racing && !me.finished, me.lastInput?.throttle || 0);
      this.audio.setTire?.(st.drift.active ? 0.6 + st.drift.level * 0.12 : (me.lastInput?.brake && Math.abs(st.speed) > 15 ? 0.45 : 0));
      this.audio.setWind?.(clamp(ratio - 0.35, 0, 1));
    }

    // Netz & HUD
    this.sendClock += dt * 1000;
    if (this.sendClock >= SEND_INTERVAL && race.state !== 'idle' && race.state !== 'ended') {
      this.sendClock = 0;
      this.sendNet();
    }
    this.hudClock += dt * 1000;
    if (this.hudClock >= HUD_INTERVAL) {
      this.hudClock = 0;
      this.emitHud(wall);
    }
    this.drawMinimap();
  }

  /** Windschatten: dicht hinter einem anderen Kart bauen sich Boosts auf. */
  updateSlipstream(e, dt) {
    const s = e.state;
    if (Math.abs(s.speed) < 28 || s.boostT > 0) { s.slipT = Math.max(0, s.slipT - dt * 2); return; }
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    let drafting = false;
    for (const o of this.karts.values()) {
      if (o.id === e.id) continue;
      const p = this.kartPos(o);
      const dx = p.x - s.x;
      const dz = p.z - s.z;
      const ahead = dx * fx + dz * fz;
      if (ahead < 3 || ahead > 24) continue;
      const side = Math.abs(dx * fz - dz * fx);
      if (side < 2.4) { drafting = true; break; }
    }
    if (drafting) {
      s.slipT += dt;
      if (e.isLocal && Math.random() < 0.6) {
        const y = this.groundY(s.x, s.z, s.idx);
        this.particles.emit(s.x + fx * 6 + (Math.random() - 0.5) * 3, y + 0.8 + Math.random(), s.z + fz * 6 + (Math.random() - 0.5) * 3, -fx * 30, 0, -fz * 30, 0.25, 0xbfe7ff);
      }
      if (s.slipT > 1.3) {
        s.slipT = 0;
        applyBoost(s, 1.0, 1);
        if (e.isLocal) { this.audio?.sfx('slip'); this.setBanner('Windschatten!', 1); }
      }
    } else {
      s.slipT = Math.max(0, s.slipT - dt * 1.5);
    }
  }

  aiContext(e, leader) {
    const s = e.state;
    let chaserBehind = false;
    let targetAhead = false;
    let threat = false;
    for (const o of this.karts.values()) {
      if (o.id === e.id) continue;
      const diff = o.progress - e.progress;
      if (diff > 3 && diff < 30) targetAhead = true;
      if (diff < -3 && diff > -20) chaserBehind = true;
    }
    for (const hz of this.remoteHazards.values()) {
      if (hz.k === 'rocket' && Math.hypot(hz.x - s.x, hz.z - s.z) < 45) threat = true;
    }
    for (const hz of this.hazards) {
      if (hz.k === 'rocket' && hz.owner !== e.id && Math.hypot(hz.x - s.x, hz.z - s.z) < 45) threat = true;
    }
    let rubber = 1;
    if (e.bot) {
      const gap = leader - e.progress;
      if (gap > 60) rubber = 1.06;
      else if (gap > 25) rubber = 1.03;
      else if (gap < -30) rubber = 0.97;
    }
    return { gripMul: this.gripMul, rubber, chaserBehind, targetAhead, threat };
  }

  resetToTrack(e) {
    const s = e.state;
    // Zeitfahren: zurück zum letzten Checkpoint (die Zeit läuft weiter)
    const idx = this.trial && this.lastCpIdx != null ? this.lastCpIdx : s.idx;
    const p = this.track.pointAt(idx, 0);
    s.x = p.x; s.z = p.z; s.heading = p.heading;
    s.vx = 0; s.vz = 0; s.speed = 0; s.yaw = 0;
    s.spinT = 0; s.boostT = 0; s.drift.active = false;
    s.invulnT = 1.5;
    s.idx = this.track.wrap(idx);
    s.lastIdx = s.idx;
    this.puff(s.x, this.track.surfaceY(s.idx, 0) + 1, s.z, 0x80d8ff, 12);
  }

  // --- Zeitfahren: Bestzeit, Checkpoints, Geist ---------------------------------------

  pbKey() {
    return `bluekart.pb.${this.trackDef.id}`;
  }

  loadPB() {
    try {
      const raw = window.localStorage.getItem(this.pbKey());
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (d && d.lapMs > 0 && Array.isArray(d.splits)) return d;
    } catch {
      /* ignorieren */
    }
    return null;
  }

  savePB() {
    try {
      window.localStorage.setItem(this.pbKey(), JSON.stringify(this.pb));
    } catch {
      /* Speicher voll oder gesperrt */
    }
  }

  createGhost() {
    const mesh = makeKartMesh(7);
    ghostify(mesh, 0.34, 0xffffff);
    const label = makeNameSprite('Bestzeit', '#e2e8f0');
    mesh.add(label);
    mesh.visible = false;
    this.scene.add(mesh);
    this.ghostMesh = mesh;
  }

  formatMs(ms) {
    const total = Math.max(0, Math.floor(ms));
    const m = Math.floor(total / 60000);
    const sec = Math.floor((total % 60000) / 1000);
    const c = Math.floor((total % 1000) / 10);
    return `${m}:${String(sec).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  }

  /** Runde abgeschlossen: Rundenzeit, Bestzeit, Medaille, Geist speichern. */
  completeLap(e, wall) {
    const lapTime = wall - this.lapStart;
    if (lapTime < 2000) return;
    this.lastLapTime = lapTime;
    if (!this.bestLap || lapTime < this.bestLap) this.bestLap = lapTime;
    if (this.trial) {
      this.splits[this.cpM - 1] = lapTime;
      if (!this.pb || lapTime < this.pb.lapMs) {
        const flat = [];
        for (const p of this.ghostRec) flat.push(p[0], p[1], p[2]);
        const before = this.pb ? medalFor(this.trackDef, this.pb.lapMs) : null;
        this.pb = { lapMs: Math.round(lapTime), splits: this.splits.slice(), g: flat };
        this.savePB();
        const medal = medalFor(this.trackDef, lapTime);
        const names = { author: 'Autor', gold: 'Gold', silver: 'Silber', bronze: 'Bronze' };
        this.setBanner(medal && medal !== before ? `Neue Medaille: ${names[medal]}!` : `Neue Bestzeit ${this.formatMs(lapTime)}`, 2.6);
        this.audio?.sfx('record');
      }
    }
    this.lapStart = wall;
    this.cpSeen = 0;
    this.splits = [];
    this.ghostRec = [];
    this.ghostClock = 0;
  }

  updateCheckpoints(e, wall) {
    const s = e.state;
    const N = this.track.N;
    const M = this.cpM;
    const j = Math.floor((s.idx / N) * M);
    if (j === this.cpSeen + 1 && j <= M - 1) {
      const t = wall - this.lapStart;
      this.splits[j - 1] = t;
      const ref = this.pb?.splits?.[j - 1];
      this.splitPopup = { t: 2.4, time: t, delta: ref ? t - ref : null };
      this.cpSeen = j;
      this.lastCpIdx = Math.round((j * N) / M) % N;
      this.audio?.sfx('cp');
    }
  }

  recordGhost(e, dt) {
    const s = e.state;
    this.ghostClock += dt * 1000;
    while (this.ghostClock >= 50) {
      this.ghostClock -= 50;
      this.ghostRec.push([Math.round(s.x * 10) / 10, Math.round(s.z * 10) / 10, Math.round(s.heading * 100) / 100]);
    }
  }

  updateGhost(wall) {
    const mesh = this.ghostMesh;
    if (!mesh) return;
    const g = this.pb?.g;
    const me = this.karts.get(this.selfId);
    if (!g || g.length < 9 || !me || me.finished || this.race.state !== 'racing' || me.state.lap < 1 || wall < this.runStart) {
      mesh.visible = false;
      return;
    }
    const t = (wall - this.lapStart) / 50;
    const n = g.length / 3;
    const i = Math.floor(t);
    if (t < 0 || i >= n - 1) { mesh.visible = false; return; }
    const f = t - i;
    const x = g[i * 3] + (g[i * 3 + 3] - g[i * 3]) * f;
    const z = g[i * 3 + 1] + (g[i * 3 + 4] - g[i * 3 + 1]) * f;
    const h = g[i * 3 + 2] + wrapAngle(g[i * 3 + 5] - g[i * 3 + 2]) * f;
    const ground = this.track.groundAt(x, z, this.ghostHint ?? -1);
    this.ghostHint = ground.i;
    mesh.visible = true;
    mesh.position.set(x, ground.y, z);
    mesh.rotation.y = h;
    for (const w of mesh.userData.wheels) w.rotation.x += 0.4;
  }

  restartRun(e, wall) {
    e.state = createKartState(this.track, e.slot);
    e.finished = false;
    e.finishTime = 0;
    this.runStart = wall + 1600;
    this.lapStart = this.runStart;
    this.cpSeen = 0;
    this.splits = [];
    this.ghostRec = [];
    this.ghostClock = 0;
    this.splitPopup = null;
    this.lastCpIdx = e.state.idx;
    this.hazards = [];
    this.audio?.sfx('count');
    this.setBanner('Neustart', 1);
    this.puff(e.state.x, this.track.surfaceY(e.state.idx, 0) + 1, e.state.z, 0x80d8ff, 12);
  }

  // --- Darstellung ------------------------------------------------------------------------

  /** Fremde Karts: Snapshot-Interpolation mit kurzer Verzögerung. */
  updateRemote() {
    const now = performance.now();
    const renderT = now - INTERP_DELAY;
    for (const e of this.karts.values()) {
      if (e.sim || !e.net) continue;
      const buf = e.buf;
      let x; let z; let a; let v;
      if (buf.length >= 2 && buf[0].t <= renderT) {
        let k = buf.length - 2;
        while (k > 0 && buf[k].t > renderT) k -= 1;
        const s0 = buf[k];
        const s1 = buf[k + 1];
        if (renderT <= s1.t) {
          const f = (renderT - s0.t) / Math.max(1, s1.t - s0.t);
          x = s0.x + (s1.x - s0.x) * f;
          z = s0.z + (s1.z - s0.z) * f;
          a = s0.a + wrapAngle(s1.a - s0.a) * f;
          v = s0.v + (s1.v - s0.v) * f;
        } else {
          const ext = Math.min(0.25, (renderT - s1.t) / 1000);
          x = s1.x + Math.sin(s1.a) * s1.v * ext;
          z = s1.z + Math.cos(s1.a) * s1.v * ext;
          a = s1.a;
          v = s1.v;
        }
      } else {
        const n = e.net;
        x = n.x; z = n.z; a = n.a; v = n.v;
      }
      e.vis.x = x;
      e.vis.z = z;
      e.vis.heading = a;
      e.vis.speed = v;
      const n = e.net;
      e.vis.boost = Boolean(n.b);
      e.vis.drift = n.d || 0;
      e.vis.shield = Boolean(n.s);
      e.vis.spinning = Boolean(n.sp);
      e.vis.steer = n.st || 0;
      if (n.f && !e.finished) { e.finished = true; e.finishTime = n.f; }
      e.progress = n.p || 0;
    }
  }

  updateMeshes(dt) {
    for (const e of this.karts.values()) {
      const s = e.state;
      const mesh = e.mesh;
      const ud = mesh.userData;
      if (e.sim) {
        e.vis.x = s.x; e.vis.z = s.z; e.vis.heading = s.heading; e.vis.speed = s.speed;
        e.vis.boost = s.boostT > 0;
        e.vis.drift = s.drift.active ? s.drift.level + 1 : 0;
        e.vis.shield = s.shieldT > 0;
        e.vis.spinning = s.spinT > 0;
        e.vis.steer = s.steer;
        ud.model.rotation.y = s.spinT > 0 ? s.spinAngle : -s.drift.dir * (s.drift.active ? 0.3 : 0);
        ud.model.rotation.z = -s.yaw * 0.07;
        // Drift-Hüpfer
        const hop = s.hopT > 0 ? Math.sin((1 - s.hopT / 0.26) * Math.PI) * 0.35 : 0;
        ud.model.position.y = hop;
      } else {
        e.vis.spin = (e.vis.spinning ? e.vis.spin + dt * 13 : 0);
        ud.model.rotation.y = e.vis.spinning ? e.vis.spin : (e.vis.drift ? -Math.sign(e.vis.steer || 0) * 0.3 : 0);
        ud.model.rotation.z = 0;
        ud.model.position.y = 0;
      }
      for (const p of ud.frontPivots) p.rotation.y = -(e.vis.steer || 0) * 0.42;

      // Bodenhaftung: Höhe, Steigung und Querneigung der Fahrbahn
      const ground = this.track.groundAt(e.vis.x, e.vis.z, e.vis.hint);
      e.vis.hint = ground.i;
      const yTarget = ground.y;
      e.vis.y = e.vis.y == null ? yTarget : e.vis.y + (yTarget - e.vis.y) * Math.min(1, 18 * dt);
      const rel = e.vis.heading - ground.heading;
      const pitchTarget = -Math.atan(ground.slope * Math.cos(rel));
      // lokales +x zeigt nach links: rechts höher (bank > 0) → nach rechts kippen = negativer Winkel
      const rollTarget = -Math.atan(ground.bank * Math.cos(rel));
      e.vis.pitch += (pitchTarget - e.vis.pitch) * Math.min(1, 10 * dt);
      e.vis.roll += (rollTarget - e.vis.roll) * Math.min(1, 10 * dt);

      mesh.position.set(e.vis.x, e.vis.y, e.vis.z);
      mesh.rotation.set(e.vis.pitch, e.vis.heading, e.vis.roll, 'YXZ');
      e.wheelSpin += (e.vis.speed * dt) / 0.45;
      for (const w of ud.wheels) w.rotation.x = e.wheelSpin;
      const boosting = Boolean(e.vis.boost);
      for (const f of ud.flames) {
        f.visible = boosting;
        if (boosting) f.scale.set(1, 0.7 + Math.random() * 0.8, 1);
      }
      ud.shield.visible = Boolean(e.vis.shield);
      if (ud.shield.visible) ud.shield.rotation.y += dt * 2;
      // Bremslichter
      if (ud.tailMat) {
        const braking = e.sim ? (e.lastInput?.brake > 0) : false;
        ud.tailMat.emissiveIntensity = braking ? 4 : 0.9;
      }
      // Kurz nach einem Treffer blinkt das Kart (unverwundbar)
      const blink = e.sim && s.invulnT > 0 && s.spinT <= 0 && s.shieldT <= 0 && Math.floor(this.time * 16) % 2 === 0;
      mesh.visible = !blink;

      // Bremsspuren (Drift oder Vollbremsung)
      const skidding = (e.vis.drift > 0 && Math.abs(e.vis.speed) > 12) || (e.sim && e.lastInput?.brake > 0 && e.state.speed > 18);
      if (skidding && this.time - e.lastSkid > 0.035) {
        e.lastSkid = this.time;
        const h = e.vis.heading;
        const fx = Math.sin(h); const fz = Math.cos(h);
        const rx = -Math.cos(h); const rz = Math.sin(h);
        for (const side of [-1, 1]) {
          const x = e.vis.x - fx * 1.0 + rx * side * 1.05;
          const z = e.vis.z - fz * 1.0 + rz * side * 1.05;
          this.addSkid(x, this.track.groundAt(x, z, e.vis.hint).y, z, h);
        }
      }
    }
  }

  sparks(s, hexColor, n) {
    const f = [Math.sin(s.heading), Math.cos(s.heading)];
    const y = this.groundY(s.x, s.z, s.idx);
    for (let i = 0; i < n; i += 1) {
      this.particles.emit(s.x - f[0] * 1.2, y + 0.5, s.z - f[1] * 1.2, (Math.random() - 0.5) * 6, 2 + Math.random() * 3, (Math.random() - 0.5) * 6, 0.35, hexColor, 9);
    }
  }

  puff(x, y, z, hexColor, n) {
    for (let i = 0; i < n; i += 1) {
      this.particles.emit(x, y, z, (Math.random() - 0.5) * 8, Math.random() * 6, (Math.random() - 0.5) * 8, 0.6, hexColor, 6);
    }
  }

  confetti(s) {
    const y = this.groundY(s.x, s.z, s.idx);
    const colors = [0xef4444, 0xfacc15, 0x22c55e, 0x3b82f6, 0xa855f7, 0xffffff];
    for (let i = 0; i < 90; i += 1) {
      this.particles.emit(
        s.x + (Math.random() - 0.5) * 4, y + 2, s.z + (Math.random() - 0.5) * 4,
        (Math.random() - 0.5) * 14, 6 + Math.random() * 10, (Math.random() - 0.5) * 14, 1.6, colors[i % colors.length], 9,
      );
    }
  }

  updateEffects(dt) {
    const levelColors = [0xffffff, 0xffffff, 0x4fc3f7, 0xffb74d, 0xce93d8];
    for (const e of this.karts.values()) {
      const h = e.vis.heading;
      const fx = Math.sin(h); const fz = Math.cos(h);
      const rx = -Math.cos(h); const rz = Math.sin(h);
      const y = e.vis.y || 0;
      if (e.vis.drift > 0 && Math.abs(e.vis.speed) > 8) {
        const color = levelColors[Math.min(4, e.vis.drift + 1)] || 0xffffff;
        for (const side of [-1, 1]) {
          this.particles.emit(
            e.vis.x - fx * 1.4 + rx * side * 0.95, y + 0.35, e.vis.z - fz * 1.4 + rz * side * 0.95,
            (Math.random() - 0.5) * 3 - fx * 2, 1.5 + Math.random() * 2.5, (Math.random() - 0.5) * 3 - fz * 2, 0.32, color, 8,
          );
        }
      }
      if (e.vis.boost) {
        for (const side of [-1, 1]) {
          this.particles.emit(
            e.vis.x - fx * 2.0 + rx * side * 0.42, y + 0.7, e.vis.z - fz * 2.0 + rz * side * 0.42,
            -fx * 6 + (Math.random() - 0.5), 0.2, -fz * 6 + (Math.random() - 0.5), 0.3, 0xffa726,
          );
        }
      }
      if (e.sim && e.state.offroad && Math.abs(e.vis.speed) > 6) {
        this.particles.emit(
          e.vis.x - fx * 1.5 + (Math.random() - 0.5), y + 0.3, e.vis.z - fz * 1.5 + (Math.random() - 0.5),
          (Math.random() - 0.5) * 2, 1 + Math.random(), (Math.random() - 0.5) * 2, 0.5, this.track.theme.groundAlt, 2,
        );
      }
    }
    this.shake = Math.max(0, this.shake - dt * 2.4);
  }

  updateCamera(dt, me) {
    if (!me) return;
    const s = me.vis;
    const speed = Math.abs(s.speed);
    const ratio = clamp(speed / KART.maxSpeed, 0, 1.4);
    // Kamera schaut in Fahrtrichtung; beim Driften leicht in die Kurve
    const driftLook = me.sim ? me.state.drift.dir * (me.state.drift.active ? 0.22 : 0) : 0;
    const targetHeading = s.heading - driftLook;
    this.camHeading += wrapAngle(targetHeading - this.camHeading) * (1 - Math.exp(-5.5 * dt));
    const fx = Math.sin(this.camHeading);
    const fz = Math.cos(this.camHeading);
    const back = 6.4 + ratio * 3.6;
    const baseY = s.y || 0;
    const behindX = s.x - fx * back;
    const behindZ = s.z - fz * back;
    // Kamera nie unter den Boden hinter dem Kart
    const groundBehind = this.track.groundAt(behindX, behindZ, s.hint).y;
    const desired = new THREE.Vector3(behindX, Math.max(baseY, groundBehind) + 2.8 + ratio * 0.7, behindZ);
    this.camPos.lerp(desired, 1 - Math.exp(-9 * dt));
    const look = new THREE.Vector3(s.x + fx * 4.5, baseY + 1.3, s.z + fz * 4.5);
    this.camLook.lerp(look, 1 - Math.exp(-14 * dt));
    // leichtes Vibrieren bei hohem Tempo, kräftig nach Treffern
    const rumble = this.shake + (ratio > 0.9 ? (ratio - 0.9) * 0.5 : 0);
    this.camera.position.set(
      this.camPos.x + (Math.random() - 0.5) * rumble * 0.6,
      this.camPos.y + (Math.random() - 0.5) * rumble * 0.4,
      this.camPos.z + (Math.random() - 0.5) * rumble * 0.6,
    );
    this.camera.lookAt(this.camLook);
    // Neigung in Driftrichtung
    if (me.sim && me.state.drift.active) this.camera.rotateZ(me.state.drift.dir * 0.035);
    const boost = me.sim && me.state.boostT > 0 ? 12 : 0;
    const fov = 64 + Math.min(ratio, 1.2) * 24 + boost + (ratio > 0.85 ? (ratio - 0.85) * 18 : 0);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-6 * dt));
      this.camera.updateProjectionMatrix();
    }
  }

  setBanner(text, seconds) {
    this.banner = text;
    this.bannerT = seconds;
  }

  // --- HUD / Minimap -------------------------------------------------------------------------------

  emitHud(wall) {
    const me = this.karts.get(this.selfId);
    if (!me) return;
    const s = me.state;
    const race = this.race;
    const order = this.rankedIds();
    const rank = order.indexOf(me.id) + 1;
    let countdown = 0;
    const limits = medalLimits(this.trackDef);
    const pbMedal = this.pb ? medalFor(this.trackDef, this.pb.lapMs) : null;
    if (race.state === 'countdown') countdown = Math.max(0, Math.ceil((race.goAt - wall) / 1000));
    this.boardClock += HUD_INTERVAL;
    if (this.boardClock >= BOARD_INTERVAL) {
      this.boardClock = 0;
      this.board = order.slice(0, 8).map((id, i) => {
        const e = this.karts.get(id);
        return { id, name: e.name, color: e.color, rank: i + 1, you: id === this.selfId, finished: e.finished, bot: e.bot };
      });
    }
    this.onHud({
      ready: true,
      state: race.state,
      speed: Math.round(Math.abs(s.speed) * SPEED_UNIT),
      speedRatio: clamp(Math.abs(s.speed) / (KART.maxSpeed * 1.25), 0, 1),
      maxDisplay: Math.round(KART.maxSpeed * 1.25 * SPEED_UNIT),
      lap: clamp(s.lap, 1, this.laps),
      laps: this.laps,
      rank,
      total: this.karts.size,
      item: s.item,
      itemRoll: s.itemRoll > 0,
      countdown: countdown || (this.trial && race.state === 'racing' && wall < this.runStart ? Math.max(1, Math.ceil((this.runStart - wall) / 1000)) : 0),
      trial: this.trial,
      lapTime: this.trial && race.state === 'racing' && !me.finished ? Math.max(0, wall - this.lapStart) : (this.lastLapTime || 0),
      pbLap: this.pb ? this.pb.lapMs : 0,
      medal: pbMedal,
      medalLimits: this.trial ? limits : null,
      split: this.splitPopup ? { delta: this.splitPopup.delta, time: this.splitPopup.time } : null,
      banner: this.bannerT > 0 ? this.banner : '',
      time: race.state === 'racing' || race.state === 'ended' ? Math.max(0, (me.finished ? me.finishTime : wall - (this.trial ? this.runStart : race.start))) : 0,
      bestLap: this.bestLap,
      lastLap: this.lastLapTime,
      wrongWay: s.wrongWayT > 1.2,
      boost: s.boostT > 0,
      fast: clamp(Math.abs(s.speed) / KART.maxSpeed, 0, 1.3),
      drift: s.drift.active ? s.drift.level + 1 : 0,
      slip: clamp(s.slipT / 1.3, 0, 1),
      spinning: s.spinT > 0,
      finished: me.finished,
      finishTime: me.finishTime,
      board: this.board,
    });
  }

  drawMinimap() {
    if (!this.minimap || !this.mmBase) return;
    const ctx = this.minimap.getContext('2d');
    ctx.clearRect(0, 0, this.minimap.width, this.minimap.height);
    ctx.drawImage(this.mmBase, 0, 0);
    const meId = this.selfId;
    const draw = (e) => {
      const x = this.mm.toX(e.vis.x);
      const y = this.mm.toY(e.vis.z);
      const isMe = e.id === meId;
      ctx.save();
      ctx.translate(x, y);
      // Pfeil in Fahrtrichtung (Minimap: x nach rechts, z nach unten)
      ctx.rotate(Math.atan2(Math.cos(e.vis.heading), Math.sin(e.vis.heading)));
      ctx.beginPath();
      const r = isMe ? 7 : 5;
      ctx.moveTo(r, 0);
      ctx.lineTo(-r * 0.75, r * 0.7);
      ctx.lineTo(-r * 0.4, 0);
      ctx.lineTo(-r * 0.75, -r * 0.7);
      ctx.closePath();
      ctx.fillStyle = colorOf(e.color).hex;
      ctx.fill();
      ctx.lineWidth = isMe ? 2.2 : 1.2;
      ctx.strokeStyle = isMe ? '#ffffff' : 'rgba(0,0,0,0.7)';
      ctx.stroke();
      ctx.restore();
    };
    for (const e of this.karts.values()) if (e.id !== meId) draw(e);
    const me = this.karts.get(meId);
    if (me) draw(me);
  }

  // --- Ende ------------------------------------------------------------------------------------------

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.resizeObserver?.disconnect();
    this.particles?.dispose();
    this.world?.dispose();
    this.composer?.dispose?.();
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
