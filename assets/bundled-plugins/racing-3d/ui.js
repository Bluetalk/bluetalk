/**
 * 3D Live Autorennen — Plugin-Controller (Hauptfenster).
 *
 * Läuft headless: Host-Simulation (30 Hz) und Realtime-Netzwerk leben hier,
 * damit das Rennen weiterläuft, auch wenn das Spielfenster geschlossen wird.
 * Die komplette Darstellung übernimmt das separate Spielfenster
 * (src/renderer/pages/RacingGamePage.jsx), verbunden über
 * window.bluetalk.racing (pushState / onFromChild).
 *
 * WICHTIG: Die Physik-Konstanten in simulateHost() müssen mit der
 * Client-Prediction in RacingGamePage.jsx (predictCar) übereinstimmen.
 */
(function racing3dPluginUi() {
  const api = BlueTalkPlugin;
  // Jede Strecke ist echtes 3D: `turns` = Gierkurve, `elevation` = Höhenprofil
  // (Hügel/Gefälle), `bank` = Steilkurven-Neigung, `jumps` = Sprung-Rampen
  // (progress-Positionen). Alle Profile werden im Renderer (RaceScene) zu einer
  // mitrollenden 3D-Streckengeometrie interpoliert. Physik nutzt weiterhin nur
  // progress + seitlichen Versatz, daher bleibt Multiplayer/Prediction stabil.
  const TRACKS = [
    { id: 'alpine', name: 'Alpine Serpentine', laps: 3, length: 5400, difficulty: 'Technisch', width: 1.05, palette: ['#7dd3fc', '#164e63', '#e0f2fe'], scenery: 'mountain', ground: ['#25402e', '#1a2d20'], turns: [0, .75, -.9, .55, -.7, .15, .82, -1, .35, 0], elevation: [0, .35, .8, .45, -.2, -.55, -.25, .6, .25, 0], bank: [0, .55, -.65, .45, -.55, .12, .62, -.75, .3, 0], jumps: [3050], hazards: [820, 1880, 3310, 4620], boosts: [1120, 2840, 4080] },
    { id: 'desert', name: 'Desert Loop', laps: 4, length: 4800, difficulty: 'Schnell', width: 1.2, palette: ['#fbbf24', '#92400e', '#fde68a'], scenery: 'desert', ground: ['#b4783c', '#8a5a2c'], turns: [0, .22, -.24, .42, -.15, 0, .34, -.31, .12, 0], elevation: [0, .12, -.1, .22, .05, -.16, .1, -.06, .09, 0], bank: [0, .16, -.18, .32, -.12, 0, .26, -.24, .1, 0], jumps: [2100], hazards: [1400, 3000], boosts: [700, 2100, 3650, 4320] },
    { id: 'neon', name: 'Neon Harbor', laps: 3, length: 5750, difficulty: 'Nacht', width: .95, palette: ['#a78bfa', '#312e81', '#c4b5fd'], scenery: 'city', ground: ['#141a2e', '#0c1020'], turns: [0, -.72, .53, -.48, .92, -.22, .18, -.84, .56, 0], elevation: [0, -.2, .12, .38, -.12, .22, -.32, .16, -.06, 0], bank: [0, -.55, .42, -.38, .72, -.18, .14, -.62, .42, 0], jumps: [], hazards: [950, 1760, 2550, 3900, 5200], boosts: [1220, 3300, 4680] },
    { id: 'forest', name: 'Forest Sprint', laps: 5, length: 3950, difficulty: 'Kurvig', width: .9, palette: ['#86efac', '#14532d', '#bbf7d0'], scenery: 'forest', ground: ['#1c4529', '#123019'], turns: [0, -.38, .66, -.77, .42, .82, -.62, .22, -.33, 0], elevation: [0, .28, -.32, .5, -.42, .32, -.22, .38, -.16, 0], bank: [0, -.3, .55, -.65, .32, .65, -.48, .18, -.26, 0], jumps: [1850, 2900], hazards: [610, 1330, 2200, 3100], boosts: [900, 1850, 3520] },
    { id: 'volcano', name: 'Volcano Ridge', laps: 3, length: 6200, difficulty: 'Extrem', width: .86, palette: ['#fb7185', '#7f1d1d', '#fecdd3'], scenery: 'volcano', ground: ['#3a1c17', '#241010'], turns: [0, 1, -.88, .78, -.98, .48, -.22, .92, -.57, 0], elevation: [0, .55, -.65, .85, -.72, .58, -.32, .95, -.55, 0], bank: [0, .82, -.72, .72, -.88, .42, -.2, .82, -.52, 0], jumps: [1650, 5100], hazards: [720, 1650, 2440, 3580, 4760, 5600], boosts: [1020, 2960, 5100] },
  ];
  const COLORS = ['#38bdf8', '#f97316', '#22c55e', '#e879f9', '#facc15', '#fb7185', '#a3e635', '#60a5fa'];
  const MAX_PLAYERS = 8;
  const TICK_MS = 33;
  const INPUT_SEND_MS = 66;
  const STATE_SEND_MS = 66;
  let room = null;
  let state = null;
  let selfPeerId = '';
  let selfName = '';
  let localInput = { throttle: 0, brake: 0, steer: 0, boost: 0 };
  let lastInputSent = 0;
  let lastStateSent = 0;
  let pendingRoom = null;
  let tickTimer = null;
  let lastTickAt = 0;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const uid = () => `race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => Date.now();
  const getTrackById = (id) => TRACKS.find((t) => t.id === id) || TRACKS[0];
  const getTrack = () => getTrackById(state?.trackId);
  const publicState = () => (state ? { ...state, players: { ...state.players }, results: [...(state.results || [])] } : null);
  const me = async () => api.peer.info?.().catch(() => null);
  const peerName = (peerId) => {
    const contact = api.contacts().find((c) => c.id === peerId);
    return contact?.nickname || contact?.name || peerId?.slice(0, 8) || 'Fahrer';
  };
  const isValidState = (value) => Boolean(
    value && typeof value === 'object'
      && typeof value.roomId === 'string'
      && typeof value.hostPeerId === 'string'
      && ['lobby', 'countdown', 'racing', 'finished'].includes(value.phase)
      && typeof value.players === 'object'
      && value.players !== null
  );

  async function refreshSelf() {
    const info = await me();
    if (info?.id) {
      selfPeerId = info.id;
      selfName = info.name || '';
    }
    return selfPeerId;
  }

  // ---------- Spielfenster-Anbindung ----------

  function pushToChild() {
    if (!window.bluetalk?.racing?.pushState) return;
    window.bluetalk.racing.pushState({
      tracks: TRACKS,
      state: publicState(),
      selfPeerId: room?.selfPeerId || selfPeerId || '',
      isHost: Boolean(room?.isHost),
      hasRoom: Boolean(room),
      pendingRoom: pendingRoom
        ? { roomId: pendingRoom.roomId, hostPeerId: pendingRoom.hostPeerId, name: pendingRoom.name || '3D Autorennen' }
        : null,
      at: now(),
    });
  }

  async function openGameWindow() {
    try {
      await window.bluetalk?.racing?.openGameWindow?.();
    } catch {
      /* ignore */
    }
    pushToChild();
  }

  // ---------- Renn-Zustand ----------

  function createState(hostPeerId, trackId = TRACKS[0].id) {
    return {
      roomId: uid(), hostPeerId, phase: 'lobby', trackId, maxPlayers: MAX_PLAYERS,
      countdownEndsAt: 0, startedAt: 0, finishedAt: 0, players: {}, results: [], chat: [], tick: now(),
    };
  }

  function setState(next) {
    state = next;
    pushToChild();
  }

  function addSystem(text) {
    if (!state) return;
    state.chat = [...(state.chat || []).slice(-7), { at: now(), text }];
  }

  function freshRunStats() {
    return {
      x: 0, y: 0, speed: 0, progress: 0, lap: 1, sector: 0,
      boostFuel: 100, penaltyMs: 0, crashedUntil: 0, finished: false, finishMs: 0,
      lapStartedAt: 0, lastLapMs: 0, bestLapMs: 0,
    };
  }

  function ensurePlayer(peerId, name) {
    if (!state || !peerId) return null;
    if (!state.players[peerId]) {
      const used = new Set(Object.values(state.players).map((p) => p.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(state.players).length % COLORS.length];
      state.players[peerId] = {
        peerId, name: String(name || peerName(peerId)).slice(0, 24), color,
        inputs: {}, connected: true, ...freshRunStats(),
      };
      addSystem(`${state.players[peerId].name} ist beigetreten.`);
    }
    return state.players[peerId];
  }

  function sync(force = false) {
    if (!state) return;
    const t = now();
    state.tick = t;
    if (force || t - lastStateSent >= STATE_SEND_MS) {
      lastStateSent = t;
      room?.broadcast({ type: 'state', state: publicState() });
    }
    pushToChild();
  }

  function rankPlayers(players = Object.values(state?.players || {})) {
    return [...players].sort((a, b) => {
      if (a.finished && b.finished) return a.finishMs - b.finishMs;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return ((b.lap - 1) * getTrack().length + b.progress) - ((a.lap - 1) * getTrack().length + a.progress);
    });
  }

  function startCountdown() {
    if (!room?.isHost || !state || state.phase !== 'lobby') return;
    state.phase = 'countdown';
    state.countdownEndsAt = now() + 3200;
    state.startedAt = 0;
    state.finishedAt = 0;
    state.results = [];
    for (const player of Object.values(state.players)) {
      Object.assign(player, freshRunStats());
    }
    addSystem('Rennen startet in 3 Sekunden.');
    sync(true);
  }

  function resetLobby(trackId = state?.trackId || TRACKS[0].id) {
    if (!room?.isHost || !state) return;
    state.phase = 'lobby';
    state.trackId = getTrackById(trackId).id;
    state.countdownEndsAt = 0;
    state.startedAt = 0;
    state.finishedAt = 0;
    state.results = [];
    for (const player of Object.values(state.players)) {
      Object.assign(player, freshRunStats());
    }
    addSystem(`Lobby bereit: ${getTrackById(trackId).name}.`);
    sync(true);
  }

  // ---------- Simulations-Loop (läuft unabhängig vom Spielfenster) ----------

  function startLoop() {
    if (tickTimer) return;
    lastTickAt = now();
    tickTimer = api.timer.setInterval(tick, TICK_MS);
  }

  function stopLoop() {
    if (!tickTimer) return;
    api.timer.clearInterval(tickTimer);
    tickTimer = null;
  }

  function tick() {
    const t = now();
    const dt = t - lastTickAt;
    lastTickAt = t;
    if (!room) {
      stopLoop();
      return;
    }
    if (room.isHost) {
      simulateHost(dt);
      sync();
    } else {
      sendLocalInput();
      pushToChild();
    }
  }

  function sendLocalInput() {
    if (!room || room.isHost || !state?.players?.[room.selfPeerId]) return;
    const t = now();
    if (t - lastInputSent < INPUT_SEND_MS) return;
    lastInputSent = t;
    room.sendTo(room.hostPeerId, { type: 'input', input: localInput });
  }

  // ---------- Hosting & Beitritt ----------

  async function hostRace(trackId) {
    if (room) return false;
    await refreshSelf();
    const hostId = selfPeerId || `local_${uid()}`;
    setState(createState(hostId, getTrackById(trackId).id));
    ensurePlayer(hostId, selfName || 'Host');
    if (room) return false;
    room = api.realtime.createRoom({ roomId: state.roomId, name: '3D Autorennen', access: 'public', maxPeers: MAX_PLAYERS });
    if (!room) {
      state = null;
      pushToChild();
      return false;
    }
    pendingRoom = null;
    wireRoom();
    startLoop();
    void openGameWindow();
    sync(true);
    return true;
  }

  async function joinRace(hostPeerId, roomId) {
    if (room || !hostPeerId || !roomId) return false;
    room = await api.realtime.joinRoom({ hostPeerId, roomId, name: '3D Autorennen' });
    if (!room) {
      api.notify.toast?.({ title: '3D Autorennen', message: 'Beitritt fehlgeschlagen.' });
      pushToChild();
      return false;
    }
    pendingRoom = null;
    wireRoom();
    await refreshSelf();
    room.sendTo(hostPeerId, { type: 'join', name: selfName || peerName(selfPeerId), peerId: selfPeerId });
    startLoop();
    void openGameWindow();
    pushToChild();
    return true;
  }

  function leaveRace() {
    stopLoop();
    try {
      room?.leave?.();
    } catch {
      /* ignore */
    }
    room = null;
    state = null;
    localInput = { throttle: 0, brake: 0, steer: 0, boost: 0 };
    pushToChild();
  }

  function wireRoom() {
    if (!room) return;
    room.on('message', ({ payload, from }) => {
      if (!payload) return;
      if (payload.type === 'state') {
        if (!room.isHost && from === room.hostPeerId && isValidState(payload.state)) setState(payload.state);
        return;
      }
      if (room.isHost && payload.type === 'join') {
        if (Object.keys(state.players).length >= MAX_PLAYERS) return;
        ensurePlayer(from || payload.peerId, payload.name);
        sync(true);
      }
      if (room.isHost && payload.type === 'input' && state?.players?.[from]) {
        state.players[from].inputs = payload.input || {};
        state.players[from].connected = true;
      }
    });
    try {
      room.on?.('closed', () => {
        if (!room) return;
        api.notify.toast?.({ title: '3D Autorennen', message: 'Der Raum wurde geschlossen.' });
        room = null;
        state = null;
        stopLoop();
        pushToChild();
      });
    } catch {
      /* Raum ohne closed-Event — Cleanup passiert über leave */
    }
  }

  // ---------- Physik (Host-autoritativ) ----------

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

  function simulateHost(dtMs) {
    if (!room?.isHost || !state) return;
    const track = getTrack();
    const t = now();
    if (state.phase === 'countdown' && t >= state.countdownEndsAt) {
      state.phase = 'racing';
      state.startedAt = t;
      for (const player of Object.values(state.players)) {
        Object.assign(player, freshRunStats());
        player.lapStartedAt = t;
      }
      addSystem('Grün! Das Rennen läuft.');
    }
    // In der Lobby fährt man frei (Übungsrunden) — ohne Zeitmessung/Ziel.
    // Im Rennen zählt die Zeit. Beides teilt sich dieselbe Fahrphysik.
    const racing = state.phase === 'racing';
    if (!racing && state.phase !== 'lobby') return;
    const dt = Math.min(80, dtMs) / 1000;
    for (const player of Object.values(state.players)) {
      if (racing && player.finished) continue;
      const input = player.peerId === room.selfPeerId ? localInput : (player.inputs || {});
      const offroad = Math.abs(player.x) > track.width;
      const curve = trackCurve(track, player.progress);
      const targetMax = (offroad ? 38 : 88) + (input.boost && player.boostFuel > 0 ? 34 : 0);
      const accel = input.throttle ? 48 : 0;
      const brake = input.brake ? 76 : 0;
      const drag = offroad ? 15 : 7;
      player.speed = clamp(player.speed + (accel - brake - drag) * dt, 0, targetMax);
      // Kurven drücken bei hohem Tempo stärker nach außen — Bremsen lohnt sich.
      const curvePush = curve * (0.10 + player.speed / 620);
      player.x = clamp(player.x + ((input.steer || 0) * (0.8 + player.speed / 90) - curvePush) * dt, -1.7, 1.7);
      if (input.boost && player.boostFuel > 0 && !offroad) player.boostFuel = clamp(player.boostFuel - 34 * dt, 0, 100);
      else player.boostFuel = clamp(player.boostFuel + 10 * dt, 0, 100);
      if (nearAny(track, track.boosts, player.progress, 55) && Math.abs(player.x) < .42) {
        player.speed = clamp(player.speed + 42 * dt, 0, 130);
        player.boostFuel = clamp(player.boostFuel + 28 * dt, 0, 100);
      }
      if (nearAny(track, track.hazards, player.progress, 42) && Math.abs(player.x) < .32 && t > player.crashedUntil) {
        player.speed *= .42;
        player.crashedUntil = t + 900;
        if (racing) player.penaltyMs += 900;
      }
      player.progress += player.speed * dt;
      player.sector = Math.floor((player.progress / track.length) * 3) + 1;
      while (player.progress >= track.length) {
        player.progress -= track.length;
        player.lap += 1;
        // Rundenzeit nur im Rennen; in der Übung läuft der Zähler nur mit,
        // damit die Strecke im Renderer nahtlos weiterrollt.
        if (racing) {
          const lapMs = t - (player.lapStartedAt || state.startedAt);
          player.lastLapMs = lapMs;
          player.bestLapMs = player.bestLapMs > 0 ? Math.min(player.bestLapMs, lapMs) : lapMs;
        }
        player.lapStartedAt = t;
      }
      if (racing && player.lap > track.laps) {
        player.finished = true;
        player.finishMs = t - state.startedAt + player.penaltyMs;
        player.speed = 0;
        state.results = rankPlayers().filter((p) => p.finished).map((p) => ({ peerId: p.peerId, name: p.name, finishMs: p.finishMs, color: p.color, bestLapMs: p.bestLapMs }));
        addSystem(`${player.name} ist im Ziel.`);
      }
    }
    if (racing) {
      const allFinished = Object.values(state.players).length > 0 && Object.values(state.players).every((p) => p.finished);
      if (allFinished) {
        state.phase = 'finished';
        state.finishedAt = t;
        addSystem('Rennen beendet.');
      }
    }
  }

  // ---------- Aktionen aus dem Spielfenster ----------

  function handleChildAction(payload) {
    if (!payload?.type) return;
    switch (payload.type) {
      case 'request_state':
        pushToChild();
        break;
      case 'input':
        if (payload.input && typeof payload.input === 'object') {
          localInput = {
            throttle: payload.input.throttle ? 1 : 0,
            brake: payload.input.brake ? 1 : 0,
            steer: clamp(Number(payload.input.steer) || 0, -1, 1),
            boost: payload.input.boost ? 1 : 0,
          };
        }
        break;
      case 'host':
        void hostRace(payload.trackId);
        break;
      case 'select_track':
        if (room?.isHost && state?.phase === 'lobby') resetLobby(payload.trackId);
        break;
      case 'start':
        startCountdown();
        break;
      case 'reset':
        resetLobby(payload.trackId || state?.trackId);
        break;
      case 'join_pending':
        if (pendingRoom) void joinRace(pendingRoom.hostPeerId, pendingRoom.roomId);
        break;
      case 'dismiss_pending':
        pendingRoom = null;
        pushToChild();
        break;
      case 'leave':
        leaveRace();
        break;
      default:
        break;
    }
  }

  let offChild = null;
  if (window.bluetalk?.racing?.onFromChild) {
    offChild = window.bluetalk.racing.onFromChild(handleChildAction);
  }

  // ---------- Launcher & Einladungen ----------

  // Fenster öffnen und — falls noch kein Rennen läuft — sofort eine fahrbare
  // Session hosten. So landet man direkt auf der Strecke (Übungsmodus) statt in
  // einem Menü; Mitspieler können der öffentlichen Lobby jederzeit beitreten.
  async function launchOrFocus(trackId) {
    if (room) {
      await openGameWindow();
      return { ok: true, message: 'Es läuft bereits ein Rennen — Fenster geöffnet.' };
    }
    if (pendingRoom) {
      await openGameWindow();
      return { ok: true };
    }
    const hosted = await hostRace(trackId || TRACKS[0].id);
    if (!hosted) await openGameWindow();
    return { ok: true };
  }

  api.ui.registerCommand('launcherState', () => ({
    active: Boolean(room && state),
    hasSavedGame: false,
    tableName: state ? `${getTrack().name} Rennen` : (pendingRoom ? 'Einladung wartet' : null),
  }));
  api.ui.registerCommand('launchNew', () => {
    void launchOrFocus();
    return { ok: true };
  });
  api.ui.registerCommand('openWindow', () => {
    void launchOrFocus();
    return { ok: true };
  });

  api.realtime.on('room-invite', (invite) => {
    if (!room && invite?.roomId && invite?.hostPeerId) {
      pendingRoom = { ...invite, source: 'invite' };
      api.notify.toast?.({ title: '3D Autorennen', message: 'Renn-Einladung erhalten — öffne das Rennfenster zum Beitreten.' });
      pushToChild();
    }
  });
  api.realtime.on('room-discovered', (found) => {
    if (!room && found?.roomId && found?.hostPeerId) {
      pendingRoom = { ...found, source: 'discovery' };
      pushToChild();
    }
  });

  api.onDeactivate(() => {
    offChild?.();
    leaveRace();
  });

  void refreshSelf().then(() => pushToChild());
  api.log.info('3D-Autorennen-Plugin (Fenster-Modus) geladen');
})();
