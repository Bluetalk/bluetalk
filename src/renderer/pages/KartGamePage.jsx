import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Crown,
  Flag,
  Globe,
  HelpCircle,
  Lock,
  LogOut,
  Maximize2,
  Minus,
  Play,
  RotateCcw,
  SquareStack,
  Trophy,
  UserPlus,
  UserX,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import './KartGamePage.css';
import { TRACKS, getTrack, buildTrackData, medalFor } from '../kart/tracks.js';
import { PLAYER_COLORS, colorOf } from '../kart/colors.js';
import { KartGame } from '../kart/KartGame.js';
import { createKartAudio } from '../kart/audio.js';

const PHASE_LABELS = {
  lobby: 'Lobby',
  countdown: 'Gleich geht’s los',
  racing: 'Rennen läuft',
  finished: 'Rennen beendet',
};

const ITEM_INFO = {
  turbo: { icon: '⚡', label: 'Turbo' },
  banana: { icon: '🍌', label: 'Banane' },
  rocket: { icon: '🚀', label: 'Rakete' },
  shield: { icon: '🛡️', label: 'Schild' },
};

const DIFFICULTY = ['', 'Leicht', 'Mittel', 'Schwer'];

const MEDAL_LABELS = { author: 'Autor', gold: 'Gold', silver: 'Silber', bronze: 'Bronze' };

const QUALITY_LABELS = { high: 'Hoch', medium: 'Mittel', low: 'Niedrig' };
const QUALITY_ORDER = ['high', 'medium', 'low'];

function readQuality() {
  try {
    const q = window.localStorage.getItem('bluekart.quality');
    return QUALITY_ORDER.includes(q) ? q : 'high';
  } catch {
    return 'high';
  }
}

function readPersonalBest(trackId) {
  try {
    const raw = window.localStorage.getItem(`bluekart.pb.${trackId}`);
    const d = raw ? JSON.parse(raw) : null;
    return d && d.lapMs > 0 ? d.lapMs : 0;
  } catch {
    return 0;
  }
}

/** Analoger Tacho (SVG): Bogen, Skala, Nadel. */
function SpeedGauge({ speed, ratio, max, boost, drift }) {
  const start = -220;
  const sweep = 260;
  const angle = start + sweep * Math.max(0, Math.min(1, ratio));
  const r = 62;
  const polar = (deg, rad) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [80 + rad * Math.cos(a), 80 + rad * Math.sin(a)];
  };
  const arc = (from, to, rad) => {
    const [x1, y1] = polar(from, rad);
    const [x2, y2] = polar(to, rad);
    const large = to - from > 180 ? 1 : 0;
    return `M ${x1} ${y1} A ${rad} ${rad} 0 ${large} 1 ${x2} ${y2}`;
  };
  const ticks = [];
  for (let k = 0; k <= 10; k += 1) {
    const deg = start + (sweep * k) / 10;
    const [x1, y1] = polar(deg, r - 2);
    const [x2, y2] = polar(deg, r - (k % 2 === 0 ? 12 : 7));
    ticks.push(<line key={k} x1={x1} y1={y1} x2={x2} y2={y2} />);
  }
  const [nx, ny] = polar(angle, r - 14);
  return (
    <div className={`kt-gauge${boost ? ' boost' : ''}`}>
      <svg viewBox="0 0 160 160" aria-hidden>
        <path d={arc(start, start + sweep, r)} className="kt-gauge-track" />
        <path d={arc(start, Math.max(start + 0.5, angle), r)} className="kt-gauge-fill" />
        <path d={arc(start + sweep * 0.82, start + sweep, r + 6)} className="kt-gauge-red" />
        <g className="kt-gauge-ticks">{ticks}</g>
        <line x1="80" y1="80" x2={nx} y2={ny} className="kt-gauge-needle" />
        <circle cx="80" cy="80" r="6" className="kt-gauge-hub" />
      </svg>
      <div className="kt-gauge-value">
        <b>{speed}</b>
        <span>km/h</span>
      </div>
      <small className="kt-gauge-max">{max}</small>
      {drift > 1 ? <div className={`kt-drift lvl${drift - 1}`}>DRIFT {'⚡'.repeat(drift - 1)}</div> : null}
    </div>
  );
}

