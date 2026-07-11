/**
 * BlueTalk Tic-Tac-Toe — Solo vs Algorithmus, Online P2P, konfigurierbares Feld.
 *
 * Diese Datei ist der Plugin-Einstiegspunkt (Export-Vertrag:
 * `export default function activateTicTacToePlugin(BlueTalkPlugin)`). Sie hält
 * die zustandsbehaftete Orchestrierung: Peer-Ereignisse, Fenster-Anbindung,
 * Präsenz, Launcher-Kommandos und die Verwaltung des Host-/Client-Zustands.
 *
 * Die reine Spiellogik liegt in Geschwistermodulen:
 *   - board.js  — Feldgrößen, Marken, Brettoperationen
 *   - rules.js  — konfigurierbare n-in-einer-Reihe-Siegprüfung
 *   - ai.js     — Algorithmus (Leicht/Mittel/Schwer) + selbsttrainierte KI
 *   - engine.js — Einstellungen + host-autoritative Partie (createHost)
 */

import {
  AI_PEER_ID,
  PLAYER_MARKS,
  createEmptyBoard,
  applyMove,
  isBoardFull,
  listEmptyCells,
} from './board.js';
import { checkWin } from './rules.js';
import {
  chooseAiMove,
  emptyModel,
  modelKey,
  chooseTrainedMove,
  trainSelfPlay,
  learnFromGame,
} from './ai.js';
import {
  defaultSettings,
  sanitizeSettings,
  settingsSummary,
  createHost,
} from './engine.js';

export default function activateTicTacToePlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || peerId === AI_PEER_ID || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'tic-tac-toe', ticTacToe: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isTttLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  // createHost lebt in engine.js; die Anbindung an api/Peer/Kontakte wird
  // injiziert, damit die Engine selbst zustandsfrei gegenüber der UI bleibt.
  const hostDeps = { api, sendWire, broadcastWire, isContactBlocked };
  function spawnHost(settings, onTick, me, restoredGame = null) {
    return createHost(settings, onTick, me, restoredGame, hostDeps);
  }

  window.__BLUETALK_TICTACTOE_TEST_HOOKS__ = window.__BLUETALK_TICTACTOE_TEST_HOOKS__ || {};
  Object.assign(window.__BLUETALK_TICTACTOE_TEST_HOOKS__, {
    AI_PEER_ID,
    PLAYER_MARKS,
    createEmptyBoard,
    applyMove,
    checkWin,
    isBoardFull,
    listEmptyCells,
    chooseAiMove,
    sanitizeSettings,
    settingsSummary,
    // Signaturkompatibel zur früheren, in ui.js definierten createHost:
    // (settings, onTick, me, restoredGame) — Abhängigkeiten werden gebunden.
    createHost: (settings, onTick, me, restoredGame = null) => spawnHost(settings, onTick, me, restoredGame),
    emptyModel,
    modelKey,
    chooseTrainedMove,
    trainSelfPlay,
    learnFromGame,
  });

  let host = null;
  let hostRef = null;
  let tttSelfPeerId = '';
  let tttSelfPeerName = '';
  let clientState = null;
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'tic-tac-toe',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !tttSelfPeerId || pub.settings?.playMode === 'solo') {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).filter((p) => !p.isAi).length;
    const maxPlayers = pub.settings?.maxPlayers || 2;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isTttLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'tic-tac-toe',
      sessionId,
      tableName: pub.settings?.tableName || 'Tic-Tac-Toe',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || tttSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      tttSelfPeerId = i?.id || '';
      tttSelfPeerName = i?.name || '';
    } catch {
      tttSelfPeerId = '';
      tttSelfPeerName = '';
    }
    return tttSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.ticTacToe?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.ticTacToe.pushState(null);
      clearGamePresence();
      return;
    }
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = pub.settings?.playMode === 'solo'
      ? []
      : (api.contacts() || [])
        .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
        .map((contact) => ({
          peerId: contact.id,
          name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
        }));
    window.bluetalk.ticTacToe.pushState({ public: pub, inviteCandidates });
    syncGamePresence();
  }

  async function pumpStateToWindow() {
    tryPump();
    for (const delayMs of [150, 400, 900]) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      tryPump();
    }
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.ticTacToe?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'tic-tac-toe' || !msg.ticTacToe) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.ticTacToe;
    const selfId = tttSelfPeerId;

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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: w.reason || 'Beitritt abgelehnt.' });
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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: w.reason || 'Du wurdest aus dem Spiel entfernt.' });
      clientState = null;
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.ticTacToe?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.ticTacToe.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.ticTacToe.pendingJoin');
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
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    tttSelfPeerId = peerInfo.id;
    tttSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('ticTacToeSettings', defaultSettings());
    host = spawnHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    await openGameWindowIfNeeded();
    await pumpStateToWindow();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedTicTacToeGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Tic-Tac-Toe',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function joinGame(pending) {
    await refreshSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige Tic-Tac-Toe-Einladung.' };
    }
    if (!tttSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einem anderen Tic-Tac-Toe-Spiel.';
      api.notify.toast?.({ title: 'Tic-Tac-Toe', message });
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
      settings: sanitizeSettings(pending.ticTacToeSettings || {}),
      message: 'Verbindung zum Tisch wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      gameId: pending.gameId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: tttSelfPeerName || 'Spieler',
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
    if (msg.kind !== 'tic-tac-toe' || !msg.ticTacToe || isContactBlocked(msg.from)) return;
    if (host && msg.from !== tttSelfPeerId) host.onWire(msg.from, msg.ticTacToe);
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
        name: tttSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChild = null;
  if (window.bluetalk?.ticTacToe?.onFromChild) {
    offChild = window.bluetalk.ticTacToe.onFromChild((payload) => {
      if (!payload) return;
      const pid = tttSelfPeerId;

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
      } else if (payload.type === 'train_ai') {
        hostRef?.trainAi(payload.games);
      } else if (payload.type === 'reset_ai_model') {
        hostRef?.resetAiModel();
      }
    });
  }

  void refreshSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedTicTacToeGame', null)));
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

  api.log.info('Tic-Tac-Toe-Plugin UI geladen');
}
