/**
 * BlueKart — Streckendaten.
 *
 * Jede Strecke ist eine geschlossene Mittellinie (Kontrollpunkte in Metern,
 * x/z-Ebene), die per zentripetalem Catmull-Rom-Spline geglättet und in
 * gleichmäßigen Schritten abgetastet wird. Alles Weitere (Fahrbahn, Physik,
 * KI, Minimap) leitet sich aus diesen Abtastpunkten ab.
 *
 * Reine Logik ohne three.js — dadurch auch außerhalb des Renderers prüfbar.
 */

export const SAMPLE_STEP = 2; // Meter zwischen zwei Abtastpunkten

export const THEMES = {
  meadow: {
    label: 'Wiese',
    skyTop: 0x3f8bd8, skyBottom: 0xcfe9ff, fog: 0xbfdcf5, fogNear: 180, fogFar: 760,
    ground: 0x58a74a, groundAlt: 0x4a9440, road: 0x45484f, sun: 0xfff1d0, sunIntensity: 2.4, ambient: 0.7,
    props: 'forest', curb: [0xe53935, 0xffffff], night: false,
  },
  coast: {
    label: 'Küste',
    skyTop: 0x2d9bd6, skyBottom: 0xfff0c8, fog: 0xe9f3f5, fogNear: 200, fogFar: 820,
    ground: 0xe6cf8f, groundAlt: 0xd9bf7a, road: 0x4c4f57, sun: 0xfff3d6, sunIntensity: 2.7, ambient: 0.75,
    props: 'palms', curb: [0x1e88e5, 0xffffff], night: false, sea: 0x1c8ec9,
  },
  volcano: {
    label: 'Vulkan',
    skyTop: 0x2a0f12, skyBottom: 0xff7a2f, fog: 0x5a2a1c, fogNear: 120, fogFar: 600,
    ground: 0x2b2522, groundAlt: 0x221d1b, road: 0x3a3a3f, sun: 0xffb27a, sunIntensity: 1.9, ambient: 0.55,
    props: 'rocks', curb: [0xff7043, 0x212121], night: false, lava: 0xff5a1f,
  },
  city: {
    label: 'Neon-Stadt',
    skyTop: 0x05061a, skyBottom: 0x3a1a5e, fog: 0x120b2a, fogNear: 90, fogFar: 560,
    ground: 0x15162b, groundAlt: 0x101126, road: 0x24262f, sun: 0x8fa8ff, sunIntensity: 0.9, ambient: 0.65,
    props: 'city', curb: [0xff2bd6, 0x00e5ff], night: true,
  },
  snow: {
    label: 'Eis',
    skyTop: 0x6fa8dc, skyBottom: 0xf2f8ff, fog: 0xe6f0fa, fogNear: 170, fogFar: 740,
    ground: 0xf4f8fc, groundAlt: 0xe3edf6, road: 0x5b6573, sun: 0xffffff, sunIntensity: 2.6, ambient: 0.85,
    props: 'pines', curb: [0x2196f3, 0xffffff], night: false, grip: 0.72,
  },
  desert: {
    label: 'Wüste',
    skyTop: 0xd98a3d, skyBottom: 0xffe2b0, fog: 0xf3d7a8, fogNear: 170, fogFar: 700,
    ground: 0xd8a35a, groundAlt: 0xc8924a, road: 0x5a4a40, sun: 0xffe3b0, sunIntensity: 2.7, ambient: 0.72,
    props: 'canyon', curb: [0xd84315, 0xfff3e0], night: false,
  },
};

/**
 * Kontrollpunkte [x, z]. `shoulder` = Breite des befahrbaren Seitenstreifens
 * (langsamer) bis zur unsichtbaren bzw. sichtbaren Bande.
 */