const ROULETTE = ['⚡', '🍌', '🚀', '🛡️'];

function MedalChip({ medal, time, dim }) {
  return (
    <span className={`kt-medal kt-medal-${medal}${dim ? ' dim' : ''}`} title={`${MEDAL_LABELS[medal]}-Medaille`}>
      <i aria-hidden />{MEDAL_LABELS[medal]}{time ? <b>{formatTime(time)}</b> : null}
    </span>
  );
}

const EMPTY_HUD = {
  state: 'idle', speed: 0, speedRatio: 0, lap: 1, laps: 3, rank: 1, total: 1, item: null, itemRoll: false,
  countdown: 0, banner: '', time: 0, bestLap: 0, lastLap: 0, wrongWay: false, boost: false, drift: 0,
  spinning: false, finished: false, finishTime: 0, board: [], fast: 0,
  trial: false, lapTime: 0, pbLap: 0, medal: null, medalLimits: null, split: null,
};

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '–:––.––';
  const total = Math.floor(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const c = Math.floor((total % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Zustand aus dem Hauptfenster
// ---------------------------------------------------------------------------

function useKartState() {
  const [pub, setPub] = useState(null);
  const [inviteCandidates, setInviteCandidates] = useState([]);
  const [selfId, setSelfId] = useState('');
  const pubKey = useRef('');
  const invKey = useRef('');
  const netRef = useRef(null);
  const subs = useRef(new Set());

  useEffect(() => {
    let cancelled = false;
    void window.bluetalk?.peer?.getInfo?.().then((info) => {
      if (!cancelled && info?.id) setSelfId(info.id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const api = window.bluetalk?.kart;
    if (!api?.onState) return undefined;
    const off = api.onState((payload) => {
      if (!payload?.public) {
        pubKey.current = '';
        setPub(null);
        return;
      }
      const key = JSON.stringify(payload.public);
      if (key !== pubKey.current) {
        pubKey.current = key;
        setPub(payload.public);
      }
      if (payload.inviteCandidates) {
        const k2 = JSON.stringify(payload.inviteCandidates);
        if (k2 !== invKey.current) {
          invKey.current = k2;
          setInviteCandidates(payload.inviteCandidates);
        }
      }
      if (payload.cars) {
        netRef.current = { cars: payload.cars, x: payload.x };
        for (const fn of subs.current) fn(netRef.current);
      }
    });
    api.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => api.sendAction?.({ type: 'request_state' }), 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.kart?.sendAction?.(payload);
  }, []);

  // Solange kein Zustand vorliegt (z. B. nach einem Live-Reload des Fensters),
  // regelmäßig beim Hauptfenster nachfragen.
  useEffect(() => {
    if (pub) return undefined;
    const timer = setInterval(() => window.bluetalk?.kart?.sendAction?.({ type: 'request_state' }), 1000);
    return () => clearInterval(timer);
  }, [pub]);

  const subscribeNet = useCallback((fn) => {
    subs.current.add(fn);
    if (netRef.current) fn(netRef.current);
    return () => subs.current.delete(fn);
  }, []);

  return {
    pub,
    selfId,
    inviteCandidates,
    isHost: Boolean(selfId && pub?.hostPeerId === selfId),
    send,
    subscribeNet,
  };
}

function useWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    const api = window.bluetalk?.kart;
    if (!api?.isWindowMaximized || !api?.onWindowMaximizedChange) return undefined;
    let cancelled = false;
    void api.isWindowMaximized().then((value) => { if (!cancelled) setIsMaximized(Boolean(value)); });
    const off = api.onWindowMaximizedChange((value) => { if (!cancelled) setIsMaximized(Boolean(value)); });
    return () => { cancelled = true; off?.(); };
  }, []);
  return isMaximized;
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

function TrackThumb({ track }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const data = buildTrackData(track);
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (let i = 0; i < data.N; i += 1) {
      minX = Math.min(minX, data.px[i]); maxX = Math.max(maxX, data.px[i]);
      minZ = Math.min(minZ, data.pz[i]); maxZ = Math.max(maxZ, data.pz[i]);
    }
    const pad = 12;
    const scale = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
    const offX = (size - (maxX - minX) * scale) / 2;
    const offZ = (size - (maxZ - minZ) * scale) / 2;
    ctx.clearRect(0, 0, size, size);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const trace = () => {
      ctx.beginPath();
      for (let i = 0; i <= data.N; i += 4) {
        const k = i % data.N;
        const x = offX + (data.px[k] - minX) * scale;
        const y = offZ + (data.pz[k] - minZ) * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    };
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 9;
    trace();
    ctx.stroke();
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 6;
    trace();
    ctx.stroke();
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(offX + (data.px[0] - minX) * scale, offZ + (data.pz[0] - minZ) * scale, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }, [track]);
  return <canvas ref={ref} width={150} height={150} className="kt-thumb" aria-hidden />;
}

function Stepper({ label, value, min, max, onChange, disabled, suffix = '' }) {
  return (
    <div className="kt-stepper">
      <span className="kt-stepper-label">{label}</span>
      <div className="kt-stepper-ctrl">
        <button type="button" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={`${label} verringern`}>−</button>
        <b>{value}{suffix}</b>
        <button type="button" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={`${label} erhöhen`}>+</button>
      </div>
    </div>
  );
}

function Lobby({ pub, selfId, isHost, inviteCandidates, send }) {
  const settings = pub.settings || {};
  const players = pub.players || [];
  const me = players.find((p) => p.peerId === selfId);
  const takenColors = new Set(players.filter((p) => !p.bot && p.peerId !== selfId).map((p) => p.color));
  const humans = players.filter((p) => !p.bot);
  const update = (patch) => send({ type: 'update_settings', settings: patch });

  return (
    <div className="kt-lobby">
      <section className="kt-panel kt-tracks">
        <header className="kt-panel-head">
          <h2><Flag size={15} /> Strecke</h2>
          <span>{isHost ? 'Wähle die Strecke für das nächste Rennen' : 'Der Host wählt die Strecke'}</span>
        </header>
        <div className="kt-track-grid">
          {TRACKS.map((track) => {
            const active = settings.trackId === track.id;
            return (
              <button
                key={track.id}
                type="button"
                className={`kt-track-card kt-theme-${track.theme}${active ? ' active' : ''}`}
                disabled={!isHost}
                onClick={() => update({ trackId: track.id })}
              >
                <TrackThumb track={track} />
                <div className="kt-track-meta">
                  <strong>{track.name}</strong>
                  <span className="kt-diff">{DIFFICULTY[track.difficulty]}</span>
                  {(() => {
                    const pb = readPersonalBest(track.id);
                    const medal = pb ? medalFor(track, pb) : null;
                    return pb ? (
                      <span className="kt-track-pb" title="Deine beste Runde im Zeitfahren">
                        {medal ? <i className={`kt-pb-dot kt-medal-${medal}`} aria-hidden /> : null}
                        ⏱ {formatTime(pb)}
                      </span>
                    ) : null;
                  })()}
                  <p>{track.blurb}</p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <aside className="kt-side">
        <section className="kt-panel">
          <header className="kt-panel-head">
            <h2>Fahrer <small>{humans.length}/{settings.maxPlayers || 8}</small></h2>
          </header>
          <ul className="kt-players">
            {players.map((p) => (
              <li key={p.peerId} className={p.connected === false ? 'off' : ''}>
                <span className="kt-dot" style={{ background: colorOf(p.color).hex }} />
                <span className="kt-pname">
                  {p.name}{p.peerId === selfId ? ' (du)' : ''}
                </span>
                {p.bot ? <span className="kt-tag"><Bot size={11} /> Bot</span> : null}
                {p.peerId === pub.hostPeerId ? <Crown size={13} className="kt-crown" aria-label="Host" /> : null}
                {isHost && !p.bot && p.peerId !== selfId ? (
                  <button type="button" className="kt-icon-btn" title="Entfernen" onClick={() => send({ type: 'kick_player', peerId: p.peerId })}>
                    <UserX size={14} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {me ? (
            <div className="kt-colors" role="group" aria-label="Kartfarbe">
              {PLAYER_COLORS.map((c, i) => {
                const taken = takenColors.has(i) || players.some((p) => p.bot && p.color === i);
                return (
                  <button
                    key={c.name}
                    type="button"
                    title={c.name}
                    className={`kt-swatch${me.color === i ? ' active' : ''}`}
                    style={{ background: c.hex }}
                    disabled={taken && me.color !== i}
                    onClick={() => send({ type: 'set_color', color: i })}
                  />
                );
              })}
            </div>
          ) : null}
        </section>

        <section className="kt-panel">
          <header className="kt-panel-head"><h2>Modus</h2></header>
          <div className="kt-settings">
            <div className="kt-access">
              <button type="button" disabled={!isHost} className={settings.mode === 'trial' ? '' : 'active'} onClick={() => update({ mode: 'race' })}>Rennen</button>
              <button type="button" disabled={!isHost} className={settings.mode === 'trial' ? 'active' : ''} onClick={() => update({ mode: 'trial' })}>Zeitfahren</button>
            </div>
            <p className="kt-muted">
              {settings.mode === 'trial'
                ? 'Wie Trackmania: Geisterautos ohne Kollisionen, keine Items, Zwischenzeiten, Medaillen und dein Bestzeit-Geist. Enter startet sofort neu.'
                : 'Klassisches Kartrennen mit Items, Kollisionen und Boost-Feldern.'}
            </p>
            <Stepper label="Runden" value={settings.laps || 3} min={1} max={5} disabled={!isHost} onChange={(v) => update({ laps: v })} />
            <Stepper label="Bots" value={settings.bots ?? 0} min={0} max={7} disabled={!isHost} onChange={(v) => update({ bots: v })} />
            <label className="kt-check">
              <input type="checkbox" checked={settings.mode !== 'trial' && settings.items !== false} disabled={!isHost || settings.mode === 'trial'} onChange={(e) => update({ items: e.target.checked })} />
              <span>Items (Bananen, Raketen, Turbo, Schild)</span>
            </label>
            <div className="kt-access">
              <button type="button" disabled={!isHost} className={settings.lobbyAccess === 'public' ? '' : 'active'} onClick={() => update({ lobbyAccess: 'invite' })}><Lock size={12} /> Nur Einladung</button>
              <button type="button" disabled={!isHost} className={settings.lobbyAccess === 'public' ? 'active' : ''} onClick={() => update({ lobbyAccess: 'public' })}><Globe size={12} /> Öffentlich</button>
            </div>
          </div>
        </section>

        {isHost ? (
          <section className="kt-panel">
            <header className="kt-panel-head"><h2>Freunde einladen</h2></header>
            {inviteCandidates.length === 0 ? (
              <p className="kt-muted">Keine verbundenen Kontakte verfügbar.</p>
            ) : (
              <ul className="kt-invites">
                {inviteCandidates.map((c) => (
                  <li key={c.peerId}>
                    <span>{c.name}</span>
                    <button type="button" className="kt-btn kt-btn-small" onClick={() => send({ type: 'invite', peerId: c.peerId })}>
                      <UserPlus size={13} /> Einladen
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <div className="kt-start">
          {pub.message ? <p className="kt-muted">{pub.message}</p> : null}
          {isHost ? (
            <button type="button" className="kt-btn kt-btn-primary" onClick={() => send({ type: 'host_start' })}>
              <Play size={16} /> Rennen starten
            </button>
          ) : (
            <p className="kt-wait">Warte auf den Host…</p>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rennen
// ---------------------------------------------------------------------------

function Controls({ trial }) {
  return (
    <div className="kt-controls">
      <div><kbd>W</kbd><kbd>↑</kbd> Gas</div>
      <div><kbd>S</kbd><kbd>↓</kbd> Bremsen / Rückwärts</div>
      <div><kbd>A</kbd><kbd>D</kbd><kbd>←</kbd><kbd>→</kbd> Lenken</div>
      <div><kbd>Leertaste</kbd> / <kbd>Shift</kbd> Driften — loslassen = Mini-Turbo</div>
      {trial ? (
        <>
          <div><kbd>Enter</kbd> Sofort neu starten</div>
          <div><kbd>R</kbd> / <kbd>Rück</kbd> Zurück zum letzten Checkpoint</div>
        </>
      ) : (
        <>
          <div><kbd>E</kbd> / <kbd>Strg</kbd> Item benutzen</div>
          <div><kbd>R</kbd> Zurück auf die Strecke</div>
        </>
      )}
    </div>
  );
}

function RaceScreen({ pub, selfId, isHost, send, subscribeNet, audio, quality, onToggleHelp, showHelp }) {
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const containerRef = useRef(null);
  const minimapRef = useRef(null);
  const gameRef = useRef(null);
  const [liveHud, setHud] = useState(null);
  const hud = liveHud || EMPTY_HUD;

  const settings = pub.settings || {};
  const playersKey = useMemo(
    () => JSON.stringify((pub.players || []).map((p) => [p.peerId, p.name, p.color, p.bot])),
    [pub.players],
  );

  useEffect(() => {
    if (!selfId || !containerRef.current) return undefined;
    const canvas = document.createElement('canvas');
    canvas.className = 'kt-canvas';
    containerRef.current.appendChild(canvas);
    const game = new KartGame({
      canvas,
      minimap: minimapRef.current,
      trackId: pub.trackId || settings.trackId,
      laps: settings.laps || 3,
      selfId,
      isHost,
      itemsEnabled: settings.items !== false,
      mode: settings.mode === 'trial' ? 'trial' : 'race',
      quality: qualityRef.current,
      audio,
      players: (pub.players || []).map((p) => ({ id: p.peerId, name: p.name, color: p.color, bot: p.bot })),
      onHud: setHud,
      onEvent: (ev) => {
        if (ev.type === 'send') send({ type: 'car', ...ev.payload });
        else if (ev.type === 'hit') send({ type: 'hit', hid: ev.hid });
        else if (ev.type === 'finish') send({ type: 'finish', id: ev.id, timeMs: ev.timeMs, bestLapMs: ev.bestLapMs });
      },
    });
    gameRef.current = game;
    game.startRace(pub.raceId, pub.goAt || Date.now() + 3000);
    const off = subscribeNet((net) => game.applyNet(net));
    return () => {
      off();
      game.dispose();
      gameRef.current = null;
      canvas.remove();
    };
    // Ein Spiel pro Rennen; Spieler-Änderungen laufen über setPlayers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pub.raceId, selfId]);

  useEffect(() => {
    gameRef.current?.setPlayers((pub.players || []).map((p) => ({ id: p.peerId, name: p.name, color: p.color, bot: p.bot })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playersKey]);

  useEffect(() => {
    if (pub.phase === 'finished') gameRef.current?.endRace();
  }, [pub.phase]);

  const results = pub.results || [];
  const showResults = pub.phase === 'finished' && results.length > 0;

  return (
    <div className="kt-race">
      <div className="kt-stage" ref={containerRef} />
      {!liveHud ? (
        <div className="kt-loading-overlay">
          <div className="kt-loading-card">
            <span className="kt-spinner" aria-hidden />
            <b>{getTrack(pub.trackId || settings.trackId).name}</b>
            <small>Strecke wird aufgebaut…</small>
          </div>
        </div>
      ) : null}
      {(
        <div className={`kt-hud${hud.boost ? ' boosting' : ''}${hud.spinning ? ' spinning' : ''}`} style={{ '--kt-fast': Math.max(0, Math.min(1, (hud.fast - 0.55) / 0.6)) }}>
          <div className="kt-hud-top-left">
            {hud.trial ? null : (
              <div className={`kt-rank p${hud.rank}`} key={hud.rank}>
                <b>{hud.rank}.</b><span>/{hud.total}</span>
              </div>
            )}
            <div className="kt-lap">
              <Flag size={14} /> Runde <b>{hud.lap}</b>/{hud.laps}
              <span className="kt-lap-pips" aria-hidden>
                {Array.from({ length: hud.laps }, (_, i) => <i key={i} className={i < hud.lap - 1 ? 'done' : i === hud.lap - 1 ? 'now' : ''} />)}
              </span>
            </div>
            <div className="kt-time">{formatTime(hud.time)}</div>
            {hud.bestLap ? <div className="kt-best">Beste Runde {formatTime(hud.bestLap)}</div> : null}
          </div>

          <div className="kt-hud-top-right">
            <canvas ref={minimapRef} width={190} height={190} className="kt-minimap" />
            <ol className="kt-board">
              {hud.board.map((row) => (
                <li key={row.id} className={row.you ? 'you' : ''}>
                  <i>{row.rank}</i>
                  <span className="kt-dot" style={{ background: colorOf(row.color).hex }} />
                  <em>{row.name}</em>
                  {row.finished ? <Flag size={11} /> : null}
                </li>
              ))}
            </ol>
          </div>

          {hud.trial ? (
            <div className="kt-trial">
              <div className="kt-trial-lap">{formatTime(hud.lapTime)}</div>
              <div className="kt-trial-pb">
                {hud.medal ? <MedalChip medal={hud.medal} /> : null}
                <span>Bestzeit <b>{hud.pbLap ? formatTime(hud.pbLap) : '–:––.––'}</b></span>
              </div>
              {hud.split ? (
                <div className={`kt-split ${hud.split.delta == null ? '' : hud.split.delta <= 0 ? 'fast' : 'slow'}`}>
                  <span>{formatTime(hud.split.time)}</span>
                  {hud.split.delta != null ? <b>{hud.split.delta <= 0 ? '−' : '+'}{(Math.abs(hud.split.delta) / 1000).toFixed(2)}</b> : null}
                </div>
              ) : null}
              {hud.medalLimits ? (
                <div className="kt-medal-row">
                  <MedalChip medal="author" time={hud.medalLimits.author} dim={!hud.pbLap || hud.pbLap > hud.medalLimits.author} />
                  <MedalChip medal="gold" time={hud.medalLimits.gold} dim={!hud.pbLap || hud.pbLap > hud.medalLimits.gold} />
                  <MedalChip medal="silver" time={hud.medalLimits.silver} dim={!hud.pbLap || hud.pbLap > hud.medalLimits.silver} />
                  <MedalChip medal="bronze" time={hud.medalLimits.bronze} dim={!hud.pbLap || hud.pbLap > hud.medalLimits.bronze} />
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="kt-hud-bottom-left" style={hud.trial ? { display: 'none' } : undefined}>
            <div className={`kt-item${hud.item ? ' filled' : ''}${hud.itemRoll ? ' rolling' : ''}`}>
              {hud.itemRoll ? (
                <span className="kt-roulette" aria-label="Item wird gezogen">
                  <span className="kt-roulette-strip">{[...ROULETTE, ...ROULETTE].map((icon, i) => <i key={i}>{icon}</i>)}</span>
                </span>
              ) : hud.item ? (
                <>
                  <span className="kt-item-icon">{ITEM_INFO[hud.item]?.icon}</span>
                  <small>{ITEM_INFO[hud.item]?.label} · E</small>
                </>
              ) : <small>Kein Item</small>}
            </div>
          </div>

          <div className="kt-hud-bottom-right">
            <SpeedGauge speed={hud.speed} ratio={hud.speedRatio} max={hud.maxDisplay || 260} boost={hud.boost} drift={hud.drift} />
            {hud.slip > 0.05 ? (
              <div className="kt-slip" title="Windschatten">
                <span>Windschatten</span>
                <i style={{ width: `${Math.round(hud.slip * 100)}%` }} />
              </div>
            ) : null}
          </div>

          {hud.countdown > 0 ? <div className="kt-countdown" key={hud.countdown}>{hud.countdown}</div> : null}
          {hud.banner ? <div className="kt-banner" key={hud.banner}>{hud.banner}</div> : null}
          {hud.wrongWay ? <div className="kt-wrong">Falsche Richtung!</div> : null}
          {hud.finished && !showResults ? (
            <div className="kt-finished-note">
              <Trophy size={18} /> Im Ziel! Platz {hud.rank} · {formatTime(hud.finishTime)}
              <small>Warte auf die übrigen Fahrer…</small>
            </div>
          ) : null}
          {(hud.countdown > 0 || showHelp) ? <Controls trial={hud.trial} /> : null}
        </div>
      )}

      {showResults ? (
        <div className="kt-results" role="dialog" aria-label="Ergebnis">
          <div className="kt-results-card">
            <h2><Trophy size={20} /> Ergebnis</h2>
            <div className="kt-podium" aria-hidden>
              {[1, 0, 2].map((idx) => {
                const r = results[idx];
                if (!r) return <div key={idx} className="kt-podium-slot empty" />;
                return (
                  <div key={r.peerId} className={`kt-podium-slot p${r.place}`}>
                    <span className="kt-podium-name"><span className="kt-dot" style={{ background: colorOf(r.color).hex }} />{r.name}</span>
                    <span className="kt-podium-time">{r.timeMs ? formatTime(r.timeMs) : '—'}</span>
                    <div className="kt-podium-block"><b>{r.place}</b></div>
                  </div>
                );
              })}
            </div>
            <ol>
              {results.map((r) => (
                <li key={r.peerId} className={r.peerId === selfId ? 'you' : ''}>
                  <i className={`place p${r.place}`}>{r.place}</i>
                  <span className="kt-dot" style={{ background: colorOf(r.color).hex }} />
                  <em>{r.name}{r.bot ? ' 🤖' : ''}{r.peerId === selfId ? ' (du)' : ''}</em>
                  {r.bestLapMs ? <small className="kt-bestlap" title="Beste Runde">⏱ {formatTime(r.bestLapMs)}</small> : null}
                  <b>{r.timeMs ? formatTime(r.timeMs) : 'nicht im Ziel'}</b>
                </li>
              ))}
            </ol>
            {isHost ? (
              <div className="kt-results-actions">
                <button type="button" className="kt-btn kt-btn-primary" onClick={() => send({ type: 'host_start' })}><RotateCcw size={15} /> Nochmal fahren</button>
                <button type="button" className="kt-btn" onClick={() => send({ type: 'back_to_lobby' })}>Zur Lobby</button>
              </div>
            ) : <p className="kt-wait">Der Host startet das nächste Rennen…</p>}
          </div>
        </div>
      ) : null}
      <button type="button" className="kt-hint-btn" onClick={onToggleHelp} title="Steuerung"><HelpCircle size={15} /></button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Seite
// ---------------------------------------------------------------------------

export default function KartGamePage() {
  const { pub, selfId, inviteCandidates, isHost, send, subscribeNet } = useKartState();
  const isMaximized = useWindowMaximized();
  const [showHelp, setShowHelp] = useState(false);
  const [muted, setMuted] = useState(false);
  const [quality, setQuality] = useState(readQuality);
  const audioRef = useRef(null);
  if (!audioRef.current) audioRef.current = createKartAudio();

  useEffect(() => () => audioRef.current?.dispose?.(), []);
  useEffect(() => { audioRef.current?.setMuted(muted); }, [muted]);
  const cycleQuality = useCallback(() => {
    setQuality((q) => {
      const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(q) + 1) % QUALITY_ORDER.length];
      try { window.localStorage.setItem('bluekart.quality', next); } catch { /* ignorieren */ }
      return next;
    });
  }, []);

  const closeWindow = useCallback(() => window.bluetalk?.kart?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'KeyH') setShowHelp((v) => !v);
      else if (e.code === 'KeyM') setMuted((v) => !v);
      else if (e.code === 'Escape') setShowHelp(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!pub) {
    return (
      <div className="kt-root">
        <main className="kt-empty">
          <div className="kt-emblem" aria-hidden>🏎️</div>
          <h1>BlueKart wird vorbereitet…</h1>
          <p>Starte oder öffne ein Rennen über den Spiele-Bereich im Hauptfenster.</p>
          <button type="button" className="kt-btn" onClick={() => send({ type: 'request_state' })}>Erneut laden</button>
        </main>
      </div>
    );
  }

  const inLobby = pub.phase === 'lobby';
  const track = getTrack(pub.trackId || pub.settings?.trackId);

  return (
    <div className={`kt-root${inLobby ? '' : ' in-race'}`}>
      <header className="kt-titlebar">
        <div className="kt-title">
          <h1>BlueKart</h1>
          <div className="kt-sub">
            {pub.settings?.tableName || 'Rennen'} · {pub.settings?.mode === 'trial' ? 'Zeitfahren' : 'Rennen'} · {PHASE_LABELS[pub.phase] || pub.phase} · {track.name}{isHost ? ' · Du bist Host' : ''}
          </div>
        </div>
        <div className="kt-title-actions">
          <button type="button" className="kt-quality-btn" title="Grafikqualität (gilt ab dem nächsten Rennen)" onClick={cycleQuality}>
            Grafik: {QUALITY_LABELS[quality]}
          </button>
          <button type="button" className="kt-icon-btn" title={muted ? 'Ton an (M)' : 'Ton aus (M)'} onClick={() => setMuted((v) => !v)}>
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button type="button" className="kt-icon-btn" title="Steuerung (H)" onClick={() => setShowHelp((v) => !v)}><HelpCircle size={16} /></button>
          <button type="button" className="kt-icon-btn" title="Verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="kt-icon-btn" title="Minimieren" onClick={() => window.bluetalk?.kart?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="kt-icon-btn" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.kart?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="kt-icon-btn" title="Schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>

      <main className="kt-main">
        {inLobby ? (
          <Lobby pub={pub} selfId={selfId} isHost={isHost} inviteCandidates={inviteCandidates} send={send} />
        ) : (
          <RaceScreen
            pub={pub}
            selfId={selfId}
            isHost={isHost}
            send={send}
            subscribeNet={subscribeNet}
            audio={audioRef.current}
            quality={quality}
            showHelp={showHelp}
            onToggleHelp={() => setShowHelp((v) => !v)}
          />
        )}
      </main>
      {inLobby && showHelp ? (
        <div className="kt-overlay" role="presentation" onMouseDown={() => setShowHelp(false)}>
          <section className="kt-overlay-card" onMouseDown={(e) => e.stopPropagation()}>
            <header><h2>Steuerung</h2><button type="button" className="kt-icon-btn" onClick={() => setShowHelp(false)}><X size={16} /></button></header>
            <Controls trial={pub.settings?.mode === 'trial'} />
            <p className="kt-muted">Sammle Item-Boxen (❓), fahre über blaue Boost-Felder und driften um Kurven lädt Mini-Turbos auf. Bananen und Raketen schicken Gegner ins Schleudern — das Schild schützt dich kurz.</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}
