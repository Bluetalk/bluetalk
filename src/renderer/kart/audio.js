/**
 * BlueKart — synthetisierter Ton (Web Audio, keine Dateien).
 *
 * Motor mit Gangstufen (Drehzahl steigt pro Gang und fällt beim Schalten),
 * leichte Sättigung, Reifenquietschen beim Driften/Bremsen, Fahrtwind ab
 * hohem Tempo und kurze Effekte für Items, Treffer, Countdown und Runden.
 * Alles läuft über einen Kompressor und ist stumm schaltbar.
 */

const GEARS = [0, 0.22, 0.42, 0.62, 0.82, 1.05, 1.4];

function makeSaturation(ctx, amount = 2.2) {
  const shaper = ctx.createWaveShaper();
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  shaper.curve = curve;
  shaper.oversample = '2x';
  return shaper;
}

function makeNoiseBuffer(ctx, seconds = 2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function createKartAudio() {
  let ctx = null;
  let master = null;
  let engine = null;
  let tire = null;
  let wind = null;
  let noiseBuf = null;
  let muted = false;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(comp);
    comp.connect(ctx.destination);
    noiseBuf = makeNoiseBuffer(ctx);

    // Motor: zwei Oszillatoren + Sub, Sättigung, Tiefpass
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    const sat = makeSaturation(ctx, 2.4);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.Q.value = 3;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(mix);
    osc2.connect(mix);
    sub.connect(gain);
    mix.connect(sat);
    sat.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start();
    osc2.start();
    sub.start();
    engine = { osc, osc2, sub, filter, gain, gear: 1 };

    // Reifenquietschen: gefiltertes Rauschen in Schleife
    const tSrc = ctx.createBufferSource();
    tSrc.buffer = noiseBuf;
    tSrc.loop = true;
    const tFilter = ctx.createBiquadFilter();
    tFilter.type = 'bandpass';
    tFilter.frequency.value = 2400;
    tFilter.Q.value = 6;
    const tGain = ctx.createGain();
    tGain.gain.value = 0;
    tSrc.connect(tFilter);
    tFilter.connect(tGain);
    tGain.connect(master);
    tSrc.start();
    tire = { src: tSrc, filter: tFilter, gain: tGain };

    // Fahrtwind
    const wSrc = ctx.createBufferSource();
    wSrc.buffer = noiseBuf;
    wSrc.loop = true;
    wSrc.playbackRate.value = 0.7;
    const wFilter = ctx.createBiquadFilter();
    wFilter.type = 'lowpass';
    wFilter.frequency.value = 700;
    const wGain = ctx.createGain();
    wGain.gain.value = 0;
    wSrc.connect(wFilter);
    wFilter.connect(wGain);
    wGain.connect(master);
    wSrc.start();
    wind = { src: wSrc, filter: wFilter, gain: wGain };
    return ctx;
  }

  function resume() {
    const c = ensure();
    if (c && c.state === 'suspended') void c.resume();
  }

  /** ratio 0..1.3 (Tempo), boost, active = Rennen läuft, throttle 0..1. */
  function setEngine(ratio, boost, active, throttle = 0) {
    if (!ctx || !engine) return;
    const t = ctx.currentTime;
    const r = Math.max(0, Math.min(1.35, ratio));
    let gear = 1;
    while (gear < GEARS.length - 1 && r > GEARS[gear]) gear += 1;
    const lo = GEARS[gear - 1];
    const hi = GEARS[gear];
    const rpm = Math.max(0, Math.min(1, (r - lo) / Math.max(0.01, hi - lo)));
    const base = 62 + gear * 9 + rpm * 120 + (boost ? 35 : 0);
    const shift = gear !== engine.gear;
    engine.gear = gear;
    const glide = shift ? 0.12 : 0.04;
    engine.osc.frequency.setTargetAtTime(base, t, glide);
    engine.osc2.frequency.setTargetAtTime(base * 0.5, t, glide);
    engine.sub.frequency.setTargetAtTime(base * 0.25, t, glide);
    engine.filter.frequency.setTargetAtTime(420 + rpm * 900 + r * 700 + throttle * 300, t, 0.08);
    const vol = active ? 0.045 + r * 0.03 + throttle * 0.025 : 0.014;
    engine.gain.gain.setTargetAtTime(vol, t, 0.08);
  }

  /** Reifenquietschen 0..1 */
  function setTire(amount) {
    if (!ctx || !tire) return;
    const t = ctx.currentTime;
    const a = Math.max(0, Math.min(1, amount));
    tire.gain.gain.setTargetAtTime(a * 0.09, t, 0.06);
    tire.filter.frequency.setTargetAtTime(1900 + a * 900, t, 0.1);
  }

  /** Fahrtwind 0..1 */
  function setWind(amount) {
    if (!ctx || !wind) return;
    const t = ctx.currentTime;
    const a = Math.max(0, Math.min(1, amount));
    wind.gain.gain.setTargetAtTime(a * 0.08, t, 0.2);
    wind.filter.frequency.setTargetAtTime(500 + a * 1800, t, 0.2);
  }

  function tone(freq, dur, type = 'sine', vol = 0.25, slideTo = null, delay = 0) {
    if (!ctx || muted) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, vol = 0.3, freq = 900, type = 'lowpass') {
    if (!ctx || muted || !noiseBuf) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
  }

  const chord = (freqs, dur, step, type = 'triangle', vol = 0.18) => freqs.forEach((f, i) => tone(f, dur, type, vol, null, i * step));

  const sfx = {
    count: () => tone(440, 0.24, 'square', 0.16),
    go: () => { tone(880, 0.55, 'square', 0.18); tone(1320, 0.55, 'sine', 0.12); },
    item: () => { tone(660, 0.1, 'triangle', 0.2); tone(990, 0.14, 'triangle', 0.2, null, 0.08); },
    boost: () => { tone(220, 0.55, 'sawtooth', 0.14, 880); noise(0.5, 0.18, 1600, 'bandpass'); },
    hit: () => { noise(0.45, 0.5, 700); tone(180, 0.35, 'sawtooth', 0.2, 60); },
    banana: () => tone(500, 0.25, 'sine', 0.2, 120),
    rocket: () => { noise(0.4, 0.28, 2200); tone(300, 0.4, 'sawtooth', 0.12, 900); },
    shield: () => { tone(520, 0.4, 'sine', 0.2, 1040); tone(780, 0.4, 'sine', 0.15, 1560); },
    cp: () => { tone(1175, 0.09, 'triangle', 0.18); tone(1568, 0.12, 'triangle', 0.16, null, 0.07); },
    lap: () => { tone(660, 0.15, 'square', 0.14); tone(880, 0.2, 'square', 0.14, null, 0.12); },
    finalLap: () => chord([523, 659, 784, 1046, 1318], 0.22, 0.09, 'square', 0.12),
    finish: () => chord([523, 659, 784, 1046], 0.3, 0.14, 'triangle', 0.2),
    record: () => chord([784, 988, 1175, 1568], 0.22, 0.08, 'triangle', 0.16),
    slip: () => { noise(0.6, 0.2, 1200, 'bandpass'); tone(330, 0.5, 'sine', 0.12, 990); },
    scrape: () => noise(0.14, 0.2, 1800, 'bandpass'),
    drift: () => tone(1200 + Math.random() * 200, 0.05, 'square', 0.05),
  };

  return {
    resume,
    setEngine,
    setTire,
    setWind,
    sfx(name) {
      if (!ctx) return;
      sfx[name]?.();
    },
    setMuted(value) {
      muted = Boolean(value);
      if (master) master.gain.value = muted ? 0 : 0.55;
    },
    get muted() {
      return muted;
    },
    dispose() {
      try {
        engine?.osc.stop();
        engine?.osc2.stop();
        engine?.sub.stop();
        tire?.src.stop();
        wind?.src.stop();
        void ctx?.close();
      } catch {
        /* ignore */
      }
      ctx = null;
      engine = null;
      tire = null;
      wind = null;
    },
  };
}
