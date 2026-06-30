(function racing3dPluginUi() {
  const api = BlueTalkPlugin;
  const TRACKS = [
    { id: 'alpine', name: 'Alpine Serpentine', laps: 3, length: 5400, difficulty: 'Technisch', width: 1.05, palette: ['#7dd3fc', '#164e63', '#e0f2fe'], turns: [0, .75, -.9, .55, -.7, .15, .82, -1, .35, 0], hazards: [820, 1880, 3310, 4620], boosts: [1120, 2840, 4080] },
    { id: 'desert', name: 'Desert Loop', laps: 4, length: 4800, difficulty: 'Schnell', width: 1.2, palette: ['#fbbf24', '#92400e', '#fde68a'], turns: [0, .22, -.24, .42, -.15, 0, .34, -.31, .12, 0], hazards: [1400, 3000], boosts: [700, 2100, 3650, 4320] },
    { id: 'neon', name: 'Neon Harbor', laps: 3, length: 5750, difficulty: 'Nacht', width: .95, palette: ['#a78bfa', '#312e81', '#c4b5fd'], turns: [0, -.72, .53, -.48, .92, -.22, .18, -.84, .56, 0], hazards: [950, 1760, 2550, 3900, 5200], boosts: [1220, 3300, 4680] },
    { id: 'forest', name: 'Forest Sprint', laps: 5, length: 3950, difficulty: 'Kurvig', width: .9, palette: ['#86efac', '#14532d', '#bbf7d0'], turns: [0, -.38, .66, -.77, .42, .82, -.62, .22, -.33, 0], hazards: [610, 1330, 2200, 3100], boosts: [900, 1850, 3520] },
    { id: 'volcano', name: 'Volcano Ridge', laps: 3, length: 6200, difficulty: 'Extrem', width: .86, palette: ['#fb7185', '#7f1d1d', '#fecdd3'], turns: [0, 1, -.88, .78, -.98, .48, -.22, .92, -.57, 0], hazards: [720, 1650, 2440, 3580, 4760, 5600], boosts: [1020, 2960, 5100] },
  ];
  const COLORS = ['#38bdf8', '#f97316', '#22c55e', '#e879f9', '#facc15', '#fb7185', '#a3e635', '#60a5fa'];
  const MAX_PLAYERS = 8;
  const INPUT_SEND_MS = 70;
  let room = null;
  let state = null;
  let screenOpen = false;
  let localInput = { throttle: 0, brake: 0, steer: 0, boost: 0 };
  let lastInputSent = 0;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const uid = () => `race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = () => Date.now();
  const getTrackById = (id) => TRACKS.find((t) => t.id === id) || TRACKS[0];
  const getTrack = () => getTrackById(state?.trackId);
  const publicState = () => (state ? { ...state, players: { ...state.players }, results: [...(state.results || [])] } : null);
  const emitState = () => window.dispatchEvent(new CustomEvent('bt:racing3d-state', { detail: publicState() }));
  const me = async () => api.peer.info?.().catch(() => null);
  const peerName = (peerId) => {
    const contact = api.contacts().find((c) => c.id === peerId);
    return contact?.nickname || contact?.name || peerId?.slice(0, 8) || 'Fahrer';
  };

  function createState(hostPeerId, trackId = TRACKS[0].id) {
    return {
      roomId: uid(), hostPeerId, phase: 'lobby', trackId, maxPlayers: MAX_PLAYERS,
      countdownEndsAt: 0, startedAt: 0, finishedAt: 0, players: {}, results: [], chat: [], tick: now(),
    };
  }

  function setState(next) {
    state = next;
    emitState();
  }

  function addSystem(text) {
    if (!state) return;
    state.chat = [...(state.chat || []).slice(-5), { at: now(), text }];
  }

  function ensurePlayer(peerId, name) {
    if (!state || !peerId) return null;
    if (!state.players[peerId]) {
      const used = new Set(Object.values(state.players).map((p) => p.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[Object.keys(state.players).length % COLORS.length];
      state.players[peerId] = {
        peerId, name: String(name || peerName(peerId)).slice(0, 24), color,
        x: 0, y: 0, speed: 0, progress: 0, lap: 1, sector: 0, inputs: {},
        boostFuel: 100, penaltyMs: 0, crashedUntil: 0, finished: false, finishMs: 0, connected: true,
      };
      addSystem(`${state.players[peerId].name} ist beigetreten.`);
    }
    return state.players[peerId];
  }

  function roomBroadcast(payload) { room?.broadcast(payload); }
  function sync() {
    if (!state) return;
    state.tick = now();
    roomBroadcast({ type: 'state', state: publicState() });
    emitState();
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
      Object.assign(player, { x: 0, y: 0, speed: 0, progress: 0, lap: 1, sector: 0, boostFuel: 100, penaltyMs: 0, crashedUntil: 0, finished: false, finishMs: 0 });
    }
    addSystem('Rennen startet in 3 Sekunden.');
    sync();
  }

  function resetLobby(trackId = state?.trackId || TRACKS[0].id) {
    if (!room?.isHost || !state) return;
    state.phase = 'lobby';
    state.trackId = trackId;
    state.countdownEndsAt = 0;
    state.startedAt = 0;
    state.finishedAt = 0;
    state.results = [];
    for (const player of Object.values(state.players)) {
      Object.assign(player, { x: 0, y: 0, speed: 0, progress: 0, lap: 1, sector: 0, boostFuel: 100, penaltyMs: 0, crashedUntil: 0, finished: false, finishMs: 0 });
    }
    addSystem(`Lobby bereit: ${getTrackById(trackId).name}.`);
    sync();
  }

  async function hostRace(trackId) {
    const info = await me();
    const selfId = info?.id || `local_${uid()}`;
    setState(createState(selfId, trackId));
    ensurePlayer(selfId, info?.name || 'Host');
    room = api.realtime.createRoom({ roomId: state.roomId, name: '3D Autorennen', access: 'public', maxPeers: MAX_PLAYERS });
    wireRoom();
    screenOpen = true;
    api.ui.openScreen('race');
    sync();
  }

  async function joinRace(hostPeerId, roomId) {
    if (room || !hostPeerId || !roomId) return false;
    room = await api.realtime.joinRoom({ hostPeerId, roomId, name: '3D Autorennen' });
    if (!room) return false;
    wireRoom();
    const info = await me();
    room.sendTo(hostPeerId, { type: 'join', name: info?.name || peerName(info?.id), peerId: info?.id });
    screenOpen = true;
    api.ui.openScreen('race');
    return true;
  }

  function wireRoom() {
    if (!room) return;
    room.on('message', ({ payload, from }) => {
      if (!payload) return;
      if (payload.type === 'state') setState(payload.state);
      if (room.isHost && payload.type === 'join') {
        if (Object.keys(state.players).length >= MAX_PLAYERS) return;
        ensurePlayer(from || payload.peerId, payload.name);
        sync();
      }
      if (room.isHost && payload.type === 'input' && state?.players?.[from]) {
        state.players[from].inputs = payload.input || {};
        state.players[from].connected = true;
      }
    });
  }

  function trackCurve(track, distance) {
    const segment = (distance / track.length) * track.turns.length;
    const i = Math.floor(segment) % track.turns.length;
    const t = segment - Math.floor(segment);
    const a = track.turns[i] || 0;
    const b = track.turns[(i + 1) % track.turns.length] || 0;
    return a + (b - a) * t;
  }

  function nearAny(list, progress, range = 70) {
    const track = getTrack();
    return list.some((spot) => Math.abs((((progress - spot + track.length / 2) % track.length) - track.length / 2)) < range);
  }

  function simulateHost(dtMs) {
    if (!room?.isHost || !state) return;
    const track = getTrack();
    const t = now();
    if (state.phase === 'countdown' && t >= state.countdownEndsAt) {
      state.phase = 'racing';
      state.startedAt = t;
      addSystem('Grün! Das Rennen läuft.');
    }
    if (state.phase !== 'racing') return;
    const dt = Math.min(80, dtMs) / 1000;
    for (const player of Object.values(state.players)) {
      if (player.finished) continue;
      const input = player.peerId === room.selfPeerId ? localInput : (player.inputs || {});
      const offroad = Math.abs(player.x) > track.width;
      const curve = trackCurve(track, player.progress);
      const targetMax = (offroad ? 38 : 88) + (input.boost && player.boostFuel > 0 ? 34 : 0);
      const accel = input.throttle ? 48 : 0;
      const brake = input.brake ? 76 : 0;
      const drag = offroad ? 15 : 7;
      player.speed = clamp(player.speed + (accel - brake - drag) * dt, 0, targetMax);
      player.x = clamp(player.x + ((input.steer || 0) * (0.8 + player.speed / 90) - curve * 0.18) * dt, -1.7, 1.7);
      if (input.boost && player.boostFuel > 0 && !offroad) player.boostFuel = clamp(player.boostFuel - 34 * dt, 0, 100);
      else player.boostFuel = clamp(player.boostFuel + 10 * dt, 0, 100);
      if (nearAny(track.boosts, player.progress, 55) && Math.abs(player.x) < .42) {
        player.speed = clamp(player.speed + 42 * dt, 0, 130);
        player.boostFuel = clamp(player.boostFuel + 28 * dt, 0, 100);
      }
      if (nearAny(track.hazards, player.progress, 42) && Math.abs(player.x) < .32 && t > player.crashedUntil) {
        player.speed *= .42;
        player.crashedUntil = t + 900;
        player.penaltyMs += 900;
      }
      player.progress += player.speed * dt;
      player.sector = Math.floor((player.progress / track.length) * 3) + 1;
      while (player.progress >= track.length) {
        player.progress -= track.length;
        player.lap += 1;
      }
      if (player.lap > track.laps) {
        player.finished = true;
        player.finishMs = t - state.startedAt + player.penaltyMs;
        player.speed = 0;
        state.results = rankPlayers().filter((p) => p.finished).map((p) => ({ peerId: p.peerId, name: p.name, finishMs: p.finishMs, color: p.color }));
        addSystem(`${player.name} ist im Ziel.`);
      }
    }
    const allFinished = Object.values(state.players).length > 0 && Object.values(state.players).every((p) => p.finished);
    if (allFinished) {
      state.phase = 'finished';
      state.finishedAt = t;
      addSystem('Rennen beendet.');
    }
  }

  function formatMs(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const min = Math.floor(total / 60);
    const sec = String(total % 60).padStart(2, '0');
    return `${min}:${sec}`;
  }

  function css() {
    return `<style>
      .r3d{height:min(86vh,860px);min-height:660px;background:#08111f;color:#e5f3ff;border-radius:24px;overflow:hidden;display:grid;grid-template-rows:auto 1fr;font-family:Inter,system-ui,sans-serif;box-shadow:0 24px 80px rgba(0,0,0,.45)}
      .r3dTop{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:14px 18px;background:linear-gradient(90deg,#0f172a,#111827)}.r3dTop h2{margin:0;font-size:19px}.r3dTop p{margin:2px 0 0;color:#94a3b8;font-size:12px}.r3dBtn{border:1px solid rgba(148,163,184,.3);background:#172033;color:#e5f3ff;border-radius:12px;padding:9px 12px;font-weight:800;cursor:pointer}.r3dBtn:disabled{opacity:.45;cursor:not-allowed}.r3dBtn.primary{background:#2563eb;border-color:#60a5fa}.r3dBtn.danger{background:#7f1d1d;border-color:#fb7185}.r3dBody{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:0}.r3dStage{position:relative;background:#020617}.r3dCanvas{width:100%;height:100%;display:block}.r3dHud{position:absolute;left:18px;right:18px;bottom:18px;display:flex;justify-content:space-between;align-items:end;gap:12px;pointer-events:none}.r3dGauge,.r3dKeys,.r3dCenter{background:rgba(15,23,42,.74);border:1px solid rgba(148,163,184,.25);border-radius:16px;padding:12px;backdrop-filter:blur(12px)}.r3dGauge b{font-size:30px}.r3dCenter{position:absolute;top:18px;left:50%;transform:translateX(-50%);text-align:center;min-width:190px}.r3dSide{border-left:1px solid rgba(148,163,184,.18);background:#0f172a;padding:16px;overflow:auto}.r3dTrack{display:grid;gap:8px;margin:12px 0}.r3dTrack button{text-align:left}.r3dTrack button.active{outline:2px solid #38bdf8}.r3dPlayers,.r3dLog{display:grid;gap:8px;margin-top:12px}.r3dPlayer{display:grid;grid-template-columns:auto 14px 1fr auto;align-items:center;gap:8px;background:#111827;border:1px solid rgba(148,163,184,.16);border-radius:12px;padding:8px}.r3dDot{width:14px;height:14px;border-radius:50%}.r3dInvite{font-size:12px;color:#94a3b8;word-break:break-all}.r3dHelp{font-size:12px;color:#cbd5e1;line-height:1.5}.r3dActions{display:flex;gap:8px;flex-wrap:wrap}.r3dMeta{color:#94a3b8;font-size:12px}.r3dBar{height:8px;border-radius:999px;background:#1f2937;overflow:hidden}.r3dBar>span{display:block;height:100%;background:#38bdf8}.r3dResult{background:#111827;border-radius:12px;padding:8px;border:1px solid rgba(148,163,184,.16)}
    </style>`;
  }

  api.ui.registerScreen({ id: 'race', title: '3D Live Autorennen', render(container) {
    let raf = 0;
    let selected = state?.trackId || TRACKS[0].id;
    let lastFrame = performance.now();
    container.innerHTML = `${css()}<div class="r3d"><div class="r3dTop"><div><h2>🏎️ 3D Live Autorennen</h2><p>Echtes Rundrennen · Realtime API · 5 Strecken · bis 8 Spieler</p></div><div class="r3dActions"><button class="r3dBtn" data-act="close">Schließen</button></div></div><div class="r3dBody"><div class="r3dStage"><canvas class="r3dCanvas"></canvas><div class="r3dCenter" data-center></div><div class="r3dHud"><div class="r3dGauge"><div class="r3dMeta">Tempo</div><b data-speed>0</b> km/h<div class="r3dMeta" data-lap>Runde 1</div></div><div class="r3dKeys">W/↑ Gas · S/↓ Bremse · A/D lenken · Space Boost<br><span class="r3dMeta">Auf der Straße bleiben, Boost-Pads treffen, Hindernisse meiden.</span></div></div></div><aside class="r3dSide"><div data-side></div></aside></div></div>`;
    const canvas = container.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const side = container.querySelector('[data-side]');
    const speedEl = container.querySelector('[data-speed]');
    const lapEl = container.querySelector('[data-lap]');
    const center = container.querySelector('[data-center]');

    function selfPlayer() { return state?.players?.[room?.selfPeerId] || Object.values(state?.players || {})[0] || null; }
    function resize() { const rect = canvas.getBoundingClientRect(); canvas.width = Math.max(720, rect.width * devicePixelRatio); canvas.height = Math.max(480, rect.height * devicePixelRatio); }
    function renderCenter() {
      if (!state) { center.innerHTML = '<b>Keine Lobby</b><br><span class="r3dMeta">Starte ein Rennen.</span>'; return; }
      if (state.phase === 'countdown') center.innerHTML = `<b style="font-size:34px">${Math.max(1, Math.ceil((state.countdownEndsAt - now()) / 1000))}</b><br><span class="r3dMeta">Start gleich</span>`;
      else if (state.phase === 'racing') center.innerHTML = `<b>${getTrack().name}</b><br><span class="r3dMeta">${formatMs(now() - state.startedAt)}</span>`;
      else if (state.phase === 'finished') center.innerHTML = '<b>🏁 Ziel</b><br><span class="r3dMeta">Rennen beendet</span>';
      else center.innerHTML = '<b>Lobby</b><br><span class="r3dMeta">Wähle Strecke & starte</span>';
    }
    function sideHtml() {
      const s = state;
      const track = getTrackById(selected);
      const players = rankPlayers(Object.values(s?.players || {}));
      return `<h3>${s ? ({ lobby: 'Lobby', countdown: 'Countdown', racing: 'Rennen', finished: 'Ergebnis' }[s.phase] || s.phase) : '3D Rennen'}</h3><div class="r3dMeta">Raum: <span class="r3dInvite">${s?.roomId || '—'}</span></div><div class="r3dTrack">${TRACKS.map((t) => `<button class="r3dBtn ${selected === t.id ? 'active' : ''}" data-track="${t.id}">${t.name}<br><span class="r3dMeta">${t.laps} Runden · ${t.length} m · ${t.difficulty}</span></button>`).join('')}</div><div class="r3dActions"><button class="r3dBtn primary" data-act="host">Neue Lobby</button><button class="r3dBtn" data-act="start" ${room?.isHost && s?.phase === 'lobby' && players.length >= 1 ? '' : 'disabled'}>Rennen starten</button><button class="r3dBtn" data-act="reset" ${room?.isHost && s ? '' : 'disabled'}>Zurücksetzen</button></div><p class="r3dHelp">${track.name}: Hindernisse bremsen, Boost-Pads geben Tempo. Der Host simuliert alle Fahrzeuge autoritativ und sendet laufend den Spielstand.</p><h3>Fahrer</h3><div class="r3dPlayers">${players.map((p, i) => `<div class="r3dPlayer"><span>${i + 1}.</span><span class="r3dDot" style="background:${p.color}"></span><div><b>${p.name}</b><div class="r3dBar"><span style="width:${clamp(((p.lap - 1) * getTrack().length + p.progress) / (getTrack().length * getTrack().laps) * 100, 0, 100)}%"></span></div></div><span class="r3dMeta">${p.finished ? formatMs(p.finishMs) : `R${p.lap}/${getTrack().laps}`}</span></div>`).join('') || '<div class="r3dMeta">Noch keine Fahrer</div>'}</div>${s?.results?.length ? `<h3>Podium</h3>${s.results.map((r, i) => `<div class="r3dResult">${i + 1}. <b style="color:${r.color}">${r.name}</b> · ${formatMs(r.finishMs)}</div>`).join('')}` : ''}<h3>Log</h3><div class="r3dLog">${(s?.chat || []).map((m) => `<div class="r3dMeta">${m.text}</div>`).join('') || '<div class="r3dMeta">Bereit.</div>'}</div>`;
    }
    function renderSide() { side.innerHTML = sideHtml(); }
    function drawWorld() {
      resize();
      const w = canvas.width; const h = canvas.height; const track = getTrackById(state?.trackId || selected); const self = selfPlayer() || { progress: 0, x: 0, speed: 0, lap: 1, boostFuel: 100 };
      const sky = ctx.createLinearGradient(0, 0, 0, h * .58); sky.addColorStop(0, track.palette[1]); sky.addColorStop(.7, '#0f172a'); sky.addColorStop(1, '#020617'); ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = track.id === 'desert' ? '#713f12' : track.id === 'forest' ? '#052e16' : '#111827'; ctx.fillRect(0, h * .48, w, h * .52);
      for (let i = 0; i < 46; i += 1) {
        const z = i / 46; const y = h * (.50 + z * .50); const road = w * (.06 + z * .62) * track.width; const dist = self.progress + i * 48; const curve = trackCurve(track, dist) * w * .15 * z;
        ctx.fillStyle = i % 2 ? '#334155' : '#475569'; ctx.beginPath(); ctx.moveTo(w / 2 - road * .12 + curve, y - h * .015); ctx.lineTo(w / 2 + road * .12 + curve, y - h * .015); ctx.lineTo(w / 2 + road * .5 + curve, y + h * .024); ctx.lineTo(w / 2 - road * .5 + curve, y + h * .024); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = Math.max(1, 3 * z); ctx.stroke();
        if (nearAny(track.boosts, dist % track.length, 35)) { ctx.fillStyle = '#22d3ee'; ctx.fillRect(w / 2 - road * .12 + curve, y, road * .24, Math.max(2, h * .011)); }
        if (nearAny(track.hazards, dist % track.length, 30)) { ctx.fillStyle = '#f97316'; ctx.fillRect(w / 2 - road * .08 + curve, y, road * .16, Math.max(2, h * .013)); }
      }
      for (const [idx, p] of rankPlayers().entries()) {
        const rel = ((p.progress - self.progress + track.length) % track.length);
        if (rel > 1050 && p.peerId !== self.peerId) continue;
        const z = p.peerId === self.peerId ? 1 : clamp(1 - rel / 1050, .08, .86);
        const curve = trackCurve(track, self.progress + rel) * w * .13 * z;
        const x = w / 2 + curve + (p.x || 0) * w * .20 * z + (idx - 2) * 5;
        const y = h * (.92 - z * .35);
        const cw = 58 * z + 34; const ch = 28 * z + 18;
        ctx.fillStyle = p.color; ctx.fillRect(x - cw / 2, y - ch, cw, ch); ctx.fillStyle = '#020617'; ctx.fillRect(x - cw * .22, y - ch * .86, cw * .44, ch * .38); ctx.fillStyle = '#e5e7eb'; ctx.font = `${Math.max(12, 17 * z)}px sans-serif`; ctx.fillText(p.name || 'Fahrer', x - cw / 2, y - ch - 8);
      }
      speedEl.textContent = Math.round((self.speed || 0) * 3.6); lapEl.textContent = `Runde ${Math.min(self.lap || 1, track.laps)}/${track.laps} · Boost ${Math.round(self.boostFuel || 0)}%`;
    }
    function sendLocalInput() {
      if (!room || room.isHost || !state?.players?.[room.selfPeerId]) return;
      const t = now();
      if (t - lastInputSent < INPUT_SEND_MS) return;
      lastInputSent = t;
      room.sendTo(room.hostPeerId, { type: 'input', input: localInput });
    }
    function frame(ts) {
      const dt = ts - lastFrame; lastFrame = ts;
      if (room?.isHost) { simulateHost(dt); sync(); }
      sendLocalInput(); renderCenter(); drawWorld(); raf = requestAnimationFrame(frame);
    }
    function key(e, on) {
      if (['ArrowUp', 'w', 'W'].includes(e.key)) localInput.throttle = on ? 1 : 0;
      if (['ArrowDown', 's', 'S'].includes(e.key)) localInput.brake = on ? 1 : 0;
      if (['ArrowLeft', 'a', 'A'].includes(e.key)) localInput.steer = on ? -1 : (localInput.steer < 0 ? 0 : localInput.steer);
      if (['ArrowRight', 'd', 'D'].includes(e.key)) localInput.steer = on ? 1 : (localInput.steer > 0 ? 0 : localInput.steer);
      if (e.code === 'Space') localInput.boost = on ? 1 : 0;
    }
    const onState = () => renderSide(); const onKeyDown = (e) => key(e, true); const onKeyUp = (e) => key(e, false);
    window.addEventListener('bt:racing3d-state', onState); window.addEventListener('keydown', onKeyDown); window.addEventListener('keyup', onKeyUp);
    container.addEventListener('click', (e) => {
      const tr = e.target.closest('[data-track]');
      if (tr) { selected = tr.dataset.track; if (state && room?.isHost && state.phase === 'lobby') resetLobby(selected); renderSide(); }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'host') void hostRace(selected);
      if (act === 'start') startCountdown();
      if (act === 'reset') resetLobby(selected);
      if (act === 'close') api.ui.closeScreen();
    });
    renderSide(); raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('bt:racing3d-state', onState); window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  } });

  api.ui.registerCommand('launcherState', () => ({ active: screenOpen, hasSavedGame: false, tableName: state ? `${getTrack().name} Rennen` : null }));
  api.ui.registerCommand('launchNew', () => { void hostRace(TRACKS[0].id); return { ok: true }; });
  api.ui.registerCommand('openWindow', () => { screenOpen = true; api.ui.openScreen('race'); return { ok: true }; });
  api.realtime.on('room-invite', (invite) => { if (invite?.roomId && invite?.hostPeerId) void joinRace(invite.hostPeerId, invite.roomId); });
  api.realtime.on('room-discovered', (found) => { if (!room && found?.roomId && found?.hostPeerId) void joinRace(found.hostPeerId, found.roomId); });
})();
