import { CALL_DIR_IN, CALL_DIR_OUT } from './iv.js';
import { opusFrameTimestampUs, packLengthPrefixedFrames, unpackLengthPrefixedFrames } from './frames.js';
import { CALL_PACKET_MS, createJitterBuffer } from './jitterBuffer.js';
import { createPlaybackRing } from './playbackBuffer.js';
import { decryptCallPayload, encryptCallPayload, importCallKey } from './crypto.js';
import { addCallWorklets } from './worklets.js';
import { attachAecOutput } from './aecOutput.js';
import { AUDIO_MAX_PACKET_BYTES, isSafeSeq } from './callLimits.js';

const PCM_PACKET_SAMPLES_48K = 2880; // 60 ms @ 48 kHz
const PCM16_SAMPLES = 960; // 60 ms @ 16 kHz
const WANT_FILL_MS = 160;

export async function codecIsOpusSupported() {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return false;
  try {
    const enc = await AudioEncoder.isConfigSupported({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 24000,
    });
    const dec = await AudioDecoder.isConfigSupported({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
    });
    return Boolean(enc?.supported && dec?.supported);
  } catch {
    return false;
  }
}

export function pickAcceptCodec(offered) {
  const list = Array.isArray(offered) ? offered : ['opus', 'pcm16'];
  return list.includes('opus') ? 'opus' : 'pcm16';
}

/**
 * Volle Sende-/Empfangspipeline. Kein React — Pegel liegen auf einem Shared-Objekt.
 */