export const TRACKS = [
  {
    id: 'sonnen-kurs',
    hills: 7,
    par: 30.3,
    name: 'Sonnen-Kurs',
    blurb: 'Breiter Einstieg mit weichen Kurven und einer Schikane.',
    difficulty: 1,
    theme: 'meadow',
    width: 24,
    shoulder: 14,
    barrier: false,
    laps: 3,
    points: [
      [0, 0], [120, -25], [260, -30], [380, 0], [450, 70], [440, 160], [370, 215],
      [270, 200], [200, 150], [120, 140], [50, 190], [-30, 220], [-120, 190], [-150, 110], [-110, 40],
    ],
    boostPads: [0.2, 0.58, 0.83],
    itemBoxes: [0.1, 0.38, 0.66, 0.9],
  },
  {
    id: 'kuestenstrasse',
    hills: 9,
    par: 47.8,
    name: 'Küstenstraße',
    blurb: 'Lange Geraden am Strand, dann eine enge Kehre an den Klippen.',
    difficulty: 2,
    theme: 'coast',
    width: 22,
    shoulder: 12,
    barrier: false,
    laps: 3,
    points: [
      [0, 0], [170, 10], [340, -20], [500, 20], [600, 120], [570, 230], [450, 270],
      [360, 340], [380, 450], [300, 520], [170, 500], [120, 420], [170, 340], [140, 260],
      [30, 235], [-90, 270], [-180, 200], [-170, 90], [-90, 20],
    ],
    boostPads: [0.12, 0.45, 0.78],
    itemBoxes: [0.06, 0.3, 0.55, 0.8],
  },
  {
    id: 'vulkanpass',
    hills: 12,
    par: 45.7,
    name: 'Vulkanpass',
    blurb: 'Enge Serpentinen zwischen Lavaströmen. Wenig Platz, viel Risiko.',
    difficulty: 3,
    theme: 'volcano',
    width: 18,
    shoulder: 3,
    barrier: true,
    laps: 3,
    points: [
      [0, 0], [110, 0], [215, -25], [305, 30], [320, 130], [245, 190], [140, 165],
      [70, 215], [90, 305], [190, 350], [310, 335], [400, 395], [385, 495], [280, 540],
      [150, 515], [60, 455], [-40, 420], [-125, 345], [-135, 235], [-100, 130], [-55, 55],
    ],
    boostPads: [0.18, 0.5, 0.82],
    itemBoxes: [0.08, 0.34, 0.62, 0.88],
  },
  {
    id: 'neon-nacht',
    hills: 3,
    par: 38.6,
    name: 'Neon-Nacht',
    blurb: 'Rechte Winkel zwischen Hochhäusern, beleuchtet bis zum Horizont.',
    difficulty: 3,
    theme: 'city',
    width: 24,
    shoulder: 2,
    barrier: true,
    laps: 3,
    points: [
      [0, 0], [180, 0], [300, 0], [370, 55], [370, 155], [305, 210], [305, 305],
      [370, 360], [370, 445], [305, 505], [180, 505], [115, 450], [115, 345], [55, 290],
      [-70, 290], [-135, 235], [-135, 60], [-70, 0],
    ],
    boostPads: [0.15, 0.47, 0.75],
    itemBoxes: [0.07, 0.3, 0.6, 0.86],
  },
  {
    id: 'eisgipfel',
    hills: 15,
    par: 50.4,
    name: 'Eisgipfel',
    blurb: 'Schnelle, weite Bögen auf rutschigem Eis. Driften will gelernt sein.',
    difficulty: 2,
    theme: 'snow',
    width: 28,
    shoulder: 10,
    barrier: false,
    laps: 3,
    points: [
      [0, 0], [210, -45], [440, -35], [630, 45], [720, 190], [655, 350], [505, 405],
      [375, 350], [290, 245], [165, 255], [95, 360], [-25, 405], [-150, 350], [-205, 235],
      [-160, 105], [-85, 30],
    ],
    boostPads: [0.1, 0.4, 0.7],
    itemBoxes: [0.04, 0.27, 0.52, 0.78],
  },
  {
    id: 'wuesten-canyon',
    hills: 10,
    par: 47.7,
    name: 'Wüsten-Canyon',
    blurb: 'Verwinkelter Canyon mit vielen Wechselkurven. Die längste Strecke.',
    difficulty: 3,
    theme: 'desert',
    width: 22,
    shoulder: 6,
    barrier: false,
    laps: 3,
    points: [
      [0, 0], [120, 45], [225, 5], [330, -40], [430, 15], [470, 115], [410, 190],
      [455, 265], [535, 300], [565, 400], [485, 475], [360, 445], [280, 380], [180, 410],
      [130, 500], [20, 525], [-95, 470], [-125, 375], [-155, 270], [-155, 140], [-85, 45],
    ],
    boostPads: [0.14, 0.43, 0.72],
    itemBoxes: [0.06, 0.29, 0.52, 0.8],
  },
];

/** Medaillen-Zeiten (ms) für die schnellste Runde, abgeleitet von der Bot-Richtzeit. */
export function medalLimits(def) {
  const par = (def.par || 50) * 1000;
  return {
    author: Math.round(par * 0.96),
    gold: Math.round(par * 1.03),
    silver: Math.round(par * 1.12),
    bronze: Math.round(par * 1.28),
  };
}

export function medalFor(def, lapMs) {
  if (!lapMs) return null;
  const m = medalLimits(def);
  if (lapMs <= m.author) return 'author';
  if (lapMs <= m.gold) return 'gold';
  if (lapMs <= m.silver) return 'silver';
  if (lapMs <= m.bronze) return 'bronze';
  return null;
}

