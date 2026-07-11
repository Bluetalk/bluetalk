/**
 * BlueTalk Schach — Host-autoritativ, 2 Spieler, P2P.
 *
 * ui.js ist der Plugin-Entry (statisch von pluginRuntime geladen). Die reine
 * Schachlogik liegt in Geschwister-Modulen:
 *   - board.js  Setup/FEN/Notation/Einstellungen
 *   - moves.js  Zuggenerierung & Feld-Angriff pro Figur
 *   - rules.js  Legalität, Schach/Matt/Patt, Rochade/En-passant/Promotion, Remis
 *   - engine.js host-autoritative Zustandsmaschine (createHost)
 * Hier bleibt die zustandsbehaftete Orchestrierung: registerCommand, Host-/
 * Client-Lebenszyklus, P2P-Events und das Spielfenster.
 */
import {
  START_FEN,
  sanitizeSettings,
  defaultSettings,
  createInitialState,
  parseFen,
  boardToFen,
  sqToAlg,
  algToSq,
} from './board.js';
import {
  getLegalMoves,
  applyMove,
  isInCheck,
  isCheckmate,
  isStalemate,
  isInsufficientMaterial,
  isFiftyMoveDraw,
  normalizeMove,
  moveToSan,
} from './rules.js';
import { createHost } from './engine.js';

export default function activateChessPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  window.__BLUETALK_CHESS_TEST_HOOKS__ = window.__BLUETALK_CHESS_TEST_HOOKS__ || {};

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'chess', chess: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  function isChessLobbyJoinable(phase) {
    return phase === 'lobby';
  }

  const hostDeps = { api, sendWire, broadcastWire, isContactBlocked };

  Object.assign(window.__BLUETALK_CHESS_TEST_HOOKS__, {
    START_FEN,
    createInitialState,
    parseFen,
    boardToFen,
    sqToAlg,
    algToSq,
    getLegalMoves,
    applyMove,
    isInCheck,
    isCheckmate,
    isStalemate,
    isInsufficientMaterial,
    isFiftyMoveDraw,
    normalizeMove,
    moveToSan,
    sanitizeSettings,
    // Kompatibel zur alten 4-Argument-Signatur (deps werden hier injiziert).
    createHost: (settings, onTick, meArg, restoredGame) =>
      createHost(hostDeps, settings, onTick, meArg, restoredGame),
  });

  let host = null;
  let hostRef = null;
  let chessSelfPeerId = '';
  let chessSelfPeerName = '';
  let clientState = null;
  let myLegalMoves = [];
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'chess',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !chessSelfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.gameId;
    const playerCount = (pub.players || []).length;
    const maxPlayers = 2;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isChessLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'chess',
      sessionId,
      tableName: pub.settings?.tableName || 'Schach-Partie',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || chessSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshChessSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      chessSelfPeerId = i?.id || '';
      chessSelfPeerName = i?.name || '';
    } catch {
      chessSelfPeerId = '';
      chessSelfPeerName = '';
    }
    return chessSelfPeerId;
  }

  function myColorFromState(pub) {
    if (!pub?.players || !chessSelfPeerId) return null;
    const me = pub.players.find((p) => p.peerId === chessSelfPeerId);
    return me?.color || null;
  }

  function tryPump() {
    if (!window.bluetalk?.chess?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.chess.pushState(null);
      clearGamePresence();
      return;
    }
    if (hostRef) {
      myLegalMoves = hostRef.getLegalMovesForPeer(chessSelfPeerId);
    }
    // Beim Client (Mitspieler) NICHT zurücksetzen: myLegalMoves stammt aus dem
    // letzten 'state'-Wire des Hosts. Ein Reset auf [] würde alle legalen Züge
    // verwerfen, sodass der Gast keine Figur ziehen könnte.
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.chess.pushState({
      public: pub,
      myColor: myColorFromState(pub),
      myLegalMoves,
      inviteCandidates,
    });
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.chess?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'chess' || !msg.chess) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.chess;
    const selfId = chessSelfPeerId;

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      myLegalMoves = w.legalMoves || myLegalMoves;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      if (w.public) clientState = w.public;
      api.notify.toast?.({ title: 'Schach', message: 'Der Partie beigetreten.' });
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Schach', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        myLegalMoves = [];
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myLegalMoves = [];
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'Schach', message: w.reason || 'Du wurdest aus der Partie entfernt.' });
      clientState = null;
      myLegalMoves = [];
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.chess?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.chess.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.chess.pendingJoin');
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
      api.notify.toast?.({ title: 'Schach', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    chessSelfPeerId = peerInfo.id;
    chessSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('chessSettings', defaultSettings());
    host = createHost(hostDeps, settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    myLegalMoves = host.getLegalMovesForPeer(chessSelfPeerId);
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshChessSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedChessGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Schach-Partie',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function joinGame(pending) {
    await refreshChessSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige Schach-Einladung.' };
    }
    if (!chessSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einer anderen Schach-Partie.';
      api.notify.toast?.({ title: 'Schach', message });
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
      settings: sanitizeSettings(pending.chessSettings || {}),
      message: 'Verbindung zur Partie wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      gameId: pending.gameId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: chessSelfPeerName || 'Spieler',
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

  const offChessMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'chess' || !msg.chess || isContactBlocked(msg.from)) return;
    if (host && msg.from !== chessSelfPeerId) host.onWire(msg.from, msg.chess);
    handleWire(msg);
  });
  const offChessDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offChessConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: chessSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offChessChild = null;
  if (window.bluetalk?.chess?.onFromChild) {
    offChessChild = window.bluetalk.chess.onFromChild((payload) => {
      if (!payload) return;
      const pid = chessSelfPeerId;

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
        myLegalMoves = [];
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

  void refreshChessSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedChessGame', null)));
  api.ui.registerCommand('join', (pending) => joinGame(pending));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offChessChild?.();
    offChessMessage?.();
    offChessDisconnect?.();
    offChessConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
  });

  api.log.info('Schach-Plugin UI geladen');
}