export async function createAudioPipeline({
  callKeyB64,
  role,
  codec,
  sendAudio,
  onError,
  isCurrent,
}) {
  const stillCurrent = () => (typeof isCurrent === 'function' ? isCurrent() : !closed);
  const callKey = await importCallKey(callKeyB64);
  if (!stillCurrent()) throw new Error('call_aborted');

  const directionSend = role === 'caller' ? CALL_DIR_OUT : CALL_DIR_IN;
  const directionRecv = role === 'caller' ? CALL_DIR_IN : CALL_DIR_OUT;
  const useOpus = codec === 'opus' && (await codecIsOpusSupported());
  if (!stillCurrent()) throw new Error('call_aborted');
  const actualCodec = useOpus ? 'opus' : 'pcm16';

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const captureCtx = new Ctx({ sampleRate: 48000 });
  const playCtx = new Ctx({ sampleRate: 48000 });
  if (captureCtx.state === 'suspended') await captureCtx.resume();
  if (playCtx.state === 'suspended') await playCtx.resume();
  if (!stillCurrent()) {
    try { await captureCtx.close(); } catch { /* ignore */ }
    try { await playCtx.close(); } catch { /* ignore */ }
    throw new Error('call_aborted');
  }

  const levels = { capture: 0, playback: 0 };
  const jitter = createJitterBuffer();
  const fallbackRing = createPlaybackRing();
  const seenSeq = new Set();
  let nextSendSeq = 0;
  let muted = false;
  let closed = false;
  let stream = null;
  let captureNode = null;
  let playbackNode = null;
  let source = null;
  let encoder = null;
  let decoder = null;
  let opusChunks = [];
  let pcmAcc = new Float32Array(0);
  let scriptProcessor = null;
  let playProcessor = null;
  let lastRecvSeq = -1;
  let aecOutput = null;
  let gapTimer = 0;
  let pumping = false;
  let lastFillMs = 0;

  async function close() {
    closed = true;
    if (gapTimer) {
      clearTimeout(gapTimer);
      gapTimer = 0;
    }
    try { encoder?.close(); } catch { /* ignore */ }
    try { decoder?.close(); } catch { /* ignore */ }
    try { captureNode?.disconnect(); } catch { /* ignore */ }
    try { playbackNode?.disconnect(); } catch { /* ignore */ }
    try { scriptProcessor?.disconnect(); } catch { /* ignore */ }
    try { playProcessor?.disconnect(); } catch { /* ignore */ }
    try { source?.disconnect(); } catch { /* ignore */ }
    try { aecOutput?.close(); } catch { /* ignore */ }
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* ignore */ }
      }
    }
    try { await captureCtx.close(); } catch { /* ignore */ }
    try { if (playCtx !== captureCtx) await playCtx.close(); } catch { /* ignore */ }
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    try { await captureCtx.close(); } catch { /* ignore */ }
    try { await playCtx.close(); } catch { /* ignore */ }
    throw err;
  }
  if (!stillCurrent()) {
    await close();
    throw new Error('call_aborted');
  }

  let workletsOk = false;
  try {
    await addCallWorklets(captureCtx);
    if (playCtx !== captureCtx) await addCallWorklets(playCtx);
    workletsOk = true;
  } catch {
    workletsOk = false;
  }
  if (!stillCurrent()) {
    await close();
    throw new Error('call_aborted');
  }

  source = captureCtx.createMediaStreamSource(stream);

  if (workletsOk) {
    captureNode = new AudioWorkletNode(captureCtx, 'bluetalk-capture');
    captureNode.port.onmessage = (event) => {
      if (closed || muted) return;
      const samples = event.data;
      if (!(samples instanceof Float32Array)) return;
      let peak = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const mag = Math.abs(samples[i]);
        if (mag > peak) peak = mag;
      }
      levels.capture = peak;
      void ingestCapture(samples);
    };
    source.connect(captureNode);
    const muteGain = captureCtx.createGain();
    muteGain.gain.value = 0;
    captureNode.connect(muteGain);
    muteGain.connect(captureCtx.destination);

    playbackNode = new AudioWorkletNode(playCtx, 'bluetalk-playback');
    playbackNode.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (typeof data.peak === 'number') levels.playback = data.peak;
      if (typeof data.fillMs === 'number') {
        lastFillMs = data.fillMs;
        if (data.fillMs < WANT_FILL_MS) void pumpFromJitter();
      }
    };
  } else {
    scriptProcessor = captureCtx.createScriptProcessor(2048, 1, 1);
    scriptProcessor.onaudioprocess = (event) => {
      if (closed || muted) return;
      const input = event.inputBuffer.getChannelData(0);
      void ingestCapture(new Float32Array(input));
    };
    source.connect(scriptProcessor);
    const muteGain = captureCtx.createGain();
    muteGain.gain.value = 0;
    scriptProcessor.connect(muteGain);
    muteGain.connect(captureCtx.destination);

    playProcessor = playCtx.createScriptProcessor(2048, 1, 1);
    playProcessor.onaudioprocess = (event) => {
      if (closed) {
        event.outputBuffer.getChannelData(0).fill(0);
        return;
      }
      const out = event.outputBuffer.getChannelData(0);
      const result = fallbackRing.pull(out);
      let peak = 0;
      for (let i = 0; i < out.length; i += 1) {
        const mag = Math.abs(out[i]);
        if (mag > peak) peak = mag;
      }
      levels.playback = peak;
      lastFillMs = fallbackRing.fillMs();
      if (lastFillMs < WANT_FILL_MS || result.underrun) void pumpFromJitter();
    };
  }

  if (useOpus) {
    encoder = new AudioEncoder({
      output: (chunk) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        opusChunks.push(buf);
        if (opusChunks.length >= 3) {
          const packed = packLengthPrefixedFrames(opusChunks.splice(0, 3));
          void sendPacked(packed);
        }
      },
      error: (err) => onError?.(err),
    });
    encoder.configure({
      codec: 'opus',
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: 24000,
    });
    decoder = new AudioDecoder({
      output: (audioData) => {
        const frames = audioData.numberOfFrames;
        const tmp = new Float32Array(frames);
        audioData.copyTo(tmp, { planeIndex: 0 });
        audioData.close();
        enqueuePlayback(tmp);
      },
      error: (err) => onError?.(err),
    });
    decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
  }

  const playbackSource = playbackNode || playProcessor;
  if (playbackSource) {
    try {
      aecOutput = await attachAecOutput(playCtx, playbackSource);
    } catch {
      playbackSource.connect(playCtx.destination);
    }
  }
  if (!stillCurrent()) {
    await close();
    throw new Error('call_aborted');
  }

  let captureTs = 0;
  async function ingestCapture(samples48k) {
    if (actualCodec === 'opus' && encoder) {
      try {
        const audioData = new AudioData({
          format: 'f32',
          sampleRate: 48000,
          numberOfChannels: 1,
          numberOfFrames: samples48k.length,
          timestamp: captureTs,
          data: samples48k,
        });
        captureTs += Math.round((samples48k.length / 48000) * 1e6);
        encoder.encode(audioData);
        audioData.close();
      } catch (err) {
        onError?.(err);
      }
      return;
    }
    const merged = concatFloat(pcmAcc, samples48k);
    let offset = 0;
    while (offset + PCM_PACKET_SAMPLES_48K <= merged.length) {
      const slice = merged.subarray(offset, offset + PCM_PACKET_SAMPLES_48K);
      offset += PCM_PACKET_SAMPLES_48K;
      void sendPacked(float48kToPcm16(slice));
    }
    pcmAcc = merged.subarray(offset);
  }

  async function sendPacked(framesBytes) {
    if (closed || muted) return;
    const seq = nextSendSeq;
    nextSendSeq += 1;
    try {
      const data = await encryptCallPayload(callKey, framesBytes, directionSend, seq);
      sendAudio(seq, data);
    } catch (err) {
      onError?.(err);
    }
  }

  function enqueuePlayback(float32) {
    if (playbackNode) {
      playbackNode.port.postMessage({ samples: float32 });
      return;
    }
    fallbackRing.push(float32);
  }

  function enqueueSilence() {
    enqueuePlayback(new Float32Array(PCM_PACKET_SAMPLES_48K));
  }

  function decodePacket(seq, payload) {
    if (actualCodec === 'opus') {
      if (!decoder) return;
      const frames = unpackLengthPrefixedFrames(payload);
      frames.forEach((frame, index) => {
        try {
          decoder.decode(new EncodedAudioChunk({
            type: 'key',
            timestamp: opusFrameTimestampUs(seq, index),
            data: frame,
          }));
        } catch {
          /* skip */
        }
      });
      return;
    }
    enqueuePlayback(upsample16kTo48k(int16ToFloat(payload)));
  }

  function armGapTimer() {
    if (gapTimer || closed) return;
    const wait = jitter.msUntilDecision();
    if (wait <= 0) return;
    gapTimer = window.setTimeout(() => {
      gapTimer = 0;
      void pumpFromJitter();
    }, Math.max(1, wait));
  }

  async function pumpFromJitter() {
    if (closed || pumping) return;
    pumping = true;
    try {
      while (!closed && lastFillMs < WANT_FILL_MS + CALL_PACKET_MS) {
        const item = jitter.pull();
        if (!item) {
          armGapTimer();
          break;
        }
        if (item.type === 'loss') {
          enqueueSilence();
          lastFillMs += CALL_PACKET_MS;
          continue;
        }
        decodePacket(item.seq, item.payload);
        lastFillMs += CALL_PACKET_MS;
      }
    } finally {
      pumping = false;
    }
  }

  async function pushRemotePacket(seq, dataB64) {
    if (closed) return;
    if (!isSafeSeq(seq)) return;
    const n = Number(seq);
    if (typeof dataB64 === 'string' && dataB64.length > (AUDIO_MAX_PACKET_BYTES + 64) * 2) return;
    if (n <= lastRecvSeq && seenSeq.has(n)) return;
    if (seenSeq.has(n)) return;
    if (lastRecvSeq >= 0 && n < lastRecvSeq - 8) return;
    seenSeq.add(n);
    if (seenSeq.size > 400) {
      const oldest = [...seenSeq].sort((a, b) => a - b).slice(0, 200);
      for (const s of oldest) seenSeq.delete(s);
    }
    if (n > lastRecvSeq) lastRecvSeq = n;
    try {
      const plain = await decryptCallPayload(callKey, dataB64, directionRecv, n);
      if (plain.length > AUDIO_MAX_PACKET_BYTES) return;
      jitter.push(n, plain);
      void pumpFromJitter();
    } catch {
      /* falscher Schlüssel / beschädigtes Paket */
    }
  }

  function setMuted(next) {
    muted = Boolean(next);
  }

  return {
    codec: actualCodec,
    levels,
    pushRemotePacket,
    setMuted,
    close,
  };
}

function concatFloat(a, b) {
  if (!a.length) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function float48kToPcm16(samples48k) {
  const out = new Uint8Array(PCM16_SAMPLES * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < PCM16_SAMPLES; i += 1) {
    const a = samples48k[i * 3] || 0;
    const b = samples48k[i * 3 + 1] || a;
    const c = samples48k[i * 3 + 2] || b;
    const sample = Math.max(-1, Math.min(1, (a + b + c) / 3));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return out;
}

function int16ToFloat(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return out;
}

function upsample16kTo48k(samples16k) {
  const out = new Float32Array(samples16k.length * 3);
  for (let i = 0; i < samples16k.length; i += 1) {
    const s = samples16k[i];
    out[i * 3] = s;
    out[i * 3 + 1] = s;
    out[i * 3 + 2] = s;
  }
  return out;
}
