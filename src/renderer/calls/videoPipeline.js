import { encryptCallPayload, decryptCallPayload } from './crypto.js';
import { callVideoIvDirection } from './iv.js';
import { splitVideoFrame, createFrameReassembler, VIDEO_MAX_FRAGMENT_BYTES } from './videoFragments.js';
import { createKeyframeController } from './videoKeyframe.js';
import { createCongestionController } from './videoCongestion.js';
import { decoderConfigFor, encoderConfigFor, VIDEO_CODEC_VP8 } from './videoCaps.js';
import { isSafeSeq } from './callLimits.js';

const CAMERA_CONSTRAINTS = {
  video: {
    width: { ideal: 640, max: 640 },
    height: { ideal: 360, max: 360 },
    frameRate: { ideal: 24, max: 24 },
    facingMode: 'user',
  },
  audio: false,
};

const SCREEN_CONSTRAINTS = {
  video: { frameRate: 8 },
  audio: false,
};

const KEYFRAME_EVERY_MS = 3000;

function evenDim(value, max) {
  const n = Math.max(2, Math.min(max, Math.round(Number(value) || max)));
  return n - (n % 2);
}

function scaleSize(width, height, maxW, maxH) {
  const w = Number(width) || maxW;
  const h = Number(height) || maxH;
  const scale = Math.min(1, maxW / w, maxH / h);
  return {
    width: evenDim(w * scale, maxW),
    height: evenDim(h * scale, maxH),
  };
}

/**
 * Eine Video-Richtung (Kamera oder Bildschirm): Aufnahme, Kodierung, Empfang.
 */
