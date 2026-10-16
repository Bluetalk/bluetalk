/**
 * BlueKart — 3D-Kartrennen (Host-Lobby, dezentrale Fahrphysik, P2P).
 *
 * Plugin-Einstiegspunkt (Export-Vertrag: `export default function
 * activateKartPlugin(BlueTalkPlugin)`). Hier liegt die zustandsbehaftete
 * Orchestrierung: Peer-Ereignisse, Fenster-Anbindung, Präsenz, Launcher-
 * Kommandos sowie die Weiterleitung der Echtzeit-Fahrdaten zwischen
 * Spielfenster und Mitspielern.
 *
 *   - tracks.js — Streckenliste (IDs/Namen)
 *   - engine.js — Einstellungen, Lobby, Rennablauf, Zustands-Relay (createHost)
 */

import { createHost, defaultSettings, sanitizeSettings, MAX_PLAYERS } from './engine.js';

export default function activateKartPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'kart', kart: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  const hostDeps = { api, sendWire, broadcastWire, isContactBlocked };
  function spawnHost(settings, onTick, onCars, me) {
    return createHost(settings, onTick, onCars, me, hostDeps);
  }

  let host = null;
  let hostRef = null;
  let selfPeerId = '';
  let selfPeerName = '';
  let clientState = null;
  let clientCars = { cars: {}, x: [] };
  let lastPresenceSession = null;
  // Heartbeat: Gäste verwerfen Lobby-Präsenz nach 90 s ohne Meldung — ohne
  // regelmäßiges Signal verschwänden offene Einladungen aus dem Spiele-Tab.
  const presenceHeartbeat = setInterval(() => {
    if (lastPresenceSession) syncGamePresence();
  }, 20_000);

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'kart',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !selfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const humans = (pub.players || []).filter((p) => !p.bot);
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && phase === 'lobby' && humans.length < MAX_PLAYERS;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'kart',
      sessionId,
      tableName: pub.settings?.tableName || 'Kart-Rennen',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || selfPeerId,
      playerCount: humans.length,
      maxPlayers: MAX_PLAYERS,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      selfPeerId = i?.id || '';
      selfPeerName = i?.name || '';
    } catch {
      selfPeerId = '';
      selfPeerName = '';
    }
    return selfPeerId;
  }

  function currentCars() {
    if (hostRef) return hostRef.carsSnapshot();
    return clientCars;
  }

  /** Schickt den Zustand (und ggf. Fahrdaten) an das Spielfenster. */
  function pushToWindow(withInvites) {
    if (!window.bluetalk?.kart?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.kart.pushState(null);
      return;
    }
    const payload = { public: pub };
    if (pub.phase === 'racing' || pub.phase === 'countdown' || pub.phase === 'finished') {
      const snap = currentCars();
      payload.cars = snap.cars;
      payload.x = snap.x;
    }
    if (withInvites) {
      const seated = new Set((pub.players || []).map((p) => p.peerId));
      const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
      payload.inviteCandidates = (api.contacts() || [])
        .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
        .map((contact) => ({
          peerId: contact.id,
          name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
        }));
    }
    window.bluetalk.kart.pushState(payload);
  }

  function tryPump() {
    if (!window.bluetalk?.kart?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.kart.pushState(null);
      clearGamePresence();
      return;
    }
    pushToWindow(true);
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.kart?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function notifyLauncherRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('bt:games-launcher-refresh'));
    } catch {
      /* ignore */
    }
  }

  /** Gast: Rennstart-Zeitpunkt in lokaler Zeit berechnen (Host sendet nur die Restzeit). */
  function withLocalGoAt(next) {
    const sameRace = clientState && clientState.raceId === next.raceId && clientState.goAt;
    if (sameRace) return { ...next, goAt: clientState.goAt };
    return { ...next, goAt: next.phase === 'lobby' ? 0 : Date.now() + (next.goIn || 0) };
  }

  function handleWire(msg) {
    if (msg.kind !== 'kart' || !msg.kart) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.kart;
    const selfId = selfPeerId;

    if (w.wire === 'cars') {
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      clientCars = { cars: w.cars || {}, x: Array.isArray(w.x) ? w.x : [] };
      pushToWindow(false);
      return;
    }

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = withLocalGoAt(w.public);
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      if (w.public) {
        clientState = withLocalGoAt(w.public);
        tryPump();
        void openGameWindowIfNeeded();
      }
      api.notify.toast?.({ title: 'BlueKart', message: 'In der Lobby angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'BlueKart', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      clientCars = { cars: {}, x: [] };
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'BlueKart', message: w.reason || 'Du wurdest aus dem Rennen entfernt.' });
      clientState = null;
      clientCars = { cars: {}, x: [] };
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.kart?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.kart.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.kart.pendingJoin');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function launchHostGame() {
    const peerInfo = await window.bluetalk?.peer?.getInfo?.();
    if (!peerInfo?.id) {
      api.notify.toast?.({ title: 'BlueKart', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    selfPeerId = peerInfo.id;
    selfPeerName = peerInfo.name || '';
    const settings = api.storage.get('kartSettings', defaultSettings());
    host = spawnHost(
      settings,
      () => {
        tryPump();
        notifyLauncherRefresh();
      },
      () => pushToWindow(false),
      { id: peerInfo.id, name: peerInfo.name || 'Host' },
    );
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshSelfId();
    const activeState = host ? host.publicState() : clientState;
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Kart-Rennen',
      hasSavedGame: false,
    };
  }

  async function joinGame(pending) {
    await refreshSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige Kart-Einladung.' };
    }
    if (!selfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einem anderen Kart-Rennen.';
      api.notify.toast?.({ title: 'BlueKart', message });
      return { ok: false, message };
    }
    if (sameGame) {
      await openGameWindowIfNeeded();
      tryPump();
      return { ok: true };
    }

    clientState = {
      gameId: pending.gameId,
      hostPeerId: pending.hostPeerId,
      phase: 'lobby',
      raceId: '',
      goAt: 0,
      trackId: pending.kartSettings?.trackId,
      players: [],
      results: [],
      settings: sanitizeSettings(pending.kartSettings || {}),
      message: 'Verbindung zur Lobby wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', { hostPeerId: pending.hostPeerId, gameId: pending.gameId });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: selfPeerName || 'Fahrer',
    });
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function bootstrapPendingJoin() {
    const pending = tryConsumePendingJoin();
    if (pending) await joinGame(pending);
  }

  const offMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'kart' || !msg.kart || isContactBlocked(msg.from)) return;
    if (host && msg.from !== selfPeerId) host.onWire(msg.from, msg.kart);
    handleWire(msg);
  });
  const offDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: selfPeerName || 'Fahrer',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  function leaveGame() {
    if (hostRef) {
      broadcastWire({ wire: 'leave', gameId: hostRef.gameId }, hostRef.publicState().players.filter((p) => !p.bot).map((p) => p.peerId));
      hostRef.destroy();
      hostRef = null;
      host = null;
    } else if (clientState?.hostPeerId) {
      sendWire(clientState.hostPeerId, { wire: 'leave', gameId: clientState.gameId });
    }
    clearGamePresence();
    clientState = null;
    clientCars = { cars: {}, x: [] };
    tryPump();
    notifyLauncherRefresh();
  }

  let offChild = null;
  if (window.bluetalk?.kart?.onFromChild) {
    offChild = window.bluetalk.kart.onFromChild((payload) => {
      if (!payload) return;
      const pid = selfPeerId;

      switch (payload.type) {
        case 'request_state':
          tryPump();
          break;
        case 'car':
          // Hochfrequente Fahrdaten: direkt zum Host (oder in die eigene Engine)
          if (hostRef) {
            hostRef.applyAction(pid, { type: 'car', raceId: hostRef.raceId, c: payload.c, h: payload.h, bots: payload.bots });
          } else if (clientState?.hostPeerId && clientState?.gameId) {
            sendWire(clientState.hostPeerId, {
              wire: 'car', gameId: clientState.gameId, raceId: clientState.raceId, c: payload.c, h: payload.h,
            });
          }
          break;
        case 'hit':
          if (hostRef) hostRef.applyAction(pid, { type: 'hit', hid: payload.hid });
          else if (clientState?.hostPeerId) sendWire(clientState.hostPeerId, { wire: 'hit', gameId: clientState.gameId, hid: payload.hid });
          break;
        case 'finish':
          if (hostRef) hostRef.applyAction(pid, { type: 'finish', id: payload.id, timeMs: payload.timeMs, bestLapMs: payload.bestLapMs });
          else if (clientState?.hostPeerId) sendWire(clientState.hostPeerId, { wire: 'finish', gameId: clientState.gameId, timeMs: payload.timeMs, bestLapMs: payload.bestLapMs });
          break;
        case 'set_color':
          if (hostRef) hostRef.applyAction(pid, { type: 'set_color', color: payload.color });
          else if (clientState?.hostPeerId) {
            sendWire(clientState.hostPeerId, { wire: 'action', gameId: clientState.gameId, action: { type: 'set_color', color: payload.color } });
          }
          break;
        case 'host_start':
          hostRef?.startRace();
          break;
        case 'back_to_lobby':
          hostRef?.backToLobby();
          break;
        case 'update_settings':
          if (payload.settings) hostRef?.updateSettings(payload.settings);
          break;
        case 'invite':
          if (payload.peerId) hostRef?.invitePeer(payload.peerId);
          break;
        case 'kick_player':
          if (payload.peerId) hostRef?.kickPlayer(payload.peerId);
          break;
        case 'leave':
          leaveGame();
          break;
        default:
          break;
      }
    });
  }

  void refreshSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame());
  api.ui.registerCommand('launchResume', () => launchHostGame());
  api.ui.registerCommand('join', (pending) => joinGame(pending));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    clearInterval(presenceHeartbeat);
    offChild?.();
    offMessage?.();
    offDisconnect?.();
    offConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
  });

  api.log.info('BlueKart-Plugin UI geladen');
}
