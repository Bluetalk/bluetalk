/** Ziel-Puffer laut Spezifikation — der Worklet-Ringpuffer ist der Jitterpuffer. */
export const PLAYBACK_SAMPLE_RATE = 48000;
export const JITTER_TARGET_MS = 80;
export const JITTER_MAX_MS = 300;
export const PLAYBACK_TARGET_SAMPLES = Math.round(PLAYBACK_SAMPLE_RATE * JITTER_TARGET_MS / 1000);
export const PLAYBACK_MAX_SAMPLES = Math.round(PLAYBACK_SAMPLE_RATE * JITTER_MAX_MS / 1000);

/**
 * Sample-Ringpuffer: Prefill 80 ms, Re-Buffering bei Unterlauf,
 * Füllstand > 300 ms verwirft das Älteste.
 */
export function createPlaybackRing(options = {}) {
  const targetSamples = Math.max(1, Number(options.targetSamples) || PLAYBACK_TARGET_SAMPLES);
  const maxSamples = Math.max(targetSamples, Number(options.maxSamples) || PLAYBACK_MAX_SAMPLES);
  const capacity = Math.max(maxSamples, Number(options.capacity) || PLAYBACK_SAMPLE_RATE);
  const sampleRate = Math.max(1, Number(options.sampleRate) || PLAYBACK_SAMPLE_RATE);

  const buffer = new Float32Array(capacity);
  let read = 0;
  let write = 0;
  let filled = 0;
  let playing = false;

  function push(samples) {
    if (!samples || !samples.length) return;
    for (let i = 0; i < samples.length; i += 1) {
      if (filled >= buffer.length) {
        read = (read + 1) % buffer.length;
        filled -= 1;
      }
      buffer[write] = samples[i];
      write = (write + 1) % buffer.length;
      filled += 1;
    }
    while (filled > maxSamples) {
      read = (read + 1) % buffer.length;
      filled -= 1;
    }
  }

  function pull(out) {
    const dest = out || [];
    const n = dest.length;
    if (!playing) {
      if (filled < targetSamples) {
        for (let i = 0; i < n; i += 1) dest[i] = 0;
        return { playing: false, underrun: false, filled };
      }
      playing = true;
    }
    let underrun = false;
    for (let i = 0; i < n; i += 1) {
      if (filled > 0) {
        dest[i] = buffer[read];
        read = (read + 1) % buffer.length;
        filled -= 1;
      } else {
        dest[i] = 0;
        underrun = true;
      }
    }
    if (underrun) playing = false;
    return { playing, underrun, filled };
  }

  function fillMs() {
    return (filled / sampleRate) * 1000;
  }

  function reset() {
    read = 0;
    write = 0;
    filled = 0;
    playing = false;
  }

  return {
    push,
    pull,
    fillMs,
    reset,
    get filled() { return filled; },
    get playing() { return playing; },
    targetSamples,
    maxSamples,
  };
}