export async function createVideoDirection({
  streamKind,
  callKey,
  role,
  codec,
  isCurrent,
  sendFragment,
  requestKeyframe,
  audioBusy,
  onEnded,
  onError,
  getUserMedia,
  getDisplayMedia,
}) {
  const kind = streamKind === 'screen' ? 'screen' : 'camera';
  const maxSize = kind === 'screen' ? { w: 1280, h: 720 } : { w: 640, h: 360 };
  const fps = kind === 'screen' ? 8 : 24;
  const congestion = createCongestionController({ audioBusy });
  const inboundKey = createKeyframeController();
  const reassembler = createFrameReassembler();
  let closed = false;
  let encoder = null;
  let decoder = null;
  let captureStream = null;
  let videoEl = null;
  let canvas = null;
  let ctx = null;
  let timer = 0;
  let seq = 0;
  let lastKeyAt = 0;
  let forceKey = true;
  let sink = null;
  let decoderReady = false;
  let pendingConfig = null;
  let lastBitrate = congestion.currentBitrate(kind);
  let track = null;
  let processor = null;
  let reader = null;

  const still = () => !closed && (typeof isCurrent !== 'function' || isCurrent());
  let endedHandler = null;

  function fail(err) {
    onError?.(err);
  }

  async function close() {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
    try { await reader?.cancel?.(); } catch { /* ignore */ }
    reader = null;
    try { processor?.stop?.(); } catch { /* ignore */ }
    processor = null;
    try { encoder?.close(); } catch { /* ignore */ }
    try { decoder?.close(); } catch { /* ignore */ }
    encoder = null;
    decoder = null;
    decoderReady = false;
    try { reassembler.clear?.(); } catch { /* ignore */ }
    if (track && endedHandler) {
      try { track.removeEventListener('ended', endedHandler); } catch { /* ignore */ }
    }
    if (track) {
      try { track.stop(); } catch { /* ignore */ }
    }
    track = null;
    if (captureStream) {
      for (const t of captureStream.getTracks()) {
        try { t.stop(); } catch { /* ignore */ }
      }
    }
    captureStream = null;
    if (videoEl) {
      try { videoEl.pause(); } catch { /* ignore */ }
      try { videoEl.srcObject = null; } catch { /* ignore */ }
      videoEl = null;
    }
    if (canvas) {
      try { canvas.width = 0; canvas.height = 0; } catch { /* ignore */ }
    }
    canvas = null;
    ctx = null;
    sink = null;
    endedHandler = null;
  }

  async function startCapture() {
    if (!still()) throw new Error('call_aborted');
    try {
      const gum = getUserMedia || ((constraints) => navigator.mediaDevices.getUserMedia(constraints));
      const gdm = getDisplayMedia || ((constraints) => navigator.mediaDevices.getDisplayMedia(constraints));
      if (kind === 'screen') {
        captureStream = await gdm(SCREEN_CONSTRAINTS);
      } else {
        captureStream = await gum(CAMERA_CONSTRAINTS);
      }
    } catch (err) {
      await close();
      throw err;
    }
    if (!still()) {
      await close();
      throw new Error('call_aborted');
    }
    track = captureStream.getVideoTracks()[0];
    if (!track) {
      await close();
      throw new Error('no_video_track');
    }
    if (kind === 'screen') {
      try { track.contentHint = 'detail'; } catch { /* ignore */ }
    }
    endedHandler = () => {
      if (closed) return;
      onEnded?.(kind);
    };
    track.addEventListener('ended', endedHandler);
    const settings = track.getSettings?.() || {};
    const sized = scaleSize(settings.width, settings.height, maxSize.w, maxSize.h);
    try {
      await startEncoder(sized.width, sized.height);
      if (!still()) throw new Error('call_aborted');
      await startCaptureLoop(sized.width, sized.height);
    } catch (err) {
      await close();
      throw err;
    }
  }

  async function startEncoder(width, height) {
    if (!still()) throw new Error('call_aborted');
    if (typeof VideoEncoder === 'undefined') throw new Error('no_webcodecs');
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        void handleEncoded(chunk, meta, width, height);
      },
      error: (err) => fail(err),
    });
    encoder.configure(encoderConfigFor(codec || VIDEO_CODEC_VP8, {
      width,
      height,
      bitrate: lastBitrate,
      framerate: fps,
    }));
    if (!still()) throw new Error('call_aborted');
  }

  async function handleEncoded(chunk, meta, width, height) {
    if (closed || !still()) return;
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const parts = splitVideoFrame(bytes);
    const isKey = chunk.type === 'key';
    const ts = chunk.timestamp;
    const desc = meta?.decoderConfig?.description
      ? new Uint8Array(meta.decoderConfig.description)
      : null;
    congestion.onQueued(kind);
    try {
      for (let i = 0; i < parts.length; i += 1) {
        const fragmentSeq = seq;
        seq += 1;
        const ivDir = callVideoIvDirection(kind, role, true);
        const data = await encryptCallPayload(callKey, parts[i], ivDir, fragmentSeq);
        if (closed || !still()) return;
        sendFragment({
          stream: kind,
          seq: fragmentSeq,
          frag: i,
          frags: parts.length,
          key: isKey,
          ts,
          codec: codec || VIDEO_CODEC_VP8,
          w: width,
          h: height,
          data,
          desc: i === 0 && desc ? desc : undefined,
        });
      }
    } catch (err) {
      fail(err);
    } finally {
      congestion.onDone(kind);
    }
  }

  async function startCaptureLoop(width, height) {
    if (!still()) throw new Error('call_aborted');
    if (typeof MediaStreamTrackProcessor === 'function' && track) {
      try {
        processor = new MediaStreamTrackProcessor({ track });
        reader = processor.readable.getReader();
        void pumpProcessor(width, height);
        return;
      } catch {
        /* Canvas-Fallback */
      }
    }
    videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = captureStream;
    await videoEl.play();
    if (!still()) throw new Error('call_aborted');
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d', { alpha: false });
    const interval = Math.max(40, Math.round(1000 / fps));
    timer = window.setInterval(() => {
      void captureCanvasFrame(width, height);
    }, interval);
  }

  async function pumpProcessor(width, height) {
    while (!closed && still() && reader) {
      let result;
      try {
        result = await reader.read();
      } catch {
        break;
      }
      if (result?.done || !result.value) break;
      const frame = result.value;
      encodeFrame(frame, width, height);
    }
  }

  async function captureCanvasFrame(width, height) {
    if (closed || !ctx || !videoEl) return;
    try {
      ctx.drawImage(videoEl, 0, 0, width, height);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(performance.now() * 1000) });
      encodeFrame(frame, width, height);
    } catch (err) {
      fail(err);
    }
  }

  function encodeFrame(frame, width, height) {
    try {
      if (closed || !encoder) {
        frame.close();
        return;
      }
      if (!congestion.canSend(kind) || encoder.encodeQueueSize >= 5) {
        congestion.onCongested(kind);
        const nextRate = congestion.currentBitrate(kind);
        if (nextRate !== lastBitrate) {
          lastBitrate = nextRate;
          try {
            encoder.configure(encoderConfigFor(codec || VIDEO_CODEC_VP8, {
              width,
              height,
              bitrate: nextRate,
              framerate: fps,
            }));
          } catch { /* ignore */ }
        }
        frame.close();
        return;
      }
      const now = Date.now();
      const keyFrame = forceKey || now - lastKeyAt >= KEYFRAME_EVERY_MS;
      if (keyFrame) {
        lastKeyAt = now;
        forceKey = false;
      }
      encoder.encode(frame, { keyFrame });
    } catch (err) {
      fail(err);
    } finally {
      try { frame.close(); } catch { /* ignore */ }
    }
  }

  function requestKeyNow() {
    forceKey = true;
  }

  function setSink(canvasEl) {
    sink = canvasEl || null;
  }

  function ensureDecoder(frameInfo) {
    if (decoderReady && decoder) return true;
    if (typeof VideoDecoder === 'undefined') return false;
    if (decoder) {
      try { decoder.close(); } catch { /* ignore */ }
    }
    decoder = new VideoDecoder({
      output: (videoFrame) => {
        try {
          const target = sink;
          if (target && target.getContext) {
            const draw = target.getContext('2d', { alpha: false });
            if (draw) {
              if (target.width !== videoFrame.displayWidth) target.width = videoFrame.displayWidth;
              if (target.height !== videoFrame.displayHeight) target.height = videoFrame.displayHeight;
              draw.drawImage(videoFrame, 0, 0);
            }
          }
        } finally {
          videoFrame.close();
        }
      },
      error: (err) => fail(err),
    });
    const extra = {};
    if (frameInfo?.desc) extra.description = frameInfo.desc;
    else if (pendingConfig) extra.description = pendingConfig;
    decoder.configure(decoderConfigFor(frameInfo?.codec || codec || VIDEO_CODEC_VP8, extra));
    decoderReady = true;
    return true;
  }

  async function pushRemotePacket(msg) {
    if (closed || !still()) return;
    if (!isSafeSeq(msg?.seq)) return;
    const seqN = Number(msg.seq);
    let plain;
    try {
      const ivDir = callVideoIvDirection(kind, role, false);
      plain = await decryptCallPayload(callKey, msg.data, ivDir, seqN);
    } catch {
      return;
    }
    if (plain.length > VIDEO_MAX_FRAGMENT_BYTES) return;
    const assembled = reassembler.push({
      ...msg,
      data: plain,
    });
    if (!assembled) return;
    if (assembled.desc) pendingConfig = assembled.desc;
    if (assembled.key) inboundKey.onKeyframe();
    else if (inboundKey.shouldDropDelta()) return;
    if (!ensureDecoder(assembled)) return;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: assembled.key ? 'key' : 'delta',
        timestamp: Number(assembled.ts) || 0,
        data: assembled.bytes,
      }));
    } catch {
      const { request } = inboundKey.onGap(Date.now());
      decoderReady = false;
      if (request) requestKeyframe?.(kind);
    }
  }

  function noteGap() {
    const { request } = inboundKey.onGap(Date.now());
    if (request) requestKeyframe?.(kind);
  }

  await startCapture();

  return {
    kind,
    getStream: () => captureStream,
    setSink,
    pushRemotePacket,
    requestKeyNow,
    noteGap,
    close,
  };
}

