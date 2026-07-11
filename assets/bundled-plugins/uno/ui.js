/**
 * BlueTalk UNO — Host-autoritativ, P2P.
 *
 * Dieser Einstieg orchestriert nur: Launcher-Commands, Host-/Gast-Verwaltung,
 * Event-Handler und das Spielfenster. Die reine Spiellogik liegt in den
 * Geschwister-Modulen deck.js / rules.js / engine.js / net.js / presence.js.
 */
import { buildDeck, cardPoints, isSpecialStartCard } from './deck.js';
import { canPlay, defaultSettings, hasMatchingColor, sanitizeSettings } from './rules.js';
import { createWire, isContactBlocked, sanitizeIncomingAction } from './net.js';
import { makeCreateHost } from './engine.js';
import {
  GAME_PRESENCE_KIND,
  GAME_PRESENCE_CLEAR_KIND,
  buildPresencePayload,
} from './presence.js';

export default function activateUnoPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;
  const wire = createWire(api);
  const sendWire = wire.send;
  const broadcastWire = wire.broadcast;
  const createHost = makeCreateHost({ api, wire });

  if (window.__BLUETALK_UNO_TEST_HOOKS__) {
    Object.assign(window.__BLUETALK_UNO_TEST_HOOKS__, {
      buildDeck,
      canPlay,
      cardPoints,
      sanitizeSettings,
      createHost,
      hasMatchingColor,
      isSpecialStartCard,
    });
  }

  let host = null;
  let hostRef = null;
  let unoSelfPeerId = '';
  let unoSelfPeerName = '';
  let clientState = null;
  let myHand = [];
  let lastPresenceSession = null;

  function clearGamePresence() {
    if (!lastPresenceSession) return;
    api.peer.broadcast({
      kind: GAME_PRESENCE_CLEAR_KIND,
      game: 'uno',
      sessionId: lastPresenceSession,
      timestamp: Date.now(),
    });
    lastPresenceSession = null;
  }

  function syncGamePresence() {
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub || !unoSelfPeerId) {
      clearGamePresence();
      return;
    }
    lastPresenceSession = pub.gameId;
    api.peer.broadcast(buildPresencePayload(pub, unoSelfPeerId, Boolean(hostRef)));
  }

  async function refreshUnoSelfId() {
    try {
      const i = await window.bluetalk?.peer?.getInfo?.();
      unoSelfPeerId = i?.id || '';
      unoSelfPeerName = i?.name || '';
    } catch {
      unoSelfPeerId = '';
      unoSelfPeerName = '';
    }
    return unoSelfPeerId;
  }

  function tryPump() {
    if (!window.bluetalk?.uno?.pushState) return;
    const pub = hostRef ? hostRef.publicState() : clientState;
    if (!pub) {
      window.bluetalk.uno.pushState(null);
      clearGamePresence();
      return;
    }
    const hand = hostRef ? hostRef.getMyHand() : myHand;
    const seated = new Set((pub.players || []).map((p) => p.peerId));
    const connected = new Map((api.peers() || []).map((p) => [p.id, p]));
    const inviteCandidates = (api.contacts() || [])
      .filter((contact) => contact?.id && !contact.blocked && connected.has(contact.id) && !seated.has(contact.id))
      .map((contact) => ({
        peerId: contact.id,
        name: contact.nickname || contact.name || connected.get(contact.id)?.name || contact.id,
      }));
    window.bluetalk.uno.pushState({ public: pub, myHand: hand, inviteCandidates });
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
      await window.bluetalk?.uno?.openGameWindow?.();
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

  function handleWire(msg) {
    if (msg.kind !== 'uno' || !msg.uno) return;
    if (isContactBlocked(api, msg.from)) return;
    const w = msg.uno;
    const selfId = unoSelfPeerId;

    if (w.wire === 'hand' && w.gameId === clientState?.gameId) {
      if (host) return;
      if (clientState?.hostPeerId && msg.from !== clientState.hostPeerId) return;
      myHand = Array.isArray(w.cards) ? w.cards : [];
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
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      notifyLauncherRefresh();
      return;
    }

    if (w.wire === 'join_ok' && w.gameId) {
      api.notify.toast?.({ title: 'UNO', message: 'Am Tisch angemeldet.' });
    }
    if (w.wire === 'join_reject') {
      api.notify.toast?.({ title: 'UNO', message: w.reason || 'Beitritt abgelehnt.' });
      if (!w.gameId || w.gameId === clientState?.gameId) {
        clientState = null;
        myHand = [];
        tryPump();
        notifyLauncherRefresh();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myHand = [];
      tryPump();
      notifyLauncherRefresh();
    }
    if (w.wire === 'kicked' && (!w.gameId || w.gameId === clientState?.gameId)) {
      api.notify.toast?.({ title: 'UNO', message: w.reason || 'Du wurdest aus dem Spiel entfernt.' });
      clientState = null;
      myHand = [];
      tryPump();
      notifyLauncherRefresh();
      void window.bluetalk?.uno?.closeGameWindow?.();
    }
  }

  function tryConsumePendingJoin() {
    try {
      const raw = sessionStorage.getItem('bt.uno.pendingJoin');
      if (!raw) return null;
      sessionStorage.removeItem('bt.uno.pendingJoin');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function launchHostGame(saved = null) {
    const peerInfo = await window.bluetalk?.peer?.getInfo?.();
    if (!peerInfo?.id) {
      api.notify.toast?.({ title: 'UNO', message: 'Peer-ID noch nicht verfügbar.' });
      return { ok: false };
    }
    unoSelfPeerId = peerInfo.id;
    unoSelfPeerName = peerInfo.name || '';
    const settings = saved?.settings || api.storage.get('unoSettings', defaultSettings());
    host = createHost(settings, () => {
      tryPump();
      notifyLauncherRefresh();
    }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
    hostRef = host;
    host.bootstrapHost();
    clientState = host.publicState();
    myHand = [];
    await openGameWindowIfNeeded();
    await pumpStateToWindow();
    notifyLauncherRefresh();
    return { ok: true };
  }

  async function getLauncherState() {
    await refreshUnoSelfId();
    const activeState = host ? host.publicState() : clientState;
    const savedGame = api.storage.get('savedUnoGame', null);
    return {
      active: Boolean(activeState),
      tableName: activeState?.settings?.tableName || 'UNO-Tisch',
      hasSavedGame: Boolean(savedGame?.players?.length),
    };
  }

  async function joinGame(pending) {
    await refreshUnoSelfId();
    if (!pending?.hostPeerId || !pending?.gameId) {
      return { ok: false, message: 'Ungültige UNO-Einladung.' };
    }
    if (!unoSelfPeerId) {
      return { ok: false, message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' };
    }

    const sameGame = !host
      && clientState?.gameId === pending.gameId
      && clientState?.hostPeerId === pending.hostPeerId;
    if ((host || clientState) && !sameGame) {
      const message = 'Du bist bereits in einem anderen UNO-Spiel.';
      api.notify.toast?.({ title: 'UNO', message });
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
      settings: sanitizeSettings(pending.unoSettings || {}),
      message: 'Verbindung zum Tisch wird hergestellt…',
    };
    api.log.info('Join-Anfrage wird gesendet', {
      hostPeerId: pending.hostPeerId,
      gameId: pending.gameId,
    });
    sendWire(pending.hostPeerId, {
      wire: 'join',
      gameId: pending.gameId,
      name: unoSelfPeerName || 'Spieler',
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

  const offUnoMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'uno' || !msg.uno || isContactBlocked(api, msg.from)) return;
    if (host && msg.from !== unoSelfPeerId) host.onWire(msg.from, msg.uno);
    handleWire(msg);
  });
  const offUnoDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.handleDisconnect(peerId);
  });
  const offUnoConnect = api.on('peer:connected', (peer) => {
    if (host && peer?.id) {
      // Host: einem wieder erreichbaren Sitz Zustand + Hand erneut zustellen.
      host.reconnectPlayer(peer.id);
    } else if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      // Gast: nach Reconnect erneut beitreten (behält Sitz/Hand beim Host).
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: unoSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    notifyLauncherRefresh();
  });

  let offUnoChild = null;
  if (window.bluetalk?.uno?.onFromChild) {
    offUnoChild = window.bluetalk.uno.onFromChild((payload) => {
      if (!payload) return;
      const pid = unoSelfPeerId;

      if (payload.type === 'request_state') {
        tryPump();
      } else if (payload.type === 'action' && payload.action) {
        const action = sanitizeIncomingAction(payload.action);
        if (!action) return;
        if (hostRef) {
          hostRef.applyAction(pid, action);
        } else if (clientState?.hostPeerId && clientState?.gameId) {
          sendWire(clientState.hostPeerId, {
            wire: 'action',
            gameId: clientState.gameId,
            action,
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
        myHand = [];
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

  void refreshUnoSelfId();

  api.ui.registerCommand('launcherState', () => getLauncherState());
  api.ui.registerCommand('launchNew', () => launchHostGame(null));
  api.ui.registerCommand('launchResume', () => launchHostGame(api.storage.get('savedUnoGame', null)));
  api.ui.registerCommand('join', (pending) => joinGame(pending));
  api.ui.registerCommand('openWindow', () => openGameWindowIfNeeded().then(() => {
    tryPump();
    notifyLauncherRefresh();
    return { ok: true };
  }));

  void bootstrapPendingJoin();

  api.onDeactivate(() => {
    offUnoChild?.();
    offUnoMessage?.();
    offUnoDisconnect?.();
    offUnoConnect?.();
    clearGamePresence();
    host?.destroy?.();
    host = null;
    hostRef = null;
    /* noop */
  });

  api.log.info('UNO-Plugin UI geladen');
}
