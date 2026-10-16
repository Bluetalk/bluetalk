/**
 * Klingelton / Freiton per WebAudio-Oszillator, kein Asset.
 */
function createOscTone({ chirp, intervalMs }) {
  let ctx = null;
  let nodes = [];
  let interval = 0;

  function stop() {
    if (interval) {
      clearInterval(interval);
      interval = 0;
    }
    for (const node of nodes) {
      try { node.stop(); } catch { /* ignore */ }
      try { node.disconnect(); } catch { /* ignore */ }
    }
    nodes = [];
    if (ctx) {
      try { void ctx.close(); } catch { /* ignore */ }
      ctx = null;
    }
  }

  async function start() {
    stop();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch { /* ignore */ }
    }
    chirp(() => ctx, (list) => { nodes = list; });
    interval = window.setInterval(() => chirp(() => ctx, (list) => { nodes = list; }), intervalMs);
  }

  return { start, stop };
}

export function createRingtone() {
  return createOscTone({
    intervalMs: 1400,
    chirp(getCtx, setNodes) {
      const ctx = getCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(520, now + 0.18);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.44);
      setNodes([osc, gain]);
    },
  });
}

/** Dezenter Freiton (425 Hz, 1 s an / 4 s aus) für den Anrufer. */
export function createRingback() {
  return createOscTone({
    intervalMs: 5000,
    chirp(getCtx, setNodes) {
      const ctx = getCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(425, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.03, now + 0.03);
      gain.gain.setValueAtTime(0.03, now + 0.92);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.0);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 1.05);
      setNodes([osc, gain]);
    },
  });
}
