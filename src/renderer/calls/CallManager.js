import { newChatMessageId } from '../app/appHelpers.js';
import {
  CALL_PHASE,
  CALL_PING_MS,
  CALL_WATCHDOG_MS,
  RING_TIMEOUT_MS,
  createIdleCallState,
  peerSupportsVideo,
  reduceCall,
  VIDEO_LOCAL_UNSUPPORTED_HINT,
  VIDEO_PEER_UNSUPPORTED_HINT,
} from './callState.js';
import { generateCallKeyB64, importCallKey } from './crypto.js';
import { codecIsOpusSupported, createAudioPipeline, pickAcceptCodec } from './audioPipeline.js';
import { createRingback, createRingtone } from './ringtone.js';
import { stopAllVoicePlayback } from '../voice/playbackController.js';
import { devicesToCancel, shouldDropBoundMessage } from './callDevices.js';
import { probeVideoCodecs } from './videoCaps.js';
import { createInboundVideoRenderer, createVideoDirection } from './videoPipeline.js';
import { base64ToBytes, bytesToBase64 } from '../chatCrypto.js';
import {
  boundedString,
  CALL_DEVICE_KEY_MAX_LEN,
  sanitizeCallAudio,
  sanitizeCallOffer,
  sanitizeCallSignal,
  sanitizeCallVideo,
} from './callLimits.js';

/**
 * Orchestriert Signalisierung, Timer und Audio/Video. React hängt nur am Snapshot
 * (kein setState pro call-audio/call-video-Paket).
 */
