/**
 * BlueTalk Poker — Texas Hold'em (Host-autoritativ, P2P).
 *
 * ui.js ist der Plugin-Entry (statisch von pluginRuntime geladen). Die reine
 * Logik liegt in Geschwister-Modulen:
 *   - cards.js     Deck/Karten/Bot-ID
 *   - handRank.js  Hand-Bewertung
 *   - betting.js   Side-Pots & Tisch-Einstellungen
 *   - engine.js    host-autoritative Zustandsmaschine (createHost)
 * Hier bleibt die zustandsbehaftete Orchestrierung: registerCommand, Host-/
 * Client-Lebenszyklus, P2P-Events und das Spielfenster.
 */
import { isPokerBotId } from './cards.js';
import { scoreFive, cmpScore, best7 } from './handRank.js';
import {
  buildSidePots,
  defaultSettings,
  sanitizeSettings,
  isPokerLobbyJoinable,
} from './betting.js';
import { createHost } from './engine.js';

export default function activatePokerPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isPokerBotId(peerId)) return;
    if (isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'poker', poker: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  const GAME_PRESENCE_KIND = 'game-presence';
  const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

  const hostDeps = { api, sendWire, broadcastWire, isContactBlocked };

  if (window.__BLUETALK_POKER_TEST_HOOKS__) {
    Object.assign(window.__BLUETALK_POKER_TEST_HOOKS__, {
      scoreFive,
      cmpScore,
      best7,
      buildSidePots,
      sanitizeSettings,
      // Kompatibel zur alten 4-Argument-Signatur (deps werden hier injiziert).
      createHost: (settings, onTick, meArg, restoredGame) =>
        createHost(hostDeps, settings, onTick, meArg, restoredGame),
    });
  }

  /** --- Client / Gast --- */
  let host = null;
  /** @type {ReturnType<typeof createHost> | null} */
  let hostRef = null;
  /** peer.getInfo() ist async — zwischengespeichertes eigenes Profil */
  let pokerSelfPeerId = '';
  let pokerSelfPeerName = '';
  let clientState = null;
  let myHole = [];
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'poker',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !pokerSelfPeerId) {
      clearGamePresence();
      return;
    }
    const sessionId = pub.tableId;
    const playerCount = (pub.players || []).length;
    const maxPlayers = pub.settings?.maxPlayers || 6;
    const role = hostRef ? 'host' : 'player';
    const phase = pub.phase || 'lobby';
    const joinable = role === 'host' && isPokerLobbyJoinable(phase) && playerCount < maxPlayers;
    lastPresenceSession = sessionId;
    api.peer.broadcast({
      kind: GAME_PRESENCE_KIND,
      game: 'poker',
      sessionId,
      tableName: pub.settings?.tableName || 'Poker-Tisch',
      phase,
      lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
      role,
      hostPeerId: pub.hostPeerId || pokerSelfPeerId,
      playerCount,
      maxPlayers,
      joinable,
      timestamp: Date.now(),
    });
  }

  async function refreshPokerSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      pokerSelfPeerId = i?.id || '';
      pokerSelfPeerName = i?.name || '';
    } catch {
      pokerSelfPeerId = '';
      pokerSelfPeerName = '';
    }
    return pokerSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.poker?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.poker.pushState(null);
      clearGamePresence();
      return;
    }
    const hole = hostRef ? hostRef.getMyHole() : myHole;
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.poker.pushState({ public: pub, myHole: hole, inviteCandidates });
    syncGamePresence();
  }

  async function openGameWindowIfNeeded() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) return;
    try {
      await window.bluetalk?.poker?.openGameWindow?.();
    } catch {
      /* ignore */
    }
  }

  function handleWire(msg) {
    if (msg.kind !== 'poker' || !msg.poker) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.poker;
    const selfId = pokerSelfPeerId;

    if (w.wire === 'hole' && w.tableId === clientState?.tableId) {
      if (host) return;
      if (clientState?.hostPeerId && msg.from !== clientState.hostPeerId) return;
      myHole = w.cardsRaw || [];
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        notifyLauncherRefresh();
        return;
      }
      if (host) return;
      if (!clientState || clientState.tableId !== w.tableId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.tableId) {
      api.notify.toast?.({ title: 'Poker', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'Poker', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.tableId || w.tableId === clientState?.tableId) {
        clientState = null;
        myHole = [];
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.tableId === w.tableId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myHole = [];
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.tableId || w.tableId === clientState?.tableId)) {
      api.notify.toast?.({ title: 'Poker', message: w.reason || 'Du wurdest vom Tisch entfernt.' });
      clientState = null;
      myHole = [];
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.poker?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.poker.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.poker.pendingJoin');
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
      api.notify.toast?.({ title: 'Poker', message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' });
      return { ok: false };
    }
    pokerSelfPeerId = peerInfo.id;
    pokerSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('pokerSettings', defaultSettings());
    host = createHost(hostDeps, settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    myHole = [];
    await openGameWindowIfNeeded();
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshPokerSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedPokerGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'Poker-Tisch',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function joinGame(pending) {
    await refreshPokerSelfId();
    if (!pending?.hostPeerId || !pending?.tableId) {
      return { ok: false, message: 'Ungültige Poker-Einladung.' };
    }
    if (!pokerSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameTable = !host
      && clientState?.tableId === pending.tableId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameTable) {
      const message = 'Du bist bereits an einem anderen Poker-Tisch.';
      api.notify.toast?.({ title: 'Poker', message });
      return { ok: false, message };
    }
    if (sameTable) {
      await openGameWindowIfNeeded();
      tryPump();
      return { ok: true };
    }

    clientState = {
      tableId: pending.tableId,
      hostPeerId: pending.hostPeerId,
      phase: 'lobby',
      players: [],
      settings: sanitizeSettings(pending.pokerSettings || {}),
      message: 'Verbindung zum Tisch wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      tableId: pending.tableId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      tableId: pending.tableId,
      name: pokerSelfPeerName || 'Spieler',
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

  const offPokerMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'poker' || !msg.poker || isContactBlocked(msg.from)) return;
    if (host && msg.from !== pokerSelfPeerId) host.onWire(msg.from, msg.poker);
    handleWire(msg);
  });
  const offPokerDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offPokerConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.tableId) {
      sendWire(peer.id, {
        wire: 'join',
        tableId: clientState.tableId,
        name: pokerSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  // Handle actions from game window
  let offPokerChild = null;
  if (window.bluetalk?.poker?.onFromChild) {
    offPokerChild = window.bluetalk.poker.onFromChild((payload) => {
      if (!payload) return;

      const pid = pokerSelfPeerId;

      if (payload.type === 'request_state') {
        tryPump();
      } else if (payload.type === 'action' && payload.action) {
        if (hostRef) {
          hostRef.applyAction(pid, payload.action);
        } else if (clientState?.hostPeerId && clientState?.tableId) {
          sendWire(clientState.hostPeerId, {
            wire: 'action',
            tableId: clientState.tableId,
            action: payload.action,
          });
        }
      } else if (payload.type === 'host_start') {
        if (hostRef) {
          hostRef.startHand();
        }
      } else if (payload.type === 'leave') {
        if (hostRef) {
          broadcastWire({ wire: 'leave', tableId: hostRef.tableId }, hostRef.publicState().players.map((p) => p.peerId));
          hostRef.destroy();
          hostRef = null;
          host = null;
        } else if (clientState?.hostPeerId) {
          sendWire(clientState.hostPeerId, { wire: 'leave', tableId: clientState.tableId });
        }
        clearGamePresence();
        clientState = null;
        myHole = [];
        tryPump();
        notifyLauncherRefresh();
      } else if (payload.type === 'add_bot') {
        if (hostRef) {
          hostRef.addDebugBot();
        }
      } else if (payload.type === 'remove_bot') {
        if (hostRef) {
          hostRef.removeDebugBot();
        }
      } else if (payload.type === 'update_settings' && payload.settings) {
        if (hostRef) {
          hostRef.updateSettings(payload.settings);
        }
      } else if (payload.type === 'invite' && payload.peerId) {
        hostRef?.invitePeer(payload.peerId);
      } else if (payload.type === 'admin_add_chips' && payload.peerId) {
        hostRef?.addChips(payload.peerId, payload.amount);
      } else if (payload.type === 'admin_remove_chips' && payload.peerId) {
        hostRef?.removeChips(payload.peerId, payload.amount);
      } else if (payload.type === 'kick_player' && payload.peerId) {
        hostRef?.kickPlayer(payload.peerId);
      } else if (payload.type === 'save_game') {
        hostRef?.saveNow();
      }
    });
  }

  void refreshPokerSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedPokerGame', null)));
  api.ui.registerCommand('join', (pending) => joinGame(pending));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offPokerChild?.();
    offPokerMessage?.();
    offPokerDisconnect?.();
    offPokerConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
    /* noop */
  });

  api.log.info('Poker-Plugin UI geladen');
}