export function getTrack(id) {
  return TRACKS.find((track) => track.id === id) || TRACKS[0];
}

// ---------------------------------------------------------------------------
// Spline + Abtastung
// ---------------------------------------------------------------------------

/** Zentripetaler Catmull-Rom (Barry–Goldman) zwischen p1 und p2. */
function centripetal(p0, p1, p2, p3, u) {
  const knot = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-4;
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const mix = (a, b, ta, tb, tt) => {
    const w = (tt - ta) / (tb - ta);
    return [a[0] * (1 - w) + b[0] * w, a[1] * (1 - w) + b[1] * w];
  };
  const a1 = mix(p0, p1, t0, t1, t);
  const a2 = mix(p1, p2, t1, t2, t);
  const a3 = mix(p2, p3, t2, t3, t);
  const b1 = mix(a1, a2, t0, t2, t);
  const b2 = mix(a2, a3, t1, t3, t);
  return mix(b1, b2, t1, t2, t);
}

/**
 * Baut aus einer Streckendefinition die abgetastete Strecke.
 * Der Winkel eines Punktes `i` ist `atan2(tx, tz)` (Fahrtrichtung = (sin, cos)).
 */
export function buildTrackData(def) {
  const pts = def.points;
  const count = pts.length;
  const dense = [];
  for (let i = 0; i < count; i += 1) {
    const p0 = pts[(i - 1 + count) % count];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % count];
    const p3 = pts[(i + 2) % count];
    for (let s = 0; s < 48; s += 1) dense.push(centripetal(p0, p1, p2, p3, s / 48));
  }
  // Kumulative Länge der dichten Polylinie
  const cum = [0];
  for (let i = 1; i <= dense.length; i += 1) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1];
  const N = Math.max(64, Math.round(total / SAMPLE_STEP));
  const step = total / N;
  const px = new Float32Array(N);
  const pz = new Float32Array(N);
  let k = 0;
  for (let i = 0; i < N; i += 1) {
    const target = i * step;
    while (k < dense.length - 1 && cum[k + 1] < target) k += 1;
    const a = dense[k];
    const b = dense[(k + 1) % dense.length];
    const seg = cum[k + 1] - cum[k] || 1e-6;
    const w = (target - cum[k]) / seg;
    px[i] = a[0] + (b[0] - a[0]) * w;
    pz[i] = a[1] + (b[1] - a[1]) * w;
  }
  const tx = new Float32Array(N);
  const tz = new Float32Array(N);
  const nx = new Float32Array(N);
  const nz = new Float32Array(N);
  const heading = new Float32Array(N);
  const curvature = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    const a = (i - 2 + N) % N;
    const b = (i + 2) % N;
    let dx = px[b] - px[a];
    let dz = pz[b] - pz[a];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    tx[i] = dx;
    tz[i] = dz;
    // Normale zeigt nach links (von oben, x nach rechts, z nach unten gesehen: rechts)
    nx[i] = -dz;
    nz[i] = dx;
    heading[i] = Math.atan2(dx, dz);
  }
  for (let i = 0; i < N; i += 1) {
    const a = (i - 3 + N) % N;
    const b = (i + 3) % N;
    let d = heading[b] - heading[a];
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    curvature[i] = d / (step * 6); // rad pro Meter (vorzeichenbehaftet)
  }

  // Höhenprofil: periodische Wellen entlang der Bogenlänge (nahtlos über die
  // Ziellinie), im Startbereich flach auslaufend.
  const py = new Float32Array(N);
  const amp = Number(def.hills) || 0;
  let seed = 0;
  for (let c = 0; c < def.id.length; c += 1) seed = (seed * 31 + def.id.charCodeAt(c)) >>> 0;
  const ph = [0, 1, 2].map((k) => ((seed >>> (k * 7)) % 628) / 100);
  for (let i = 0; i < N; i += 1) {
    const u = (i / N) * Math.PI * 2;
    const wave = 0.55 * Math.sin(2 * u + ph[0]) + 0.3 * Math.sin(3 * u + ph[1]) + 0.15 * Math.sin(5 * u + ph[2]);
    const fromStart = Math.min(i, N - i) * step;
    const w = Math.min(1, Math.max(0, (fromStart - 25) / 90));
    const ease = w * w * (3 - 2 * w);
    py[i] = amp * wave * ease;
  }
  // Querneigung in Kurven (Tangens), geglättet
  const rawBank = new Float32Array(N);
  for (let i = 0; i < N; i += 1) rawBank[i] = Math.max(-0.17, Math.min(0.17, curvature[i] * 15));
  const bank = new Float32Array(N);
  for (let i = 0; i < N; i += 1) {
    let sum = 0;
    for (let o = -6; o <= 6; o += 1) sum += rawBank[(i + o + N) % N];
    bank[i] = sum / 13;
  }
  // Steigung entlang der Strecke (dy/ds)
  const slope = new Float32Array(N);
  for (let i = 0; i < N; i += 1) slope[i] = (py[(i + 1) % N] - py[(i - 1 + N) % N]) / (2 * step);

  const halfWidth = def.width / 2;
  const shoulder = def.shoulder;
  const data = {
    def,
    id: def.id,
    N,
    step,
    length: total,
    px, pz, tx, tz, nx, nz, heading, curvature, py, bank, slope,
    width: def.width,
    halfWidth,
    shoulder,
    wallOffset: halfWidth + shoulder,
    laps: def.laps || 3,
    theme: THEMES[def.theme] || THEMES.meadow,
    /** Index modulo N. */
    wrap(i) {
      return ((i % N) + N) % N;
    },
    /**
     * Nächster Abtastpunkt zu (x, z). Mit `hint` (letzter Index) wird nur lokal
     * gesucht, sonst global. Liefert Index, seitlichen Abstand `d`
     * (Normalen-Richtung) und den Fahrbahn-Winkel.
     */
    nearest(x, z, hint = -1) {
      let best = -1;
      let bestD2 = Infinity;
      if (hint >= 0) {
        for (let o = -40; o <= 40; o += 1) {
          const i = (hint + o + N) % N;
          const dx = x - px[i];
          const dz = z - pz[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      } else {
        for (let i = 0; i < N; i += 1) {
          const dx = x - px[i];
          const dz = z - pz[i];
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = i; }
        }
      }
      const d = (x - px[best]) * nx[best] + (z - pz[best]) * nz[best];
      return { i: best, d, dist: Math.sqrt(bestD2), heading: heading[best] };
    },
    /** Weltposition auf Index `i` mit seitlichem Versatz `lat`. */
    pointAt(i, lat = 0) {
      const k = ((Math.round(i) % N) + N) % N;
      return { x: px[k] + nx[k] * lat, z: pz[k] + nz[k] * lat, heading: heading[k] };
    },
    /** Startaufstellung: Platz `slot` (0 = Pole), 2 Spalten hinter der Linie. */
    /** Fahrbahnhöhe an Index `i` mit seitlichem Versatz (Querneigung inklusive). */
    surfaceY(i, lat = 0) {
      const k = ((Math.round(i) % N) + N) % N;
      return py[k] + lat * bank[k];
    },
    /**
     * Bodenhöhe, Steigung und Querneigung an einer Weltposition (für Karts,
     * Items und Kamera). Interpoliert zwischen Nachbarpunkten.
     */
    groundAt(x, z, hint = -1) {
      const near = this.nearest(x, z, hint);
      const i = near.i;
      const along = (x - px[i]) * tx[i] + (z - pz[i]) * tz[i];
      const j = along >= 0 ? (i + 1) % N : (i - 1 + N) % N;
      const f = Math.min(1, Math.abs(along) / step);
      const lat = Math.max(-this.wallOffset, Math.min(this.wallOffset, near.d));
      const y = (py[i] + lat * bank[i]) * (1 - f) + (py[j] + lat * bank[j]) * f;
      return { y, i, lat: near.d, slope: slope[i], bank: bank[i], heading: heading[i] };
    },
    gridSlot(slot) {
      const row = Math.floor(slot / 2);
      const col = slot % 2 === 0 ? -1 : 1;
      const back = 6 + row * 7 + (col > 0 ? 3 : 0);
      const idx = (N - Math.round(back / step) + N) % N;
      const lat = col * Math.min(5.5, halfWidth * 0.32);
      const p = this.pointAt(idx, lat);
      return { x: p.x, z: p.z, heading: p.heading, index: idx };
    },
  };
  return data;
}

/**
 * Plausibilitätsprüfung (für Entwicklung/Tests): minimaler Kurvenradius und
 * Mindestabstand zwischen weit auseinanderliegenden Streckenabschnitten.
 */
export function analyzeTrack(data) {
  let minRadius = Infinity;
  for (let i = 0; i < data.N; i += 1) {
    const c = Math.abs(data.curvature[i]);
    if (c > 1e-6) minRadius = Math.min(minRadius, 1 / c);
  }
  let minGap = Infinity;
  const skip = Math.round(160 / data.step);
  for (let i = 0; i < data.N; i += 3) {
    for (let j = i + skip; j < data.N; j += 3) {
      if (data.N - (j - i) < skip) continue;
      const gap = Math.hypot(data.px[i] - data.px[j], data.pz[i] - data.pz[j]);
      if (gap < minGap) minGap = gap;
    }
  }
  return { length: data.length, samples: data.N, minRadius, minGap };
}
