export const VIDEO_CODEC_VP8 = 'vp8';
export const VIDEO_CODEC_AVC1 = 'avc1';
export const VIDEO_AVC_PROFILE = 'avc1.42E01F';

export function encoderConfigFor(codec, { width, height, bitrate, framerate } = {}) {
  const common = {
    width: width || 640,
    height: height || 360,
    bitrate: bitrate || 600_000,
    framerate: framerate || 24,
    latencyMode: 'realtime',
  };
  if (codec === VIDEO_CODEC_AVC1 || String(codec).startsWith('avc1')) {
    return { ...common, codec: VIDEO_AVC_PROFILE, avc: { format: 'annexb' } };
  }
  return { ...common, codec: VIDEO_CODEC_VP8 };
}

export function decoderConfigFor(codec, extra = {}) {
  const name = codec === VIDEO_CODEC_AVC1 || String(codec).startsWith('avc1')
    ? VIDEO_AVC_PROFILE
    : VIDEO_CODEC_VP8;
  return { codec: name, ...extra };
}

export function pickVideoCodec(localList, remoteList) {
  const local = Array.isArray(localList) ? localList : [];
  const remote = Array.isArray(remoteList) ? remoteList : [];
  const has = (list, name) => list.some((item) => String(item).toLowerCase().startsWith(name));
  if (has(local, 'vp8') && has(remote, 'vp8')) return VIDEO_CODEC_VP8;
  if (has(local, 'avc1') && has(remote, 'avc1')) return VIDEO_CODEC_AVC1;
  return null;
}

export function isAllowedVideoCodec(codec) {
  const value = String(codec || '').toLowerCase();
  return value.startsWith('vp8') || value.startsWith('avc1');
}

export function normalizeCapabilityList(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '').toLowerCase();
    if (value.startsWith('vp8') && !out.includes(VIDEO_CODEC_VP8)) out.push(VIDEO_CODEC_VP8);
    else if (value.startsWith('avc1') && !out.includes(VIDEO_CODEC_AVC1)) out.push(VIDEO_CODEC_AVC1);
  }
  return out;
}

export async function probeVideoCodecs(hooks = {}) {
  const encProbe = hooks.isEncoderSupported;
  const decProbe = hooks.isDecoderSupported;
  const hasApi = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  if (!encProbe && !decProbe && !hasApi) {
    return { video: [], screen: false };
  }

  async function supported(codec) {
    const encCfg = encoderConfigFor(codec);
    const decCfg = decoderConfigFor(codec);
    try {
      const encFn = encProbe || ((cfg) => VideoEncoder.isConfigSupported(cfg));
      const decFn = decProbe || ((cfg) => VideoDecoder.isConfigSupported(cfg));
      const enc = await encFn(encCfg);
      const dec = await decFn(decCfg);
      return Boolean(enc?.supported && dec?.supported);
    } catch {
      return false;
    }
  }

  const video = [];
  if (await supported(VIDEO_CODEC_VP8)) video.push(VIDEO_CODEC_VP8);
  if (await supported(VIDEO_CODEC_AVC1)) video.push(VIDEO_CODEC_AVC1);
  return { video, screen: video.length > 0 };
}
