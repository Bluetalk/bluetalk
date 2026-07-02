import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Flag,
  Gamepad2,
  HelpCircle,
  LogOut,
  Maximize2,
  Minus,
  Play,
  RotateCcw,
  SquareStack,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import RaceScene from './racing3d/RaceScene';
import './RacingGamePage.css';

const PHASE_LABELS = {
  lobby: 'Übung',
  countdown: 'Countdown',
  racing: 'Rennen läuft',
  finished: 'Ergebnis',
};

const MEDALS = ['🥇', '🥈', '🥉'];
const SOUND_PREF_KEY = 'bt.racing.sound';

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const safeColor = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value) : '#38bdf8');

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = String(total % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function formatLap(ms) {
  if (!ms || ms <= 0) return '—';
  const sec = ms / 1000;
  const min = Math.floor(sec / 60);
  const rest = (sec - min * 60).toFixed(1).padStart(4, '0');
  return `${min}:${rest}`;
}

function trackCurve(track, distance) {
  const d = ((distance % track.length) + track.length) % track.length;
  const segment = (d / track.length) * track.turns.length;
  const i = Math.floor(segment) % track.turns.length;
  const t = segment - Math.floor(segment);
  const a = track.turns[i] || 0;
  const b = track.turns[(i + 1) % track.turns.length] || 0;
  return a + (b - a) * t;
}

function nearAny(track, list, progress, range) {
  return list.some((spot) => Math.abs((((progress - spot + track.length / 2) % track.length) - track.length / 2)) < range);
}

/**
 * Client-Prediction für das eigene Auto — MUSS die Physik-Konstanten aus
 * simulateHost() im Plugin (assets/bundled-plugins/racing-3d/ui.js) spiegeln.
 * Crashes werden bewusst nicht vorhergesagt; die Korrektur kommt vom Host.
 */
function predictCar(rp, input, track, dtMs) {
  const dt = Math.min(80, dtMs) / 1000;
  const offroad = Math.abs(rp.x) > track.width;
  const curve = trackCurve(track, rp.progress);
  const targetMax = (offroad ? 38 : 88) + (input.boost && rp.boostFuel > 0 ? 34 : 0);
  const accel = input.throttle ? 48 : 0;
  const brake = input.brake ? 76 : 0;
  const drag = offroad ? 15 : 7;
  rp.speed = clamp(rp.speed + (accel - brake - drag) * dt, 0, targetMax);
  const curvePush = curve * (0.10 + rp.speed / 620);
  rp.x = clamp(rp.x + ((input.steer || 0) * (0.8 + rp.speed / 90) - curvePush) * dt, -1.7, 1.7);
  if (input.boost && rp.boostFuel > 0 && !offroad) rp.boostFuel = clamp(rp.boostFuel - 34 * dt, 0, 100);
  else rp.boostFuel = clamp(rp.boostFuel + 10 * dt, 0, 100);
  if (nearAny(track, track.boosts, rp.progress, 55) && Math.abs(rp.x) < 0.42) {
    rp.speed = clamp(rp.speed + 42 * dt, 0, 130);
    rp.boostFuel = clamp(rp.boostFuel + 28 * dt, 0, 100);
  }
  rp.progress += rp.speed * dt;
}

// ---------- Streckengeometrie (Minimap & Vorschau) ----------

const trackPathCache = new Map();
function trackPolyline(track) {
  if (trackPathCache.has(track.id)) return trackPathCache.get(track.id);
  const steps = 220;
  const pts = [];
  let heading = 0;
  let px = 0;
  let py = 0;
  for (let i = 0; i < steps; i++) {
    const dist = (i / steps) * track.length;
    heading += trackCurve(track, dist) * 0.155;
    px += Math.sin(heading);
    py -= Math.cos(heading);
    pts.push([px, py]);
  }
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  for (const [x, y] of pts) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const norm = pts.map(([x, y]) => [(x - minX) / span, (y - minY) / span]);
  trackPathCache.set(track.id, norm);
  return norm;
}

function trackPreviewPath(track, size, pad = 7) {
  const pts = trackPolyline(track);
  const s = size - pad * 2;
  return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${(pad + x * s).toFixed(1)},${(pad + y * s).toFixed(1)}`).join('');
}

function roundedRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath(); ctx.rect(x, y, w, h);
}

// Minimap als eigenständiges 2D-Overlay (der Rest der Szene ist echtes 3D).
function drawMinimap2D(canvas, track, players, selfPeerId) {
  if (!canvas || !track) return;
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = 150;
  if (canvas.width !== size * dpr) { canvas.width = size * dpr; canvas.height = size * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(8,14,28,.62)';
  roundedRect(ctx, 0, 0, size, size, 14);
  ctx.fill();
  const pad = 16;
  const s = size - pad * 2;
  const pts = trackPolyline(track);
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const [nx, ny] = pts[i];
    if (i) ctx.lineTo(pad + nx * s, pad + ny * s);
    else ctx.moveTo(pad + nx * s, pad + ny * s);
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(226,232,240,.55)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
  const [sx, sy] = pts[0];
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(pad + sx * s - 2.5, pad + sy * s - 2.5, 5, 5);
  for (const p of players) {
    const idx = Math.floor(((((p.progress % track.length) + track.length) % track.length) / track.length) * pts.length) % pts.length;
    const [nx, ny] = pts[Math.max(0, idx)];
    const isSelf = p.peerId === selfPeerId;
    ctx.beginPath();
    ctx.arc(pad + nx * s, pad + ny * s, isSelf ? 5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = safeColor(p.color);
    ctx.fill();
    if (isSelf) { ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
}

// ---------- Sound (WebAudio, synthetisch — keine Assets nötig) ----------

function createAudioEngine() {
  let audioCtx = null;
  let master = null;
  let engineGain = null;
  let filter = null;
  let osc1 = null;
  let osc2 = null;
  let enabled = false;

  function ensureContext() {
    if (audioCtx) return true;
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return false;
      audioCtx = new Ctor();
      master = audioCtx.createGain();
      master.gain.value = 0.16;
      master.connect(audioCtx.destination);
      filter = audioCtx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      engineGain = audioCtx.createGain();
      engineGain.gain.value = 0;
      osc1 = audioCtx.createOscillator();
      osc1.type = 'sawtooth';
      osc1.frequency.value = 50;
      osc2 = audioCtx.createOscillator();
      osc2.type = 'square';
      osc2.frequency.value = 75;
      const osc2Gain = audioCtx.createGain();
      osc2Gain.gain.value = 0.35;
      osc1.connect(engineGain);
      osc2.connect(osc2Gain);
      osc2Gain.connect(engineGain);
      engineGain.connect(filter);
      filter.connect(master);
      osc1.start();
      osc2.start();
      return true;
    } catch {
      audioCtx = null;
      return false;
    }
  }

  return {
    get enabled() { return enabled; },
    setEnabled(value) {
      enabled = Boolean(value);
      if (enabled) {
        if (ensureContext() && audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
      } else if (engineGain) {
        engineGain.gain.value = 0;
      }
    },
    updateEngine({ speed = 0, boosting = false, racing = false }) {
      if (!enabled || !audioCtx || audioCtx.state !== 'running') return;
      const norm = clamp(speed / 130, 0, 1);
      const target = racing ? 0.04 + norm * 0.1 : 0;
      engineGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.08);
      osc1.frequency.setTargetAtTime(46 + norm * 160, audioCtx.currentTime, 0.06);
      osc2.frequency.setTargetAtTime((46 + norm * 160) * 1.5 + (boosting ? 40 : 0), audioCtx.currentTime, 0.06);
      filter.frequency.setTargetAtTime(420 + norm * 2200 + (boosting ? 900 : 0), audioCtx.currentTime, 0.09);
    },
    beep(freq = 660, duration = 0.12, volume = 0.24) {
      if (!enabled || !ensureContext()) return;
      if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {});
      try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.value = volume;
        gain.gain.setTargetAtTime(0, audioCtx.currentTime + duration * 0.6, 0.05);
        osc.connect(gain);
        gain.connect(master);
        osc.start();
        osc.stop(audioCtx.currentTime + duration + 0.25);
      } catch {
        /* ignore */
      }
    },
    crash() {
      if (!enabled || !ensureContext()) return;
      try {
        const len = Math.floor(audioCtx.sampleRate * 0.28);
        const buffer = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        const gain = audioCtx.createGain();
        gain.gain.value = 0.35;
        const crashFilter = audioCtx.createBiquadFilter();
        crashFilter.type = 'lowpass';
        crashFilter.frequency.value = 900;
        src.connect(crashFilter);
        crashFilter.connect(gain);
        gain.connect(master);
        src.start();
      } catch {
        /* ignore */
      }
    },
    dispose() {
      try {
        osc1?.stop();
        osc2?.stop();
        void audioCtx?.close();
      } catch {
        /* ignore */
      }
      audioCtx = null;
    },
  };
}

// ---------- Hooks ----------

function useRacingState() {
  const payloadRef = useRef(null);
  const [uiSnapshot, setUiSnapshot] = useState(null);
  const lastUiSetRef = useRef(0);
  const uiRefSnapshot = useRef(null);

  useEffect(() => {
    if (!window.bluetalk?.racing?.onState) return undefined;
    const off = window.bluetalk.racing.onState((payload) => {
      payloadRef.current = payload || null;
      const t = Date.now();
      const prev = uiRefSnapshot.current;
      const next = payload || null;
      const phaseChanged = prev?.state?.phase !== next?.state?.phase
        || Boolean(prev?.pendingRoom) !== Boolean(next?.pendingRoom)
        || prev?.hasRoom !== next?.hasRoom
        || Object.keys(prev?.state?.players || {}).length !== Object.keys(next?.state?.players || {}).length;
      if (phaseChanged || t - lastUiSetRef.current > 250 || !next) {
        lastUiSetRef.current = t;
        uiRefSnapshot.current = next;
        setUiSnapshot(next);
      }
    });
    window.bluetalk.racing.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.racing?.sendAction?.({ type: 'request_state' });
    }, 300);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.racing?.sendAction?.(payload);
  }, []);

  return { payloadRef, uiSnapshot, send };
}

function useRacingWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const bridge = window.bluetalk?.racing;
    if (!bridge?.isWindowMaximized || !bridge?.onWindowMaximizedChange) return undefined;
    let cancelled = false;
    void bridge.isWindowMaximized().then((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    const off = bridge.onWindowMaximizedChange((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return isMaximized;
}

// ---------- UI-Bausteine ----------

function TrackCard({ track, active, disabled, onSelect }) {
  return (
    <button
      type="button"
      className={`race-track-card${active ? ' race-track-card--active' : ''}`}
      disabled={disabled}
      onClick={() => onSelect(track.id)}
    >
      <svg className="race-track-preview" width="52" height="52" viewBox="0 0 52 52" aria-hidden>
        <path d={trackPreviewPath(track, 52)} fill="none" stroke={safeColor(track.palette[0])} strokeWidth="2.6" strokeLinecap="round" opacity="0.9" />
      </svg>
      <span className="race-track-card-info">
        <b>{track.name}</b>
        <span className="race-meta">{track.laps} Runden · {(track.length / 1000).toFixed(1)} km · {track.difficulty}</span>
      </span>
    </button>
  );
}

function IdleOverlay({ tracks, pendingRoom, onHost, onJoinPending, onDismissPending }) {
  const [selected, setSelected] = useState(tracks[0]?.id || 'alpine');
  return (
    <div className="race-idle">
      <div className="race-idle-card">
        <div className="race-start-mark" aria-hidden>🏎️</div>
        <h2>Trackmania 3D</h2>
        <p>Wähle eine Strecke und fahr sofort los. Mitfahrer können jederzeit beitreten.</p>
        {pendingRoom ? (
          <div className="race-pending">
            <b>Rennen gefunden: {pendingRoom.name || '3D Autorennen'}</b>
            <div className="race-actions">
              <button type="button" className="race-btn race-btn--primary" onClick={onJoinPending}>Beitreten</button>
              <button type="button" className="race-btn" onClick={onDismissPending}>Ignorieren</button>
            </div>
          </div>
        ) : null}
        <div className="race-idle-tracks">
          {tracks.map((track) => (
            <TrackCard key={track.id} track={track} active={selected === track.id} onSelect={setSelected} />
          ))}
        </div>
        <button type="button" className="race-btn race-btn--primary race-btn--big" onClick={() => onHost(selected)}>
          <Play size={17} style={{ verticalAlign: 'text-bottom', marginRight: 7 }} />
          Losfahren
        </button>
      </div>
    </div>
  );
}

function SidePanel({ snapshot, send, onLeave, onClose }) {
  const raceState = snapshot?.state;
  const isHost = snapshot?.isHost;
  const tracks = snapshot?.tracks || [];
  const selfPeerId = snapshot?.selfPeerId;
  const track = tracks.find((t) => t.id === raceState?.trackId) || tracks[0];
  const players = useMemo(() => {
    const list = Object.values(raceState?.players || {});
    return list.sort((a, b) => {
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished) return -1;
      if (b.finished) return 1;
      const len = track?.length || 1;
      return ((b.lap - 1) * len + b.progress) - ((a.lap - 1) * len + a.progress);
    });
  }, [raceState, track]);

  if (!raceState || !track) return null;
  const inLobby = raceState.phase === 'lobby';
  const totalLen = track.length * track.laps;

  return (
    <aside className="race-side">
      <div className="race-side-head">
        <span className="race-phase-chip">{PHASE_LABELS[raceState.phase] || raceState.phase}</span>
        <button type="button" className="race-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="race-meta race-room-id">Raum: <span className="race-invite-id">{raceState.roomId}</span></div>

      <h3>Strecke</h3>
      {inLobby && isHost ? (
        <div className="race-track-list">
          {tracks.map((t) => (
            <TrackCard
              key={t.id}
              track={t}
              active={raceState.trackId === t.id}
              onSelect={(trackId) => send({ type: 'select_track', trackId })}
            />
          ))}
        </div>
      ) : (
        <div className="race-track-current">
          <svg className="race-track-preview" width="52" height="52" viewBox="0 0 52 52" aria-hidden>
            <path d={trackPreviewPath(track, 52)} fill="none" stroke={safeColor(track.palette[0])} strokeWidth="2.6" strokeLinecap="round" opacity="0.9" />
          </svg>
          <span>
            <b>{track.name}</b>
            <span className="race-meta" style={{ display: 'block' }}>{track.laps} Runden · {(track.length / 1000).toFixed(1)} km · {track.difficulty}</span>
          </span>
        </div>
      )}

      <div className="race-actions">
        {isHost ? (
          <>
            <button
              type="button"
              className="race-btn race-btn--primary"
              disabled={!inLobby || players.length < 1}
              onClick={() => send({ type: 'start' })}
            >
              <Flag size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
              Rennen starten
            </button>
            <button type="button" className="race-btn" disabled={inLobby} onClick={() => send({ type: 'reset' })}>
              <RotateCcw size={14} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
              Zurück zur Übung
            </button>
          </>
        ) : (
          <p className="race-meta">{inLobby ? 'Freies Fahren — der Host startet das Rennen.' : null}</p>
        )}
        <button type="button" className="race-btn race-btn--danger" onClick={onLeave}>Rennen verlassen</button>
      </div>

      <h3>Fahrer ({players.length}/{raceState.maxPlayers || 8})</h3>
      <div className="race-players">
        {players.map((p, i) => {
          const pct = clamp(((p.lap - 1) * track.length + p.progress) / totalLen * 100, 0, 100);
          const right = p.finished
            ? formatMs(p.finishMs)
            : raceState.phase === 'racing'
              ? `R${Math.min(p.lap, track.laps)}/${track.laps}`
              : (p.connected === false ? 'offline' : 'bereit');
          return (
            <div className={`race-player${p.peerId === selfPeerId ? ' race-player--self' : ''}`} key={p.peerId}>
              <span className="race-rank">{i + 1}.</span>
              <span className="race-dot" style={{ background: safeColor(p.color), color: safeColor(p.color) }} />
              <div className="race-player-mid">
                <b>{p.name}</b>
                {p.bestLapMs > 0 ? <span className="race-meta"> Best {formatLap(p.bestLapMs)}</span> : null}
                <div className="race-bar"><span style={{ width: `${pct}%` }} /></div>
              </div>
              <span className="race-meta">{right}</span>
            </div>
          );
        })}
        {!players.length ? <div className="race-meta">Noch keine Fahrer.</div> : null}
      </div>

      {raceState.results?.length ? (
        <>
          <h3>Podium</h3>
          <div className="race-players">
            {raceState.results.map((r, i) => (
              <div className="race-result" key={r.peerId}>
                <span className="race-medal">{MEDALS[i] || `${i + 1}.`}</span>
                <b style={{ color: safeColor(r.color) }}>{r.name}</b>
                <span className="race-meta">
                  {formatMs(r.finishMs)}{r.bestLapMs > 0 ? ` · Best ${formatLap(r.bestLapMs)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </aside>
  );
}

function HelpOverlay({ onClose }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="race-overlay" role="presentation" onMouseDown={onClose}>
      <section className="race-overlay-panel" role="dialog" aria-modal="true" aria-label="Hilfe" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>So funktioniert das Rennen</h2>
          <button type="button" className="race-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="race-overlay-content">
          <ul>
            <li><kbd>W</kbd>/<kbd>↑</kbd> Gas · <kbd>S</kbd>/<kbd>↓</kbd> Bremse · <kbd>A</kbd>/<kbd>D</kbd> bzw. <kbd>←</kbd>/<kbd>→</kbd> lenken · <kbd>Space</kbd> Boost</li>
            <li>Gamepad: rechter Trigger Gas, linker Trigger Bremse, linker Stick lenken, A-Taste Boost.</li>
            <li>Fenster öffnen heißt sofort fahren — im Übungsmodus kannst du die Strecke frei lernen.</li>
            <li>Türkise Pads geben Tempo und Boost-Energie — Hütchen kosten Zeit. Abseits der Straße bist du langsamer.</li>
            <li>Über <Users size={13} style={{ verticalAlign: 'text-bottom' }} /> öffnest du Fahrer &amp; Rennstart; der Host startet das getimte Rennen.</li>
            <li>Das Rennen läuft weiter, wenn du dieses Fenster schließt — nur „Rennen verlassen" steigt wirklich aus.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

// ---------- Hauptseite ----------

export default function RacingGamePage() {
  const { payloadRef, uiSnapshot, send } = useRacingState();
  const isMaximized = useRacingWindowMaximized();
  const [showHelp, setShowHelp] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(() => {
    try { return localStorage.getItem(SOUND_PREF_KEY) === '1'; } catch { return false; }
  });

  const canvasRef = useRef(null);
  const minimapRef = useRef(null);
  const sceneRef = useRef(null);
  const speedRef = useRef(null);
  const boostRef = useRef(null);
  const posRef = useRef(null);
  const lapRef = useRef(null);
  const lapTimeRef = useRef(null);
  const centerRef = useRef(null);
  const keysRef = useRef({ throttle: 0, brake: 0, steer: 0, boost: 0 });
  const inputRef = useRef({ throttle: 0, brake: 0, steer: 0, boost: 0 });
  const lastInputSentRef = useRef(0);
  const lastInputJsonRef = useRef('');
  const simRef = useRef(new Map());
  const audioRef = useRef(null);
  const sfxRef = useRef({ lastCount: 0, wasRacing: false, crashedUntil: 0 });
  const lastMinimapRef = useRef(0);

  const hasRace = Boolean(uiSnapshot?.state);
  const showStage = Boolean(uiSnapshot);

  const closeWindow = useCallback(() => window.bluetalk?.racing?.closeGameWindow?.(), []);
  const leaveRace = useCallback(() => {
    send({ type: 'leave' });
    simRef.current.clear();
    setPanelOpen(false);
  }, [send]);

  const toggleSound = useCallback(() => {
    setSoundOn((prev) => {
      const next = !prev;
      try { localStorage.setItem(SOUND_PREF_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!audioRef.current) audioRef.current = createAudioEngine();
    audioRef.current.setEnabled(soundOn);
    if (!soundOn) return undefined;
    const unlock = () => audioRef.current?.setEnabled(true);
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [soundOn]);

  useEffect(() => () => audioRef.current?.dispose(), []);

  // Three.js-Szene aufbauen, sobald die Bühne im DOM ist
  useEffect(() => {
    if (!showStage || !canvasRef.current || sceneRef.current) return undefined;
    let scene;
    try {
      scene = new RaceScene(canvasRef.current);
    } catch (err) {
      console.error('RaceScene init failed:', err);
      return undefined;
    }
    sceneRef.current = scene;
    const onResize = () => scene.resize();
    window.addEventListener('resize', onResize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    if (ro && canvasRef.current.parentElement) ro.observe(canvasRef.current.parentElement);
    return () => {
      window.removeEventListener('resize', onResize);
      ro?.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [showStage]);

  // Tastatur
  useEffect(() => {
    const apply = (e, on) => {
      const keys = keysRef.current;
      let handled = false;
      if (['ArrowUp', 'w', 'W'].includes(e.key)) { keys.throttle = on ? 1 : 0; handled = true; }
      if (['ArrowDown', 's', 'S'].includes(e.key)) { keys.brake = on ? 1 : 0; handled = true; }
      if (['ArrowLeft', 'a', 'A'].includes(e.key)) { keys.steer = on ? -1 : (keys.steer < 0 ? 0 : keys.steer); handled = true; }
      if (['ArrowRight', 'd', 'D'].includes(e.key)) { keys.steer = on ? 1 : (keys.steer > 0 ? 0 : keys.steer); handled = true; }
      if (e.code === 'Space') { keys.boost = on ? 1 : 0; handled = true; }
      if (handled) e.preventDefault();
    };
    const down = (e) => apply(e, true);
    const up = (e) => apply(e, false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Render- & Input-Loop
  useEffect(() => {
    let raf = 0;
    let lastFrame = performance.now();

    const readGamepad = () => {
      try {
        const pads = navigator.getGamepads?.() || [];
        for (const pad of pads) {
          if (!pad || !pad.connected) continue;
          const stick = Math.abs(pad.axes[0] || 0) > 0.18 ? pad.axes[0] : 0;
          const rt = pad.buttons[7]?.value || (pad.buttons[7]?.pressed ? 1 : 0);
          const lt = pad.buttons[6]?.value || (pad.buttons[6]?.pressed ? 1 : 0);
          const a = pad.buttons[0]?.pressed ? 1 : 0;
          if (stick || rt > 0.1 || lt > 0.1 || a) {
            return {
              throttle: rt > 0.1 ? 1 : 0,
              brake: lt > 0.1 ? 1 : 0,
              steer: clamp(stick, -1, 1),
              boost: a,
            };
          }
        }
      } catch {
        /* Gamepad-API nicht verfügbar */
      }
      return null;
    };

    const sendInput = (input, t) => {
      const json = JSON.stringify(input);
      if (json !== lastInputJsonRef.current || t - lastInputSentRef.current > 120) {
        lastInputJsonRef.current = json;
        lastInputSentRef.current = t;
        send({ type: 'input', input });
      }
    };

    const setCenter = (text, cls) => {
      const el = centerRef.current;
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      el.className = `race-center${text ? ' race-center--show' : ''}${cls ? ` ${cls}` : ''}`;
    };

    const frame = (ts) => {
      const dtMs = Math.min(90, ts - lastFrame);
      lastFrame = ts;
      const t = Date.now();
      const payload = payloadRef.current;
      const raceState = payload?.state;
      const tracks = payload?.tracks || [];

      // Gamepad und Tastatur MISCHEN (nicht überschreiben): ein angeschlossenes
      // Gamepad mit Stick-Drift lieferte sonst dauerhaft throttle:0 und blockierte
      // die Tastatur — dann ließ sich gar nicht fahren.
      const pad = readGamepad();
      const keys = keysRef.current;
      const input = pad ? {
        throttle: pad.throttle || keys.throttle,
        brake: pad.brake || keys.brake,
        steer: pad.steer || keys.steer,
        boost: pad.boost || keys.boost,
      } : { ...keys };
      inputRef.current = input;
      if (raceState) sendInput(input, t);

      const scene = sceneRef.current;
      if (scene && raceState && tracks.length) {
        const track = tracks.find((tr) => tr.id === raceState.trackId) || tracks[0];
        const selfId = payload.selfPeerId;
        const driving = raceState.phase === 'racing' || raceState.phase === 'lobby';

        // --- Prediction / Smoothing ---
        const sim = simRef.current;
        const seen = new Set();
        const netAge = clamp((t - (payload.at || t)) / 1000, 0, 0.35);
        for (const player of Object.values(raceState.players || {})) {
          seen.add(player.peerId);
          let rp = sim.get(player.peerId);
          if (!rp) { rp = { ...player }; sim.set(player.peerId, rp); }
          const isSelf = player.peerId === selfId;
          rp.name = player.name;
          rp.color = player.color;
          rp.finished = player.finished;
          rp.finishMs = player.finishMs;
          rp.crashedUntil = player.crashedUntil;
          rp.lastLapMs = player.lastLapMs;
          rp.bestLapMs = player.bestLapMs;
          rp.lapStartedAt = player.lapStartedAt;
          if (driving && !player.finished) {
            const authDist = (player.lap - 1) * track.length + player.progress + player.speed * netAge;
            if (isSelf) {
              predictCar(rp, input, track, dtMs);
              const rpDist = (rp.lap - 1) * track.length + rp.progress;
              const err = authDist - rpDist;
              const corrected = Math.abs(err) > 140 ? authDist : rpDist + err * 0.10;
              rp.lap = Math.max(1, Math.floor(corrected / track.length) + 1);
              rp.progress = ((corrected % track.length) + track.length) % track.length;
              rp.x += (player.x - rp.x) * 0.08;
              rp.speed += (player.speed - rp.speed) * 0.08;
              rp.boostFuel += (player.boostFuel - rp.boostFuel) * 0.15;
            } else {
              const rpDist = (rp.lap - 1) * track.length + rp.progress + rp.speed * (dtMs / 1000);
              const err = authDist - rpDist;
              const corrected = Math.abs(err) > 160 ? authDist : rpDist + err * 0.22;
              rp.lap = Math.max(1, Math.floor(corrected / track.length) + 1);
              rp.progress = ((corrected % track.length) + track.length) % track.length;
              rp.x += (player.x - rp.x) * 0.22;
              rp.speed = player.speed;
              rp.boostFuel = player.boostFuel;
            }
          } else {
            Object.assign(rp, player);
          }
        }
        for (const key of sim.keys()) {
          if (!seen.has(key)) sim.delete(key);
        }

        try {
          scene.update({ track, sim, selfId, input, raceState, t });
        } catch (err) {
          console.error('RaceScene update error:', err);
        }

        // --- HUD ---
        const self = sim.get(selfId) || null;
        if (speedRef.current) speedRef.current.textContent = Math.round((self?.speed || 0) * 3.6);
        if (boostRef.current) boostRef.current.style.width = `${clamp(self?.boostFuel ?? 100, 0, 100)}%`;
        const ranked = [...sim.values()].sort((a, b) => {
          if (a.finished && b.finished) return a.finishMs - b.finishMs;
          if (a.finished) return -1;
          if (b.finished) return 1;
          return ((b.lap - 1) * track.length + b.progress) - ((a.lap - 1) * track.length + a.progress);
        });
        const myRank = ranked.findIndex((p) => p.peerId === selfId);
        if (posRef.current) {
          posRef.current.textContent = raceState.phase === 'racing' || raceState.phase === 'finished'
            ? (myRank >= 0 ? `P${myRank + 1}/${ranked.length}` : '—')
            : '🏁';
        }
        if (lapRef.current) {
          lapRef.current.textContent = raceState.phase === 'racing' || raceState.phase === 'finished'
            ? `Runde ${Math.min(self?.lap || 1, track.laps)}/${track.laps}`
            : `${track.name} · Übung`;
        }
        if (lapTimeRef.current) {
          if (raceState.phase === 'racing' && raceState.startedAt) {
            const lapNow = t - (self?.lapStartedAt || raceState.startedAt);
            lapTimeRef.current.textContent = `⏱ ${formatLap(lapNow)}${self?.bestLapMs > 0 ? ` · Best ${formatLap(self.bestLapMs)}` : ''}`;
          } else if (raceState.phase === 'finished' && self?.finishMs) {
            lapTimeRef.current.textContent = `Gesamt ${formatMs(self.finishMs)}`;
          } else {
            lapTimeRef.current.textContent = '';
          }
        }

        // --- Zentrale Einblendung (Countdown / GO / Ziel) ---
        if (raceState.phase === 'countdown') {
          const num = Math.max(1, Math.ceil((raceState.countdownEndsAt - t) / 1000));
          setCenter(String(num), 'race-center--count');
        } else if (raceState.phase === 'racing' && raceState.startedAt && t - raceState.startedAt < 1100) {
          setCenter('GO!', 'race-center--go');
        } else if (raceState.phase === 'finished') {
          setCenter('🏁 Rennen beendet', 'race-center--done');
        } else {
          setCenter('', '');
        }

        // --- Minimap (10 Hz reicht) ---
        if (t - lastMinimapRef.current > 100) {
          lastMinimapRef.current = t;
          drawMinimap2D(minimapRef.current, track, [...sim.values()], selfId);
        }

        // --- Sound ---
        const audio = audioRef.current;
        if (audio) {
          const sfx = sfxRef.current;
          audio.updateEngine({
            speed: self?.speed || 0,
            boosting: Boolean(input.boost && (self?.boostFuel || 0) > 0),
            racing: driving && !self?.finished,
          });
          if (raceState.phase === 'countdown') {
            const num = Math.max(1, Math.ceil((raceState.countdownEndsAt - t) / 1000));
            if (num !== sfx.lastCount) { sfx.lastCount = num; audio.beep(560, 0.11); }
            sfx.wasRacing = false;
          } else if (raceState.phase === 'racing') {
            if (!sfx.wasRacing) { sfx.wasRacing = true; sfx.lastCount = 0; audio.beep(940, 0.3, 0.3); }
            const crashedUntil = self?.crashedUntil || 0;
            if (crashedUntil > sfx.crashedUntil && crashedUntil > t) audio.crash();
            sfx.crashedUntil = crashedUntil;
          } else {
            sfx.wasRacing = false;
            sfx.lastCount = 0;
          }
        }
      } else {
        if (audioRef.current) audioRef.current.updateEngine({ speed: 0, racing: false });
        setCenter('', '');
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [payloadRef, send]);

  if (!uiSnapshot) {
    return (
      <div className="race-root">
        <main className="race-empty">
          <div className="race-start-mark" aria-hidden>🏎️</div>
          <h1>Rennstrecke wird vorbereitet…</h1>
          <p>Verbindung zum Renn-Plugin im Hauptfenster wird hergestellt.</p>
          <button type="button" className="race-btn" onClick={() => send({ type: 'request_state' })}>Erneut versuchen</button>
        </main>
      </div>
    );
  }

  const raceState = uiSnapshot.state;
  const trackName = raceState
    ? (uiSnapshot.tracks || []).find((t) => t.id === raceState.trackId)?.name || '3D Autorennen'
    : 'Trackmania 3D';

  return (
    <div className="race-root">
      <header className="race-titlebar">
        <div className="race-title">
          <h1>🏎️ {hasRace ? trackName : 'Trackmania 3D'}</h1>
          <div className="race-titlebar-sub">
            {hasRace ? (PHASE_LABELS[raceState.phase] || raceState.phase) : 'Bereit'}
            {uiSnapshot.isHost && hasRace ? ' · Du bist Host' : ''}
          </div>
        </div>
        <div className="race-titlebar-actions">
          {hasRace ? (
            <button type="button" className={`race-btn-icon${panelOpen ? ' race-btn-icon--active' : ''}`} title="Fahrer & Rennstart" onClick={() => setPanelOpen((v) => !v)}><Users size={16} /></button>
          ) : null}
          <button type="button" className="race-btn-icon" title={soundOn ? 'Ton aus' : 'Ton an'} onClick={toggleSound}>
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <button type="button" className="race-btn-icon" title="Hilfe" onClick={() => setShowHelp(true)}><HelpCircle size={16} /></button>
          {hasRace ? (
            <button type="button" className="race-btn-icon" title="Rennen verlassen" onClick={leaveRace}><LogOut size={16} /></button>
          ) : null}
          <button type="button" className="race-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.racing?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="race-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.racing?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="race-btn-icon" title="Fenster schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>

      <main className="race-main">
        <div className="race-stage">
          <canvas ref={canvasRef} className="race-canvas-3d" />
          <canvas ref={minimapRef} className="race-minimap" width="150" height="150" />
          <div className="race-center" ref={centerRef} />

          {hasRace ? (
            <>
              <div className="race-hud-pos">
                <b ref={posRef}>—</b>
                <span ref={lapRef}>—</span>
                <span ref={lapTimeRef} />
              </div>
              <div className="race-hud-bottom">
                <div className="race-gauge">
                  <div className="race-meta">Tempo</div>
                  <b ref={speedRef}>0</b><small>km/h</small>
                  <div className="race-boost-bar"><span ref={boostRef} style={{ width: '100%' }} /></div>
                </div>
                <div className="race-keys">
                  <kbd>W</kbd>/<kbd>↑</kbd> Gas · <kbd>S</kbd>/<kbd>↓</kbd> Bremse · <kbd>A</kbd>/<kbd>D</kbd> lenken · <kbd>Space</kbd> Boost
                  <br />
                  <span className="race-meta">Boost-Pads (türkis) mitnehmen, Hütchen ausweichen.</span>
                </div>
              </div>
            </>
          ) : null}

          {hasRace && panelOpen ? (
            <div className="race-drawer">
              <SidePanel snapshot={uiSnapshot} send={send} onLeave={leaveRace} onClose={() => setPanelOpen(false)} />
            </div>
          ) : null}

          {!hasRace ? (
            <IdleOverlay
              tracks={uiSnapshot.tracks || []}
              pendingRoom={uiSnapshot.pendingRoom}
              onHost={(trackId) => send({ type: 'host', trackId })}
              onJoinPending={() => send({ type: 'join_pending' })}
              onDismissPending={() => send({ type: 'dismiss_pending' })}
            />
          ) : null}

          {hasRace && uiSnapshot.pendingRoom ? (
            <div className="race-toast">
              <b>Rennen gefunden</b>
              <div className="race-actions">
                <button type="button" className="race-btn race-btn--primary" onClick={() => send({ type: 'join_pending' })}>Beitreten</button>
                <button type="button" className="race-btn" onClick={() => send({ type: 'dismiss_pending' })}>Später</button>
              </div>
            </div>
          ) : null}
        </div>
      </main>

      {showHelp ? <HelpOverlay onClose={() => setShowHelp(false)} /> : null}
    </div>
  );
}
