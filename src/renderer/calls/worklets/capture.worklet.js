/**
 * Capture-Worklet: 20-ms-Blöcke @ 48 kHz (960 Samples) an den Hauptthread.
 * Klassisches AudioWorklet-Skript — kein ES-Modul (addModule).
 */
class BlueTalkCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(960);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buf[this.offset] = channel[i];
      this.offset += 1;
      if (this.offset >= this.buf.length) {
        this.port.postMessage(this.buf.slice(0));
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor('bluetalk-capture', BlueTalkCaptureProcessor);