export class CallManager {
  constructor(deps) {
    this.deps = deps;
    this.state = createIdleCallState();
    this.listeners = new Set();
    this.pipeline = null;
    this.mediaGeneration = 0;
    this.ringtone = createRingtone();
    this.ringback = createRingback();
    this.ringTimer = 0;
    this.watchdogTimer = 0;
    this.pingTimer = 0;
    this.levels = { capture: 0, playback: 0 };
    this.busyAudio = false;
    this.audioInFlight = 0;
    this.localCapabilities = { video: [], screen: false };
    this.callKey = null;
    this.cameraOut = null;
    this.screenOut = null;
    this.inbound = { camera: null, screen: null };
    this.sinks = { camera: null, screen: null };
    this.videoStartGen = { camera: 0, screen: 0 };
    this.videoProbe = probeVideoCodecs().then((caps) => {
      this.localCapabilities = caps;
      this.emit();
    }).catch(() => {});
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot() {
    return {
      ...this.state,
      videoCapable: (this.localCapabilities?.video || []).length > 0,
      remoteVideoCapable: peerSupportsVideo(this.state.remoteCapabilities),
      localCapabilities: this.localCapabilities,
    };
  }

  getLevels() {
    if (this.pipeline?.levels) return this.pipeline.levels;
    return this.levels;
  }

  getLocalStreams() {
    return {
      camera: this.cameraOut?.getStream?.() || null,
      screen: this.screenOut?.getStream?.() || null,
    };
  }

  setVideoSink(stream, canvas) {
    const key = stream === 'screen' ? 'screen' : 'camera';
    this.sinks[key] = canvas || null;
    this.inbound[key]?.setSink?.(canvas || null);
  }

  dispatch(event) {
    const { state, effects } = reduceCall(this.state, event);
    const changed = state !== this.state;
    this.state = state;
    for (const effect of effects) this.runEffect(effect);
    if (changed) this.emit();
  }

  emit() {
    for (const fn of this.listeners) {
      try { fn(this.getSnapshot()); } catch { /* ignore */ }
    }
  }

  async startCall(peerId, options = {}) {
    if (!peerId || this.state.phase !== CALL_PHASE.IDLE) return false;
    stopAllVoicePlayback();
    await this.videoProbe.catch(() => {});
    const wantVideo = options.video === true;
    if (wantVideo && !(this.localCapabilities.video || []).length) {
      this.deps.toast?.(VIDEO_LOCAL_UNSUPPORTED_HINT);
    }
    const callId = newChatMessageId();
    const callKeyB64 = await generateCallKeyB64();
    const codecs = ['pcm16'];
    if (await codecIsOpusSupported()) codecs.unshift('opus');
    this.dispatch({
      type: 'local-start',
      peerId,
      callId,
      callKeyB64,
      codecs,
      media: { video: wantVideo && (this.localCapabilities.video || []).length > 0 },
      capabilities: this.localCapabilities,
      now: Date.now(),
    });
    return true;
  }

  accept(options = {}) {
    if (this.state.phase !== CALL_PHASE.INCOMING) return;
    void this.acceptAsync(options);
  }

  async acceptAsync(options = {}) {
    const offered = this.state.codecs || ['opus', 'pcm16'];
    let codec = pickAcceptCodec(offered);
    if (codec === 'opus' && !(await codecIsOpusSupported())) codec = 'pcm16';
    if (!offered.includes(codec)) codec = offered.includes('pcm16') ? 'pcm16' : offered[0];
    await this.videoProbe.catch(() => {});
    const camera = options.camera === true
      && (this.localCapabilities.video || []).length > 0
      && peerSupportsVideo(this.state.remoteCapabilities);
    stopAllVoicePlayback();
    this.dispatch({
      type: 'local-accept',
      codec,
      camera,
      localVideoCodecs: this.localCapabilities.video,
      capabilities: this.localCapabilities,
      now: Date.now(),
      callId: this.state.callId,
      peerId: this.state.peerId,
    });
  }

  reject() {
    this.dispatch({ type: 'local-reject', now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  cancel() {
    this.dispatch({ type: 'local-cancel', now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  hangup() {
    const { phase, callId, peerId } = this.state;
    const now = Date.now();
    if (phase === CALL_PHASE.OUTGOING) {
      this.dispatch({ type: 'local-cancel', now, callId, peerId });
    } else if (phase === CALL_PHASE.INCOMING) {
      this.dispatch({ type: 'local-reject', now, callId, peerId });
    } else if (phase === CALL_PHASE.ACTIVE) {
      this.dispatch({ type: 'local-end', now, callId, peerId });
    }
  }

  toggleMute() {
    this.dispatch({ type: 'toggle-mute' });
  }

  toggleCamera() {
    if (this.state.phase !== CALL_PHASE.ACTIVE) return;
    if (!(this.localCapabilities.video || []).length) {
      this.deps.toast?.(VIDEO_LOCAL_UNSUPPORTED_HINT);
      return;
    }
    if (!peerSupportsVideo(this.state.remoteCapabilities)) {
      this.deps.toast?.(VIDEO_PEER_UNSUPPORTED_HINT);
      return;
    }
    this.dispatch({
      type: 'local-camera',
      on: !this.state.localCamera,
      now: Date.now(),
      callId: this.state.callId,
      peerId: this.state.peerId,
    });
  }

  toggleScreen() {
    if (this.state.phase !== CALL_PHASE.ACTIVE) return;
    if (!(this.localCapabilities.video || []).length) {
      this.deps.toast?.(VIDEO_LOCAL_UNSUPPORTED_HINT);
      return;
    }
    if (!peerSupportsVideo(this.state.remoteCapabilities)) {
      this.deps.toast?.(VIDEO_PEER_UNSUPPORTED_HINT);
      return;
    }
    this.dispatch({
      type: 'local-screen',
      on: !this.state.localScreen,
      now: Date.now(),
      callId: this.state.callId,
      peerId: this.state.peerId,
    });
  }

  handlePeerDisconnected(peerId) {
    if (this.state.peerId !== peerId || this.state.phase === CALL_PHASE.IDLE) return;
    this.dispatch({
      type: 'connection-lost',
      now: Date.now(),
      callId: this.state.callId,
      peerId,
    });
  }

  /**
   * Wird aus peerMessageHandler aufgerufen — für call-audio/video ohne React-Update.
   */
  handleInbound(fromId, msg) {
    if (!fromId || !msg) return;
    if (msg.fromDevice != null && msg.fromDevice !== '') {
      const fromDevice = boundedString(msg.fromDevice, CALL_DEVICE_KEY_MAX_LEN);
      if (!fromDevice) return;
      if (shouldDropBoundMessage(this.state.remoteDevice, fromDevice)) return;
    }

    if (msg.kind === 'call-audio') {
      const audio = sanitizeCallAudio(msg);
      if (!audio) return;
      if (this.state.phase !== CALL_PHASE.ACTIVE) return;
      if (audio.callId !== this.state.callId || fromId !== this.state.peerId) return;
      this.state.lastHeardAt = Date.now();
      this.pipeline?.pushRemotePacket(audio.seq, audio.data);
      return;
    }
    if (msg.kind === 'call-video') {
      const video = sanitizeCallVideo(msg);
      if (!video) return;
      this.handleVideoPacket(fromId, video);
      return;
    }
    if (msg.kind === 'call-offer') {
      const offer = sanitizeCallOffer(msg);
      if (!offer) return;
      this.handleOffer(fromId, offer);
      return;
    }
    if (msg.kind === 'call-signal') {
      const signal = sanitizeCallSignal(msg);
      if (!signal) return;
      this.handleSignal(fromId, signal);
    }
  }

  handleVideoPacket(fromId, msg) {
    if (this.state.phase !== CALL_PHASE.ACTIVE) return;
    if (msg.callId !== this.state.callId || fromId !== this.state.peerId) return;
    this.state.lastHeardAt = Date.now();
    const stream = msg.stream === 'screen' ? 'screen' : 'camera';
    if (stream === 'screen' && !this.state.remoteScreen) {
      this.dispatch({
        type: 'remote-screen',
        on: true,
        now: Date.now(),
        callId: this.state.callId,
        peerId: this.state.peerId,
        fromDevice: msg.fromDevice,
      });
    } else if (stream === 'camera' && !this.state.remoteCamera) {
      this.dispatch({
        type: 'remote-camera',
        on: true,
        now: Date.now(),
        callId: this.state.callId,
        peerId: this.state.peerId,
        fromDevice: msg.fromDevice,
      });
    }
    let packet = msg;
    if (msg.desc && typeof msg.desc === 'string') {
      try {
        packet = { ...msg, desc: base64ToBytes(msg.desc) };
      } catch {
        packet = { ...msg, desc: undefined };
      }
    }
    const renderer = this.inbound[stream];
    if (renderer) {
      void renderer.pushRemotePacket(packet);
      return;
    }
    void this.ensureInbound(stream).then((next) => next?.pushRemotePacket?.(packet));
  }

  handleOffer(fromId, msg) {
    const blocked = this.deps.isBlocked?.(fromId) === true;
    this.dispatch({
      type: 'remote-offer',
      peerId: fromId,
      callId: msg.callId,
      callKeyB64: msg.callKeyB64,
      codecs: msg.codecs,
      timestamp: msg.timestamp,
      media: msg.media,
      capabilities: msg.capabilities,
      fromDevice: msg.fromDevice,
      blocked,
      now: Date.now(),
    });
  }

  handleSignal(fromId, msg) {
    const now = Date.now();
    const base = { peerId: fromId, callId: msg.callId, now, fromDevice: msg.fromDevice };
    switch (msg.op) {
      case 'ringing':
        this.dispatch({ type: 'remote-ringing', capabilities: msg.capabilities, ...base });
        break;
      case 'accept':
        this.dispatch({ type: 'remote-accept', codec: msg.codec, capabilities: msg.capabilities, ...base });
        break;
      case 'reject':
        this.dispatch({ type: 'remote-reject', ...base });
        break;
      case 'busy':
        this.dispatch({ type: 'remote-busy', ...base });
        break;
      case 'cancel':
        this.dispatch({ type: 'remote-cancel', reason: msg.reason, ...base });
        break;
      case 'end':
        this.dispatch({ type: 'remote-end', ...base });
        break;
      case 'video-on':
        this.dispatch({ type: 'remote-camera', on: true, ...base });
        break;
      case 'video-off':
        this.dispatch({ type: 'remote-camera', on: false, ...base });
        break;
      case 'screen-on':
        this.dispatch({ type: 'remote-screen', on: true, ...base });
        break;
      case 'screen-off':
        this.dispatch({ type: 'remote-screen', on: false, ...base });
        break;
      case 'keyframe':
        this.forceLocalKeyframe(msg.stream === 'screen' ? 'screen' : 'camera');
        break;
      case 'ping':
        if (this.state.callId === msg.callId && this.state.peerId === fromId) {
          this.state = { ...this.state, lastHeardAt: now };
          this.sendSignal({ op: 'pong', t: msg.t });
        }
        break;
      case 'pong':
        this.dispatch({ type: 'pong', t: msg.t, ...base });
        break;
      default:
        break;
    }
  }

  forceLocalKeyframe(stream) {
    if (stream === 'screen') this.screenOut?.requestKeyNow?.();
    else this.cameraOut?.requestKeyNow?.();
  }

  runEffect(effect) {
    switch (effect.type) {
      case 'send-offer':
        void this.sendOffer();
        break;
      case 'send-signal':
        this.sendSignal({
          op: effect.op,
          codec: effect.codec,
          callId: effect.callId,
          peerId: effect.peerId,
          deviceKey: effect.deviceKey,
          stream: effect.stream,
          reason: effect.reason,
          capabilities: effect.capabilities,
        });
        break;
      case 'cancel-other-devices':
        this.cancelOtherDevices(effect);
        break;
      case 'arm-ring-timeout':
        this.clearTimer('ringTimer');
        this.ringTimer = window.setTimeout(() => {
          this.dispatch({
            type: 'ring-timeout',
            now: Date.now(),
            callId: this.state.callId,
            peerId: this.state.peerId,
          });
        }, RING_TIMEOUT_MS);
        break;
      case 'arm-watchdog':
        this.clearTimer('watchdogTimer');
        this.watchdogTimer = window.setInterval(() => {
          if (this.state.phase !== CALL_PHASE.ACTIVE) return;
          if (Date.now() - (this.state.lastHeardAt || 0) >= CALL_WATCHDOG_MS) {
            this.dispatch({
              type: 'connection-lost',
              now: Date.now(),
              callId: this.state.callId,
              peerId: this.state.peerId,
            });
          }
        }, 1000);
        break;
      case 'start-ping':
        this.clearTimer('pingTimer');
        this.pingTimer = window.setInterval(() => {
          if (this.state.phase !== CALL_PHASE.ACTIVE) return;
          this.sendSignal({ op: 'ping', t: Date.now() });
        }, CALL_PING_MS);
        break;
      case 'clear-timers':
        this.clearAllTimers();
        break;
      case 'start-ringtone':
        this.ringback.stop();
        void this.ringtone.start();
        break;
      case 'start-ringback':
        this.ringtone.stop();
        void this.ringback.start();
        break;
      case 'stop-ringtone':
        this.ringtone.stop();
        this.ringback.stop();
        break;
      case 'start-media':
        void this.startMedia();
        break;
      case 'stop-media':
        this.mediaGeneration += 1;
        this.videoStartGen.camera += 1;
        this.videoStartGen.screen += 1;
        void this.stopMedia();
        break;
      case 'start-camera':
        void this.startOutgoingVideo('camera');
        break;
      case 'stop-camera':
        this.videoStartGen.camera += 1;
        void this.stopOutgoingVideo('camera');
        break;
      case 'start-screen':
        void this.startOutgoingVideo('screen');
        break;
      case 'stop-screen':
        this.videoStartGen.screen += 1;
        void this.stopOutgoingVideo('screen');
        break;
      case 'apply-mute':
        this.pipeline?.setMuted(this.state.muted);
        this.emit();
        break;
      case 'notify-incoming':
        this.deps.notifyIncoming?.(this.state.peerId, this.state.media);
        break;
      case 'call-log':
        void this.deps.appendCallLog?.(effect);
        break;
      case 'toast':
        this.deps.toast?.(effect.message);
        break;
      default:
        break;
    }
  }

  async sendOffer() {
    const s = this.state;
    if (!s.peerId || !s.callId) return;
    let ok = false;
    try {
      ok = await this.deps.sendPairwiseEncrypted?.(s.peerId, {
        kind: 'call-offer',
        callId: s.callId,
        callKeyB64: s.callKeyB64,
        codecs: s.codecs,
        timestamp: Date.now(),
        sender: this.deps.getDisplayName?.() || '',
        media: s.media || { video: false },
        capabilities: this.localCapabilities,
      }) === true;
    } catch {
      ok = false;
    }
    if (this.state.callId !== s.callId || this.state.phase !== CALL_PHASE.OUTGOING) return;
    if (!ok) {
      this.dispatch({
        type: 'offer-failed',
        now: Date.now(),
        callId: s.callId,
        peerId: s.peerId,
      });
    }
  }

  sendSignal(fields) {
    const peerId = fields.peerId || this.state.peerId;
    const callId = fields.callId || this.state.callId;
    if (!peerId || !callId) return;
    const payload = {
      kind: 'call-signal',
      callId,
      op: fields.op,
    };
    if (fields.codec) payload.codec = fields.codec;
    if (Number.isFinite(fields.t)) payload.t = fields.t;
    if (fields.stream) payload.stream = fields.stream;
    if (fields.reason) payload.reason = fields.reason;
    if (fields.op === 'ringing' || fields.op === 'accept') {
      payload.capabilities = this.localCapabilities;
    }
    const deviceKey = fields.deviceKey !== undefined ? fields.deviceKey : this.state.remoteDevice;
    void this.deps.sendPeer?.(peerId, payload, deviceKey || undefined);
  }

  cancelOtherDevices(effect) {
    const peerId = effect.peerId || this.state.peerId;
    const callId = effect.callId || this.state.callId;
    if (!peerId || !callId) return;
    const payload = {
      kind: 'call-signal',
      callId,
      op: 'cancel',
      reason: 'answered-elsewhere',
    };
    const others = devicesToCancel(effect.ringingDevices, effect.exceptDevice);
    if (others.length && typeof this.deps.sendPeer === 'function') {
      for (const deviceKey of others) {
        void this.deps.sendPeer(peerId, payload, deviceKey);
      }
      return;
    }
    void this.deps.sendPeer?.(peerId, payload);
  }

  isCurrentMedia(generation, callId) {
    return this.mediaGeneration === generation
      && this.state.callId === callId
      && this.state.phase === CALL_PHASE.ACTIVE;
  }

  async startMedia() {
    const generation = this.mediaGeneration + 1;
    this.mediaGeneration = generation;
    const callId = this.state.callId;
    await this.stopMedia({ keepGeneration: true });
    if (!this.isCurrentMedia(generation, callId)) return;
    const s = this.state;
    try {
      this.callKey = await importCallKey(s.callKeyB64);
      if (!this.isCurrentMedia(generation, callId)) return;
      await this.ensureInbound('camera');
      await this.ensureInbound('screen');
      const pipeline = await createAudioPipeline({
        callKeyB64: s.callKeyB64,
        role: s.role,
        codec: s.codec,
        isCurrent: () => this.isCurrentMedia(generation, callId),
        sendAudio: (seq, data) => {
          if (this.state.phase !== CALL_PHASE.ACTIVE) return;
          this.audioInFlight += 1;
          const sent = this.deps.sendPeer?.(this.state.peerId, {
            kind: 'call-audio',
            callId: this.state.callId,
            seq,
            data,
          }, this.state.remoteDevice || undefined);
          Promise.resolve(sent).finally(() => {
            this.audioInFlight = Math.max(0, this.audioInFlight - 1);
          });
        },
        onError: (err) => {
          console.warn('[calls] audio', err);
        },
      });
      if (!this.isCurrentMedia(generation, callId)) {
        try { await pipeline.close(); } catch { /* ignore */ }
        return;
      }
      this.pipeline = pipeline;
      this.pipeline.setMuted(this.state.muted);
    } catch (err) {
      if (!this.isCurrentMedia(generation, callId)) return;
      if (err?.message === 'call_aborted') return;
      console.warn('[calls] media start failed', err);
      this.deps.toast?.('Mikrofon nicht verfügbar');
      this.dispatch({
        type: 'connection-lost',
        now: Date.now(),
        callId: s.callId,
        peerId: s.peerId,
      });
    }
  }

  async ensureInbound(streamKind) {
    const kind = streamKind === 'screen' ? 'screen' : 'camera';
    if (this.inbound[kind]) {
      this.inbound[kind].setSink?.(this.sinks[kind]);
      return this.inbound[kind];
    }
    if (!this.callKey || this.state.phase !== CALL_PHASE.ACTIVE) return null;
    const renderer = await createInboundVideoRenderer({
      streamKind: kind,
      callKey: this.callKey,
      role: this.state.role,
      codec: this.state.videoCodec,
      isCurrent: () => this.state.phase === CALL_PHASE.ACTIVE && this.state.callId != null,
      requestKeyframe: (stream) => {
        this.dispatch({
          type: 'local-keyframe',
          stream,
          now: Date.now(),
          callId: this.state.callId,
          peerId: this.state.peerId,
        });
      },
      onError: (err) => console.warn('[calls] video decode', err),
    });
    renderer.setSink?.(this.sinks[kind]);
    this.inbound[kind] = renderer;
    return renderer;
  }

  isCurrentVideo(kind, generation) {
    const flag = kind === 'screen' ? this.state.localScreen : this.state.localCamera;
    return this.videoStartGen[kind] === generation
      && this.state.phase === CALL_PHASE.ACTIVE
      && Boolean(flag);
  }

  async startOutgoingVideo(streamKind) {
    const kind = streamKind === 'screen' ? 'screen' : 'camera';
    const slot = kind === 'screen' ? 'screenOut' : 'cameraOut';
    const generation = this.videoStartGen[kind] + 1;
    this.videoStartGen[kind] = generation;
    if (this.state.phase !== CALL_PHASE.ACTIVE) return;
    if (!this.callKey) {
      try { this.callKey = await importCallKey(this.state.callKeyB64); } catch { return; }
    }
    if (!this.isCurrentVideo(kind, generation)) return;
    await this.stopOutgoingVideo(kind);
    if (!this.isCurrentVideo(kind, generation)) return;
    try {
      const direction = await createVideoDirection({
        streamKind: kind,
        callKey: this.callKey,
        role: this.state.role,
        codec: this.state.videoCodec || this.localCapabilities.video[0],
        isCurrent: () => this.isCurrentVideo(kind, generation),
        audioBusy: () => this.audioInFlight > 2,
        sendFragment: (fields) => this.sendVideoFragment(fields),
        requestKeyframe: (stream) => {
          this.dispatch({
            type: 'local-keyframe',
            stream,
            now: Date.now(),
            callId: this.state.callId,
            peerId: this.state.peerId,
          });
        },
        onEnded: () => {
          if (kind === 'screen' && this.state.localScreen) {
            this.dispatch({
              type: 'local-screen',
              on: false,
              now: Date.now(),
              callId: this.state.callId,
              peerId: this.state.peerId,
            });
          } else if (kind === 'camera' && this.state.localCamera) {
            this.dispatch({
              type: 'local-camera',
              on: false,
              now: Date.now(),
              callId: this.state.callId,
              peerId: this.state.peerId,
            });
          }
        },
        onError: (err) => console.warn('[calls] video encode', err),
      });
      if (!this.isCurrentVideo(kind, generation)) {
        try { await direction.close(); } catch { /* ignore */ }
        return;
      }
      this[slot] = direction;
      this.sendSignal({
        op: kind === 'screen' ? 'screen-on' : 'video-on',
        stream: kind,
      });
      this.emit();
    } catch (err) {
      if (err?.message === 'call_aborted') return;
      if (!this.isCurrentVideo(kind, generation)) return;
      console.warn('[calls] video start failed', err);
      this.deps.toast?.(kind === 'screen' ? 'Bildschirmfreigabe nicht verfügbar' : 'Kamera nicht verfügbar');
      this.dispatch({
        type: kind === 'screen' ? 'local-screen' : 'local-camera',
        on: false,
        now: Date.now(),
        callId: this.state.callId,
        peerId: this.state.peerId,
      });
    }
  }

  sendVideoFragment(fields) {
    if (this.state.phase !== CALL_PHASE.ACTIVE || !this.state.peerId) return;
    const payload = {
      kind: 'call-video',
      callId: this.state.callId,
      stream: fields.stream,
      seq: fields.seq,
      frag: fields.frag,
      frags: fields.frags,
      key: fields.key,
      ts: fields.ts,
      codec: fields.codec,
      w: fields.w,
      h: fields.h,
      data: fields.data,
    };
    if (fields.desc) payload.desc = bytesToBase64(fields.desc);
    void this.deps.sendPeer?.(this.state.peerId, payload, this.state.remoteDevice || undefined);
  }

  async stopOutgoingVideo(streamKind) {
    const kind = streamKind === 'screen' ? 'screen' : 'camera';
    const slot = kind === 'screen' ? 'screenOut' : 'cameraOut';
    const current = this[slot];
    this[slot] = null;
    if (current) {
      try { await current.close(); } catch { /* ignore */ }
    }
  }

  async stopMedia(options = {}) {
    if (!options.keepGeneration) {
      /* generation wird vom Effect erhöht */
    }
    await this.stopOutgoingVideo('camera');
    await this.stopOutgoingVideo('screen');
    const inboundCam = this.inbound.camera;
    const inboundScreen = this.inbound.screen;
    this.inbound = { camera: null, screen: null };
    try { await inboundCam?.close?.(); } catch { /* ignore */ }
    try { await inboundScreen?.close?.(); } catch { /* ignore */ }
    this.callKey = null;
    const pipe = this.pipeline;
    this.pipeline = null;
    if (pipe) {
      try { await pipe.close(); } catch { /* ignore */ }
    }
  }

  clearTimer(name) {
    if (this[name]) {
      clearTimeout(this[name]);
      clearInterval(this[name]);
      this[name] = 0;
    }
  }

  clearAllTimers() {
    this.clearTimer('ringTimer');
    this.clearTimer('watchdogTimer');
    this.clearTimer('pingTimer');
    this.ringtone.stop();
    this.ringback.stop();
  }

  destroy() {
    this.mediaGeneration += 1;
    this.videoStartGen.camera += 1;
    this.videoStartGen.screen += 1;
    this.clearAllTimers();
    void this.stopMedia();
    this.listeners.clear();
    this.state = createIdleCallState();
  }
}
