/**
 * BlueTalk Vier gewinnt — Host-autoritativ, P2P, 2 Spieler.
 *
 * Diese Datei ist der Plugin-Einstiegspunkt (Export-Vertrag:
 * `export default function activateConnectFourPlugin(BlueTalkPlugin)`). Sie hält
 * die zustandsbehaftete Orchestrierung: Peer-Ereignisse, Fenster-Anbindung,
 * Präsenz, Launcher-Kommandos und die Verwaltung des Host-/Client-Zustands.
 *
 * Die reine Spiellogik liegt in Geschwistermodulen:
 *   - board.js  — Brettmaße und Brettoperationen
 *   - rules.js  — Vier-in-einer-Reihe-Siegprüfung
 *   - engine.js — Einstellungen + host-autoritative Partie (createHost)
 */

import {
  ROWS,
  COLS,
  MAX_PLAYERS,
  createEmptyBoard,
  dropDisc,
  isColumnFull,
  isBoardFull,
} from './board.js';
import { checkWin } from './rules.js';
import {
  defaultSettings,
  sanitizeSettings,
  createHost,
} from './engine.js';

export default function activateConnectFourPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'connect-four', connectFour: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isConnectFourLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  // createHost lebt in engine.js; die Anbindung an api/Peer/Kontakte wird
  // injiziert, damit die Engine selbst zustandsfrei gegenüber der UI bleibt.
  const hostDeps = { api, sendWire, broadcastWire, isContactBlocked };
  function spawnHost(settings, onTick, me, restoredGame = null) {
    return createHost(settings, onTick, me, restoredGame, hostDeps);
  }

  window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__ = window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__ || {};
  Object.assign(window.__BLUETALK_CONNECTFOUR_TEST_HOOKS__, {
    ROWS,
    COLS,
    createEmptyBoard,
    dropDisc,
    checkWin,
    isBoardFull,
    isColumnFull,
    sanitizeSettings,
    // Signaturkompatibel zur früheren, in ui.js definierten createHost:
    // (settings, onTick, me, restoredGame) — Abhängigkeiten werden gebunden.
    createHost: (settings, onTick, me, restoredGame = null) => spawnHost(settings, onTick, me, restoredGame),
  });

  let host = null;
  let hostRef = null;
  let cfSelfPeerId = '';
  let cfSelfPeerName = '';
  let clientState = null;
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'connect-four',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !cfSelfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).length;
    const maxPlayers = pub.settings?.maxPlayers || MAX_PLAYERS;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isConnectFourLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'connect-four',
      sessionId,
      tableName: pub.settings?.tableName || 'Vier-gewinnt-Tisch',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || cfSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      cfSelfPeerId = i?.id || '';
      cfSelfPeerName = i?.name || '';
    } catch {
      cfSelfPeerId = '';
      cfSelfPeerName = '';
    }
    return cfSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.connectFour?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.connectFour.pushState(null);
      clearGamePresence();
      return;
    }
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.connectFour.pushState({ public: pub, inviteCandidates });
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.connectFour?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'connect-four' || !msg.connectFour) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.connectFour;
    const selfId = cfSelfPeerId;

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      if (w.public) {
        clientState = w.public;
        tryPump();
        void openGameWindowIfNeeded();
      }
      api.notify.toast?.({ title: 'Vier gewinnt', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Vier gewinnt', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'Vier gewinnt', message: w.reason || 'Du wurdest aus dem Spiel entfernt.' });
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.connectFour?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.connectFour.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.connectFour.pendingJoin');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function notifyLauncherRefresh() {
    try {
      window.dispatchEvent(new CustomEvent('bt:games-launcher-refresh'));
    } catch {
      /* ignore */
    }
  }

  async function launchHostGame(saved = null) {
    const peerInfo = await window.bluetalk?.peer?.getInfo?.();
    if (!peerInfo?.id) {
      api.notify.toast?.({ title: 'Vier gewinnt', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    cfSelfPeerId = peerInfo.id;
    cfSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('connectFourSettings', defaultSettings());
    host = spawnHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
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
    const savedGame = api.storage.get('savedConnectFourGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Vier-gewinnt-Tisch',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function joinGame(pending) {
    await refreshSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige Vier-gewinnt-Einladung.' };
    }
    if (!cfSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einem anderen Vier-gewinnt-Spiel.';
      api.notify.toast?.({ title: 'Vier gewinnt', message });
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
      players: [],
      settings: sanitizeSettings(pending.connectFourSettings || {}),
      message: 'Verbindung zum Tisch wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      gameId: pending.gameId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: cfSelfPeerName || 'Spieler',
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
    if (msg.kind !== 'connect-four' || !msg.connectFour || isContactBlocked(msg.from)) return;
    if (host && msg.from !== cfSelfPeerId) host.onWire(msg.from, msg.connectFour);
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
        name: cfSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChild = null;
  if (window.bluetalk?.connectFour?.onFromChild) {
    offChild = window.bluetalk.connectFour.onFromChild((payload) => {
      if (!payload) return;
      const pid = cfSelfPeerId;

      if (payload.type === 'request_state') {
        tryPump();
      } else if (payload.type === 'action' && payload.action) {
        if (hostRef) {
          hostRef.applyAction(pid, payload.action);
        } else if (clientState?.hostPeerId && clientState?.gameId) {
          sendWire(clientState.hostPeerId, {
            wire: 'action',
            gameId: clientState.gameId,
            action: payload.action,
          });
        }
      } else if (payload.type === 'host_start') {
        if (hostRef) hostRef.startGame();
      } else if (payload.type === 'leave') {
        if (hostRef) {
          broadcastWire({ wire: 'leave', gameId: hostRef.gameId }, hostRef.publicState().players.map((p) => p.peerId));
          hostRef.destroy();
          hostRef = null;
          host = null;
        } else if (clientState?.hostPeerId) {
          sendWire(clientState.hostPeerId, { wire: 'leave', gameId: clientState.gameId });
        }
        clearGamePresence();
        clientState = null;
        tryPump();
        notifyLauncherRefresh();
      } else if (payload.type === 'update_settings' && payload.settings) {
        hostRef?.updateSettings(payload.settings);
      } else if (payload.type === 'invite' && payload.peerId) {
        hostRef?.invitePeer(payload.peerId);
      } else if (payload.type === 'save_game') {
        hostRef?.saveNow();
      } else if (payload.type === 'kick_player' && payload.peerId) {
        hostRef?.kickPlayer(payload.peerId);
      }
    });
  }

  void refreshSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedConnectFourGame', null)));
  api.ui.registerCommand('join', (pending) => joinGame(pending));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offChild?.();
    offMessage?.();
    offDisconnect?.();
    offConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
  });

  api.log.info('Vier-gewinnt-Plugin UI geladen');
}
