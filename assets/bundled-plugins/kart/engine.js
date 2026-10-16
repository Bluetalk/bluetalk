/**
 * BlueKart — Host-Engine (Lobby, Rennablauf, Wertung, Zustands-Relay).
 *
 * Der Host verwaltet Spieler, Strecke und Phasen (lobby → countdown → racing →
 * finished). Gefahren wird dezentral: Jedes Spielfenster simuliert sein Kart
 * selbst und meldet den Zustand ("car"); der Host sammelt alle Zustände
 * (inkl. der Bots, die in seinem Fenster laufen) und verteilt sie 20× pro
 * Sekunde an alle Spieler ("cars"). Die Zielzeiten meldet jeder Fahrer selbst.
 */

import { KART_TRACK_IDS, trackName } from './tracks.js';

export const MAX_PLAYERS = 8;
export const COUNTDOWN_MS = 4200;
const RELAY_INTERVAL_MS = 50;
const FINISH_GRACE_MS = 45_000;
const CAR_TIMEOUT_MS = 4000;
const BOT_NAMES = ['Blitz', 'Turbo', 'Pixel', 'Nitro', 'Funke', 'Drift', 'Rakete'];

export function defaultSettings() {
  return {
    tableName: 'Kart-Rennen',
    maxPlayers: MAX_PLAYERS,
    laps: 3,
    trackId: KART_TRACK_IDS[0],
    bots: 3,
    items: true,
    mode: 'race',
    lobbyAccess: 'invite',
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings()) {
  const next = { ...defaultSettings(), ...fallback, ...input };
  next.tableName = String(next.tableName || 'Kart-Rennen').trim().slice(0, 48) || 'Kart-Rennen';
  next.maxPlayers = MAX_PLAYERS;
  next.laps = Math.min(5, Math.max(1, Math.round(Number(next.laps)) || 3));
  next.trackId = KART_TRACK_IDS.includes(next.trackId) ? next.trackId : KART_TRACK_IDS[0];
  next.bots = Math.min(MAX_PLAYERS - 1, Math.max(0, Math.round(Number(next.bots)) || 0));
  next.mode = next.mode === 'trial' ? 'trial' : 'race';
  next.items = next.mode === 'trial' ? false : next.items !== false;
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  return next;
}

export function createHost(settings, onTick, onCars, me, deps = {}) {
  const { api, sendWire, broadcastWire, isContactBlocked } = deps;
  const selfId = me?.id;
  const gameId = `kt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const cfg = sanitizeSettings(settings, defaultSettings());
  const players = [];
  const invitedPeers = new Set();
  const cars = new Map(); // id -> { c, h, t }
  const consumed = new Map(); // hazard id -> expiry
  const finishTimes = new Map(); // id -> ms
  const bestLaps = new Map(); // id -> ms

  let phase = 'lobby';
  let raceId = '';
  let goAt = 0;
  let results = [];
  let message = '';
  let goTimer = null;
  let relayTimer = null;
  let graceTimer = null;
  let endTimer = null;

  // --- Spieler & Bots -------------------------------------------------------------

  function humanIds() {
    return players.map((p) => p.peerId).filter(Boolean);
  }

  function usedColors() {
    return new Set(players.map((p) => p.color));
  }

  function freeColor() {
    const used = usedColors();
    for (let i = 0; i < MAX_PLAYERS; i += 1) if (!used.has(i)) return i;
    return 0;
  }

  function botRoster() {
    const free = Math.max(0, MAX_PLAYERS - players.length);
    const count = Math.min(cfg.bots, free);
    const used = usedColors();
    const out = [];
    let color = 0;
    for (let i = 0; i < count; i += 1) {
      while (used.has(color) && color < MAX_PLAYERS) color += 1;
      used.add(color);
      out.push({
        peerId: `bot:${i + 1}`,
        name: BOT_NAMES[i % BOT_NAMES.length],
        seat: players.length + i,
        color: color % MAX_PLAYERS,
        connected: true,
        bot: true,
      });
    }
    return out;
  }

  function racers() {
    return [
      ...players.map((p) => ({ ...p, bot: false })),
      ...botRoster(),
    ];
  }

  // --- Zustand -----------------------------------------------------------------------

  function publicState() {
    return {
      gameId,
      hostPeerId: selfId,
      phase,
      raceId,
      goAt,
      goIn: phase === 'countdown' ? Math.max(0, goAt - Date.now()) : 0,
      trackId: cfg.trackId,
      message,
      settings: { ...cfg },
      players: racers().map((p) => ({
        peerId: p.peerId,
        name: p.name,
        seat: p.seat,
        color: p.color,
        connected: p.connected !== false,
        bot: Boolean(p.bot),
      })),
      results: results.map((r) => ({ ...r })),
    };
  }

  function pushState() {
    broadcastWire({ wire: 'state', gameId, public: publicState() }, humanIds().filter((id) => id !== selfId));
    onTick?.();
  }

  function carsSnapshot() {
    const now = Date.now();
    const out = {};
    for (const [id, entry] of cars) {
      if (now - entry.t > CAR_TIMEOUT_MS) continue;
      out[id] = { c: entry.c, h: entry.h };
    }
    for (const [hid, expiry] of consumed) if (expiry < now) consumed.delete(hid);
    return { cars: out, x: [...consumed.keys()] };
  }

  function startRelay() {
    if (relayTimer) return;
    relayTimer = setInterval(() => {
      const snap = carsSnapshot();
      const peers = humanIds().filter((id) => id !== selfId);
      if (peers.length) {
        broadcastWire({ wire: 'cars', gameId, raceId, cars: snap.cars, x: snap.x }, peers);
      }
      onCars?.();
    }, RELAY_INTERVAL_MS);
  }

  function stopRelay() {
    if (relayTimer) clearInterval(relayTimer);
    relayTimer = null;
  }

  function clearTimers() {
    for (const t of [goTimer, graceTimer, endTimer]) if (t) clearTimeout(t);
    goTimer = null;
    graceTimer = null;
    endTimer = null;
  }

  // --- Lobby ---------------------------------------------------------------------------

  function addPlayer(peerId, name) {
    const existing = players.find((p) => p.peerId === peerId);
    if (existing) {
      existing.connected = true;
      existing.name = String(name || existing.name).slice(0, 24);
      pushState();
      return true;
    }
    if (players.length >= MAX_PLAYERS) return false;
    const taken = new Set(players.map((p) => p.seat));
    let seat = 0;
    while (taken.has(seat)) seat += 1;
    players.push({
      peerId,
      name: String(name || peerId).slice(0, 24),
      seat,
      color: freeColor(),
      connected: true,
    });
    players.sort((a, b) => a.seat - b.seat);
    pushState();
    return true;
  }

  function removePlayer(peerId) {
    const idx = players.findIndex((p) => p.peerId === peerId);
    if (idx < 0 || peerId === selfId) return;
    if (phase === 'lobby') {
      players.splice(idx, 1);
      pushState();
      return;
    }
    players[idx].connected = false;
    cars.delete(peerId);
    checkRaceComplete();
    pushState();
  }

  function kickPlayer(peerId) {
    if (peerId === selfId) return false;
    const idx = players.findIndex((p) => p.peerId === peerId);
    if (idx < 0) return false;
    const name = players[idx].name;
    sendWire(peerId, { wire: 'kicked', gameId, reason: 'Du wurdest vom Host aus dem Rennen entfernt.' });
    removePlayer(peerId);
    message = `${name} wurde vom Host entfernt.`;
    pushState();
    return true;
  }

  function setColor(peerId, color) {
    const p = players.find((x) => x.peerId === peerId);
    const c = Math.round(Number(color));
    if (!p || phase !== 'lobby' || !Number.isInteger(c) || c < 0 || c >= MAX_PLAYERS) return false;
    if (players.some((x) => x !== p && x.color === c)) return false;
    p.color = c;
    pushState();
    return true;
  }

  // --- Rennen --------------------------------------------------------------------------------

  function startRace() {
    if (phase !== 'lobby' && phase !== 'finished') return false;
    if (!racers().length) {
      message = 'Es fehlt mindestens ein Fahrer.';
      pushState();
      return false;
    }
    clearTimers();
    cars.clear();
    consumed.clear();
    finishTimes.clear();
    bestLaps.clear();
    results = [];
    for (const p of players) p.connected = p.connected !== false;
    raceId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    goAt = Date.now() + COUNTDOWN_MS;
    phase = 'countdown';
    message = `Rennen auf ${trackName(cfg.trackId)} — ${cfg.laps} ${cfg.laps === 1 ? 'Runde' : 'Runden'}.`;
    startRelay();
    goTimer = setTimeout(() => {
      goTimer = null;
      if (phase !== 'countdown') return;
      phase = 'racing';
      message = '';
      pushState();
    }, COUNTDOWN_MS);
    pushState();
    return true;
  }

  function backToLobby() {
    if (phase === 'lobby') return false;
    clearTimers();
    stopRelay();
    cars.clear();
    consumed.clear();
    finishTimes.clear();
    bestLaps.clear();
    results = [];
    for (let i = players.length - 1; i >= 0; i -= 1) {
      if (players[i].connected === false) players.splice(i, 1);
    }
    phase = 'lobby';
    raceId = '';
    goAt = 0;
    message = '';
    pushState();
    return true;
  }

  function finishRace() {
    if (phase !== 'racing' && phase !== 'countdown') return;
    clearTimers();
    const rows = racers().map((p) => {
      const t = finishTimes.get(p.peerId);
      const progress = cars.get(p.peerId)?.c?.p || 0;
      return { peerId: p.peerId, name: p.name, color: p.color, bot: Boolean(p.bot), timeMs: typeof t === 'number' ? t : null, bestLapMs: bestLaps.get(p.peerId) || null, progress };
    });
    rows.sort((a, b) => {
      if (a.timeMs != null && b.timeMs != null) return a.timeMs - b.timeMs;
      if (a.timeMs != null) return -1;
      if (b.timeMs != null) return 1;
      return b.progress - a.progress;
    });
    results = rows.map((r, i) => ({
      place: i + 1, peerId: r.peerId, name: r.name, color: r.color, bot: r.bot, timeMs: r.timeMs, bestLapMs: r.bestLapMs,
    }));
    phase = 'finished';
    message = results[0] ? `${results[0].name} gewinnt das Rennen!` : '';
    // Relay noch kurz laufen lassen, damit alle den Endstand sehen
    setTimeout(() => { if (phase !== 'racing' && phase !== 'countdown') stopRelay(); }, 1500);
    pushState();
    try {
      api?.storage?.set?.('kartSettings', { ...cfg });
    } catch {
      /* ignore */
    }
  }

  function checkRaceComplete() {
    if (phase !== 'racing') return;
    const humans = players.filter((p) => p.connected !== false);
    if (humans.length === 0) {
      finishRace();
      return;
    }
    const allDone = humans.every((p) => finishTimes.has(p.peerId));
    if (allDone && !endTimer) {
      endTimer = setTimeout(() => {
        endTimer = null;
        finishRace();
      }, 2500);
    }
  }

  function recordFinish(id, timeMs, bestLapMs) {
    if (phase !== 'racing') return false;
    const t = Number(timeMs);
    if (!Number.isFinite(t) || t < 5000 || t > 30 * 60 * 1000) return false;
    if (finishTimes.has(id)) return false;
    finishTimes.set(id, Math.round(t));
    const bl = Number(bestLapMs);
    if (Number.isFinite(bl) && bl > 3000 && bl < 30 * 60 * 1000) bestLaps.set(id, Math.round(bl));
    if (!graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        finishRace();
      }, FINISH_GRACE_MS);
    }
    checkRaceComplete();
    pushState();
    return true;
  }

  function storeCar(id, body) {
    if (phase !== 'racing' && phase !== 'countdown') return;
    if (!body || typeof body.c !== 'object' || body.c == null) return;
    if (body.raceId && body.raceId !== raceId) return;
    const c = body.c;
    if (![c.x, c.z, c.a, c.v].every((n) => Number.isFinite(n))) return;
    cars.set(id, { c, h: Array.isArray(body.h) ? body.h.slice(0, 12) : [], t: Date.now() });
  }

  function noteHit(hid) {
    if (typeof hid !== 'string' || hid.length > 80) return;
    consumed.set(hid, Date.now() + 6000);
  }

  // Aktionen aus dem eigenen Spielfenster (Host) bzw. per Wire von Gästen
  function applyAction(peerId, action) {
    if (!action?.type) return false;
    const fromHost = peerId === selfId;
    switch (action.type) {
      case 'car':
        storeCar(peerId, action);
        if (fromHost && Array.isArray(action.bots)) {
          for (const bot of action.bots.slice(0, MAX_PLAYERS)) {
            if (bot?.id && String(bot.id).startsWith('bot:')) storeCar(bot.id, { raceId: action.raceId, c: bot.c, h: bot.h });
          }
        }
        return true;
      case 'hit':
        noteHit(action.hid);
        return true;
      case 'finish':
        if (fromHost && action.id && String(action.id).startsWith('bot:')) return recordFinish(action.id, action.timeMs, action.bestLapMs);
        return recordFinish(peerId, action.timeMs, action.bestLapMs);
      case 'set_color':
        return setColor(peerId, action.color);
      default:
        return false;
    }
  }

  function onWire(from, body) {
    if (!body?.wire) return;
    if (body.wire === 'join' && body.gameId === gameId) {
      if (phase !== 'lobby') {
        sendWire(from, { wire: 'join_reject', gameId, reason: 'Das Rennen läuft bereits.' });
        return;
      }
      if (cfg.lobbyAccess !== 'public' && from !== selfId && !invitedPeers.has(from)) {
        sendWire(from, {
          wire: 'join_reject',
          gameId,
          reason: 'Nur auf Einladung — bitte zuerst eine Einladung im Chat erhalten.',
        });
        return;
      }
      const ok = addPlayer(from, body.name);
      sendWire(from, ok
        ? { wire: 'join_ok', gameId, public: publicState() }
        : { wire: 'join_reject', gameId, reason: 'Die Lobby ist voll.' });
      return;
    }
    if (body.wire === 'leave') {
      removePlayer(from);
      return;
    }
    if (body.gameId !== gameId || !humanIds().includes(from)) return;
    if (body.wire === 'car') applyAction(from, { type: 'car', raceId: body.raceId, c: body.c, h: body.h });
    else if (body.wire === 'hit') applyAction(from, { type: 'hit', hid: body.hid });
    else if (body.wire === 'finish') applyAction(from, { type: 'finish', timeMs: body.timeMs, bestLapMs: body.bestLapMs });
    else if (body.wire === 'action') applyAction(from, body.action || {});
  }

  function bootstrapHost() {
    addPlayer(selfId, me?.name || 'Host');
  }

  return {
    gameId,
    cfg,
    bootstrapHost,
    get settings() {
      return cfg;
    },
    get raceId() {
      return raceId;
    },
    updateSettings(patch) {
      Object.assign(cfg, sanitizeSettings(patch, cfg));
      message = phase === 'lobby' ? '' : 'Einstellungen gelten ab dem nächsten Rennen.';
      try {
        api?.storage?.set?.('kartSettings', { ...cfg });
      } catch {
        /* ignore */
      }
      pushState();
    },
    invitePeer(peerId) {
      if (!peerId || players.some((p) => p.peerId === peerId)) return false;
      const connected = (api.peers() || []).some((p) => p.id === peerId);
      if (!connected || isContactBlocked(peerId)) return false;
      invitedPeers.add(peerId);
      void api.chat.send(peerId, this.invitePayload());
      message = 'Einladung wurde im Chat gesendet.';
      pushState();
      return true;
    },
    invitePayload() {
      const sum = `${cfg.mode === 'trial' ? 'Zeitfahren' : 'Rennen'} · ${trackName(cfg.trackId)} · ${cfg.laps} ${cfg.laps === 1 ? 'Runde' : 'Runden'} · bis ${MAX_PLAYERS} Fahrer`;
      return {
        kind: 'kart-invite',
        gameId,
        tableName: cfg.tableName,
        hostPeerId: selfId,
        kartSettings: { ...cfg },
        kartSettingsSummary: sum,
        lobbyAccess: cfg.lobbyAccess,
        content: `🏎️ ${cfg.tableName} — ${sum}`,
      };
    },
    startRace,
    backToLobby,
    onWire,
    removePlayer,
    kickPlayer,
    publicState,
    pushState,
    carsSnapshot,
    applyAction: (pid, action) => applyAction(pid, action),
    destroy() {
      clearTimers();
      stopRelay();
    },
  };
}