export async function createInboundVideoRenderer({
  streamKind,
  callKey,
  role,
  codec,
  isCurrent,
  requestKeyframe,
  onError,
}) {
  const kind = streamKind === 'screen' ? 'screen' : 'camera';
  const inboundKey = createKeyframeController();
  const reassembler = createFrameReassembler();
  let decoder = null;
  let decoderReady = false;
  let sink = null;
  let closed = false;
  let pendingConfig = null;

  function fail(err) {
    onError?.(err);
  }

  function setSink(canvasEl) {
    sink = canvasEl || null;
  }

  function ensureDecoder(frameInfo) {
    if (decoderReady && decoder) return true;
    if (typeof VideoDecoder === 'undefined') return false;
    if (decoder) {
      try { decoder.close(); } catch { /* ignore */ }
    }
    decoder = new VideoDecoder({
      output: (videoFrame) => {
        try {
          const target = sink;
          if (target?.getContext) {
            const draw = target.getContext('2d', { alpha: false });
            if (draw) {
              if (target.width !== videoFrame.displayWidth) target.width = videoFrame.displayWidth;
              if (target.height !== videoFrame.displayHeight) target.height = videoFrame.displayHeight;
              draw.drawImage(videoFrame, 0, 0, target.width, target.height);
            }
          }
        } finally {
          videoFrame.close();
        }
      },
      error: (err) => fail(err),
    });
    const extra = {};
    if (frameInfo?.desc) extra.description = frameInfo.desc;
    else if (pendingConfig) extra.description = pendingConfig;
    decoder.configure(decoderConfigFor(frameInfo?.codec || codec || VIDEO_CODEC_VP8, extra));
    decoderReady = true;
    return true;
  }

  async function pushRemotePacket(msg) {
    if (closed || (typeof isCurrent === 'function' && !isCurrent())) return;
    if (!isSafeSeq(msg?.seq)) return;
    const seqN = Number(msg.seq);
    let plain;
    try {
      const ivDir = callVideoIvDirection(kind, role, false);
      plain = await decryptCallPayload(callKey, msg.data, ivDir, seqN);
    } catch {
      return;
    }
    if (plain.length > VIDEO_MAX_FRAGMENT_BYTES) return;
    const assembled = reassembler.push({ ...msg, data: plain });
    if (!assembled) return;
    if (assembled.desc) pendingConfig = assembled.desc;
    if (assembled.key) inboundKey.onKeyframe();
    else if (inboundKey.shouldDropDelta()) return;
    if (!ensureDecoder(assembled)) return;
    try {
      decoder.decode(new EncodedVideoChunk({
        type: assembled.key ? 'key' : 'delta',
        timestamp: Number(assembled.ts) || 0,
        data: assembled.bytes,
      }));
    } catch {
      const { request } = inboundKey.onGap(Date.now());
      decoderReady = false;
      if (request) requestKeyframe?.(kind);
    }
  }

  async function close() {
    closed = true;
    try { decoder?.close(); } catch { /* ignore */ }
    decoder = null;
    decoderReady = false;
    sink = null;
    pendingConfig = null;
    try { reassembler.clear?.(); } catch { /* ignore */ }
  }

  return { kind, setSink, pushRemotePacket, close };
}
