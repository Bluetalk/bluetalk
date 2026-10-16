import { newChatMessageId } from '../app/appHelpers.js';
import {
  CALL_PHASE,
  CALL_PING_MS,
  CALL_WATCHDOG_MS,
  RING_TIMEOUT_MS,
  createIdleCallState,
  reduceCall,
} from './callState.js';
import { generateCallKeyB64 } from './crypto.js';
import { codecIsOpusSupported, createAudioPipeline, pickAcceptCodec } from './audioPipeline.js';
import { createRingback, createRingtone } from './ringtone.js';
import { stopAllVoicePlayback } from '../voice/playbackController.js';

/**
 * Orchestriert Signalisierung, Timer und Audio. React hängt nur am Snapshot
 * (kein setState pro call-audio-Paket).
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
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot() {
    return this.state;
  }

  getLevels() {
    if (this.pipeline?.levels) return this.pipeline.levels;
    return this.levels;
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
      try { fn(this.state); } catch { /* ignore */ }
    }
  }

  async startCall(peerId) {
    if (!peerId || this.state.phase !== CALL_PHASE.IDLE) return false;
    stopAllVoicePlayback();
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
      now: Date.now(),
    });
    return true;
  }

  accept() {
    if (this.state.phase !== CALL_PHASE.INCOMING) return;
    void this.acceptAsync();
  }

  async acceptAsync() {
    const offered = this.state.codecs || ['opus', 'pcm16'];
    let codec = pickAcceptCodec(offered);
    if (codec === 'opus' && !(await codecIsOpusSupported())) codec = 'pcm16';
    if (!offered.includes(codec)) codec = offered.includes('pcm16') ? 'pcm16' : offered[0];
    stopAllVoicePlayback();
    this.dispatch({ type: 'local-accept', codec, now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  reject() {
    this.dispatch({ type: 'local-reject', now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  cancel() {
    this.dispatch({ type: 'local-cancel', now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  hangup() {
    if (this.state.phase === CALL_PHASE.OUTGOING) this.cancel();
    else if (this.state.phase === CALL_PHASE.INCOMING) this.reject();
    else this.dispatch({ type: 'local-end', now: Date.now(), callId: this.state.callId, peerId: this.state.peerId });
  }

  toggleMute() {
    this.dispatch({ type: 'toggle-mute' });
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
   * Wird aus peerMessageHandler aufgerufen — für call-audio ohne React-Update.
   */
  handleInbound(fromId, msg) {
    if (!fromId || !msg) return;
    if (msg.kind === 'call-audio') {
      if (this.state.phase !== CALL_PHASE.ACTIVE) return;
      if (msg.callId !== this.state.callId || fromId !== this.state.peerId) return;
      this.state.lastHeardAt = Date.now();
      this.pipeline?.pushRemotePacket(msg.seq, msg.data);
      return;
    }
    if (msg.kind === 'call-offer') {
      this.handleOffer(fromId, msg);
      return;
    }
    if (msg.kind === 'call-signal') {
      this.handleSignal(fromId, msg);
    }
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
      blocked,
      now: Date.now(),
    });
  }

  handleSignal(fromId, msg) {
    const now = Date.now();
    const base = { peerId: fromId, callId: msg.callId, now };
    switch (msg.op) {
      case 'ringing':
        this.dispatch({ type: 'remote-ringing', ...base });
        break;
      case 'accept':
        this.dispatch({ type: 'remote-accept', codec: msg.codec, ...base });
        break;
      case 'reject':
        this.dispatch({ type: 'remote-reject', ...base });
        break;
      case 'busy':
        this.dispatch({ type: 'remote-busy', ...base });
        break;
      case 'cancel':
        this.dispatch({ type: 'remote-cancel', ...base });
        break;
      case 'end':
        this.dispatch({ type: 'remote-end', ...base });
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

  runEffect(effect) {
    switch (effect.type) {
      case 'send-offer':
        void this.sendOffer();
        break;
      case 'send-signal':
        this.sendSignal({ op: effect.op, codec: effect.codec, callId: effect.callId, peerId: effect.peerId });
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
        void this.stopMedia();
        break;
      case 'apply-mute':
        this.pipeline?.setMuted(this.state.muted);
        this.emit();
        break;
      case 'notify-incoming':
        this.deps.notifyIncoming?.(this.state.peerId);
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
    await this.stopMedia();
    if (!this.isCurrentMedia(generation, callId)) return;
    const s = this.state;
    try {
      const pipeline = await createAudioPipeline({
        callKeyB64: s.callKeyB64,
        role: s.role,
        codec: s.codec,
        isCurrent: () => this.isCurrentMedia(generation, callId),
        sendAudio: (seq, data) => {
          if (this.state.phase !== CALL_PHASE.ACTIVE) return;
          void this.deps.sendPeer?.(this.state.peerId, {
            kind: 'call-audio',
            callId: this.state.callId,
            seq,
            data,
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

  async stopMedia() {
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
    this.clearAllTimers();
    void this.stopMedia();
    this.listeners.clear();
    this.state = createIdleCallState();
  }
}
