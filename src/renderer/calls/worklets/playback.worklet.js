/**
 * Wiedergabe-Worklet: der eigentliche Jitterpuffer.
 * Prefill 80 ms, Re-Buffering bei Unterlauf, > 300 ms ältestes verwerfen.
 * Logik analog zu playbackBuffer.js (Worklets dürfen keine ES-Imports).
 */
const TARGET_SAMPLES = 3840; // 80 ms @ 48 kHz
const MAX_SAMPLES = 14400; // 300 ms @ 48 kHz
const CAPACITY = 48000;

class BlueTalkPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CAPACITY);
    this.read = 0;
    this.write = 0;
    this.filled = 0;
    this.playing = false;
    this.tick = 0;
    this.peak = 0;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === 'reset') {
        this.read = 0;
        this.write = 0;
        this.filled = 0;
        this.playing = false;
        this.peak = 0;
        return;
      }
      const samples = data && data.samples;
      if (!samples || !samples.length) return;
      for (let i = 0; i < samples.length; i += 1) {
        if (this.filled >= this.buffer.length) {
          this.read = (this.read + 1) % this.buffer.length;
          this.filled -= 1;
        }
        this.buffer[this.write] = samples[i];
        this.write = (this.write + 1) % this.buffer.length;
        this.filled += 1;
      }
      while (this.filled > MAX_SAMPLES) {
        this.read = (this.read + 1) % this.buffer.length;
        this.filled -= 1;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    let peak = 0;
    let underrun = false;

    if (!this.playing) {
      if (this.filled < TARGET_SAMPLES) {
        for (let i = 0; i < out.length; i += 1) out[i] = 0;
        this.report(peak);
        return true;
      }
      this.playing = true;
    }

    for (let i = 0; i < out.length; i += 1) {
      let sample = 0;
      if (this.filled > 0) {
        sample = this.buffer[this.read];
        this.read = (this.read + 1) % this.buffer.length;
        this.filled -= 1;
      } else {
        underrun = true;
      }
      out[i] = sample;
      const mag = sample < 0 ? -sample : sample;
      if (mag > peak) peak = mag;
    }

    if (underrun) this.playing = false;
    this.peak = this.peak > peak ? this.peak : peak;
    this.report(this.peak);
    return true;
  }

  report(peak) {
    this.tick += 1;
    if (this.tick < 12) return;
    this.port.postMessage({
      type: 'fill',
      fillMs: this.filled / 48,
      playing: this.playing,
      peak,
    });
    this.peak = 0;
    this.tick = 0;
  }
}

registerProcessor('bluetalk-playback', BlueTalkPlaybackProcessor);
