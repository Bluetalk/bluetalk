/** Anzahl der Wellenform-Balken, die mit der Sprachnachricht gespeichert werden. */
export const WAVEFORM_BARS = 64;

/** Obergrenze eines Balkens (inkl.). */
export const WAVEFORM_MAX = 255;

/**
 * Skaliert eine beliebige Pegel-Liste auf genau `target` Balken (0–255).
 * Pro Zielbalken wird das Maximum des Quellsegments genommen, damit kurze
 * Spitzen nicht weggeglättet werden.
 */
export function downsampleWaveform(levels, target = WAVEFORM_BARS) {
  const count = Math.max(1, Math.floor(Number(target) || WAVEFORM_BARS));
  if (!Array.isArray(levels) || levels.length === 0) {
    return Array.from({ length: count }, () => 0);
  }
  if (levels.length === count) {
    return levels.map((n) => clampBar(n));
  }
  const out = new Array(count);
  const step = levels.length / count;
  for (let i = 0; i < count; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = start; j < end && j < levels.length; j += 1) {
      const v = clampBar(levels[j]);
      if (v > peak) peak = v;
    }
    out[i] = peak;
  }
  return out;
}

/**
 * RMS eines Float32-Frames (−1…1) als Balken 0–255.
 * Der Faktor 2,2 hebt Sprache über dem Rauschen an, ohne sofort zu clippen.
 */
export function rmsToBar(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Number(samples[i]) || 0;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples.length);
  return clampBar(Math.round(rms * 255 * 2.2));
}

function clampBar(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= WAVEFORM_MAX) return WAVEFORM_MAX;
  return v | 0;
}
