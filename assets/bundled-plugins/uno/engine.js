/**
 * UNO — host-autoritative Spiel-Zustandsmaschine.
 *
 * `makeCreateHost({ api, wire })` bindet die Plugin-API und die Draht-Sender
 * und liefert eine `createHost(settings, onTick, me, restoredGame)`-Fabrik mit
 * unveränderter Signatur. Die Zustandslogik ist host-autoritativ: eingehende
 * Aktionen werden gegen Zugreihenfolge und Regeln validiert, bevor sie greifen.
 */

import {
  COLORS,
  buildDeck,
  shuffle,
  cardPoints,
  cardLabel,
  isSpecialStartCard,
} from './deck.js';
import {
  clampInt,
  defaultSettings,
  sanitizeSettings,
  canPlay,
  canStackDraw,
  isValidColor,
} from './rules.js';
import { isContactBlocked, sanitizeIncomingAction, sanitizeName } from './net.js';

export function makeCreateHost({ api, wire }) {
  const sendWire = wire.send;
  const broadcastWire = wire.broadcast;

  return function createHost(settings, onTick, me, restoredGame = null) {
    const selfId = me?.id;
    const gameId = restoredGame?.gameId
      || `uno_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
    const minSeats = Math.max(2, ...restoredPlayers.map((p) => Number(p?.seat) + 1 || 0));
    const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings(), minSeats);
    const players = [];
    let phase = 'lobby';
    let direction = 1;
    let activeColor = null;
    let drawPile = [];
    let discardPile = [];
    let toActIdx = -1;
    let dealerIdx = -1;
    let roundNumber = clampInt(restoredGame?.roundNumber, 0, 1000000, 0);
    let roundWinner = null;
    let matchWinner = null;
    let message = '';
    let pendingColorChoice = null;
    let pendingDrawStack = 0;
    let pendingDrawType = null;
    let drewCanPass = null;
    let pendingUnoPeer = null;
    let turnTimer = null;
    let autoStartTimer = null;
    let savedAt = Number(restoredGame?.savedAt) || 0;
    let lastEvent = null;
    let eventSeq = 0;
    const invitedPeers = new Set(Array.isArray(restoredGame?.invitedPeers) ? restoredGame.invitedPeers : []);

    for (const row of restoredPlayers) {
      if (!row?.peerId || players.some((p) => p.peerId === row.peerId)) continue;
      const isSelf = row.peerId === selfId;
      players.push({
        peerId: row.peerId,
        name: sanitizeName(row.name, row.peerId),
        seat: clampInt(row.seat, 0, cfg.maxPlayers - 1, players.length),
        hand: [],
        saidUno: false,
        score: clampInt(row.score, 0, 1000000, 0),
        connected: isSelf || (api.peers() || []).some((p) => p.id === row.peerId),
      });
    }
    players.sort((a, b) => a.seat - b.seat);

    function peerIds() {
      return players.map((p) => p.peerId);
    }

    function clearTurnTimer() {
      if (turnTimer) {
        api.timer.clearTimeout(turnTimer);
        turnTimer = null;
      }
    }

    function clearAutoStartTimer() {
      if (autoStartTimer) {
        api.timer.clearTimeout(autoStartTimer);
        autoStartTimer = null;
      }
    }

    function emitEvent(type, peerId, card, color) {
      lastEvent = { type, peerId, card: card ? { ...card } : null, color: color || null, at: Date.now(), seq: ++eventSeq };
    }

    function activePlayers() {
      return players.filter((p) => p.connected !== false);
    }

    function playerIndex(peerId) {
      return players.findIndex((p) => p.peerId === peerId);
    }

    // Nächster Sitz in Spielrichtung; überspringt offline Spieler, damit die
    // Runde nicht auf einem getrennten Peer stehen bleibt.
    function nextIndex(fromIdx, steps = 1) {
      const n = players.length;
      if (!n) return -1;
      let idx = fromIdx;
      for (let s = 0; s < steps; s++) {
        idx = (idx + direction + n) % n;
        let guard = 0;
        while (players[idx]?.connected === false && guard < n) {
          idx = (idx + direction + n) % n;
          guard += 1;
        }
      }
      return idx;
    }

    function checkpoint(reason = 'auto') {
      savedAt = Date.now();
      const saved = {
        version: 1,
        gameId,
        savedAt,
        reason,
        roundNumber,
        settings: { ...cfg },
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          score: p.score,
        })),
      };
      api.storage.set('savedUnoGame', saved);
      api.storage.set('unoSettings', { ...cfg });
      return saved;
    }

    function scheduleAutoStart() {
      clearAutoStartTimer();
      if (!cfg.autoStart || phase !== 'lobby') return;
      if (activePlayers().length >= 2) {
        autoStartTimer = api.timer.setTimeout(() => {
          if (phase === 'lobby') startGame();
        }, 5000);
      }
    }

    function scheduleTurnTimer() {
      clearTurnTimer();
      const sec = Number(cfg.turnTimeSec) || 0;
      if (sec <= 0 || phase !== 'playing') return;
      const actor = toActIdx >= 0 ? players[toActIdx] : null;
      if (!actor || actor.connected === false) return;
      turnTimer = api.timer.setTimeout(() => {
        if (phase !== 'playing' || toActIdx < 0) return;
        const current = players[toActIdx];
        if (!current) return;
        if (pendingColorChoice === current.peerId) {
          applyAction(current.peerId, { type: 'chooseColor', color: activeColor || 'red' });
          return;
        }
        if (pendingDrawStack > 0 && cfg.houseRules === 'official') {
          forceDrawStack(current.peerId);
          return;
        }
        applyAction(current.peerId, { type: 'draw' });
      }, sec * 1000);
    }

    function ensureDrawPile() {
      if (drawPile.length > 0) return true;
      if (discardPile.length <= 1) return false;
      const top = discardPile.pop();
      drawPile = shuffle(discardPile);
      discardPile = top ? [top] : [];
      return drawPile.length > 0;
    }

    function drawCardsFor(player, count) {
      const drawn = [];
      for (let i = 0; i < count; i++) {
        if (!ensureDrawPile()) break;
        const card = drawPile.pop();
        player.hand.push(card);
        drawn.push(card);
      }
      return drawn;
    }

    function sendHand(p) {
      if (!p || p.peerId === selfId) return;
      sendWire(p.peerId, { wire: 'hand', gameId, cards: p.hand.map((c) => ({ ...c })) });
    }

    function sendAllHands() {
      for (const p of players) sendHand(p);
    }

    function topCard() {
      return discardPile.length ? discardPile[discardPile.length - 1] : null;
    }

    function checkUnoPenalty(peerId) {
      const p = players.find((x) => x.peerId === peerId);
      if (!p || p.hand.length !== 1) return;
      if (p.saidUno) return;
      const n = cfg.penaltyCards;
      drawCardsFor(p, n);
      message = `${p.name} hat UNO vergessen und zieht ${n} Karten.`;
      emitEvent('penalty', peerId, null, null);
    }

    function applyPointsForRound(winnerPeerId) {
      if (cfg.gameMode !== 'points') return;
      const winner = players.find((p) => p.peerId === winnerPeerId);
      if (!winner) return;
      let points = 0;
      for (const p of players) {
        if (p.peerId === winnerPeerId) continue;
        points += p.hand.reduce((sum, c) => sum + cardPoints(c), 0);
      }
      winner.score += points;
      if (winner.score >= cfg.targetScore) {
        matchWinner = winnerPeerId;
        phase = 'matchOver';
        message = `${winner.name} gewinnt das Match mit ${winner.score} Punkten!`;
      }
    }

    function finishRound(winnerPeerId) {
      roundWinner = winnerPeerId;
      pendingColorChoice = null;
      pendingDrawStack = 0;
      pendingDrawType = null;
      drewCanPass = null;
      pendingUnoPeer = null;
      applyPointsForRound(winnerPeerId);
      if (phase !== 'matchOver') {
        phase = 'roundOver';
        const w = players.find((p) => p.peerId === winnerPeerId);
        message = cfg.gameMode === 'points'
          ? `${w?.name || 'Spieler'} gewinnt die Runde!`
          : `${w?.name || 'Spieler'} hat UNO!`;
      }
      clearTurnTimer();
      checkpoint('round_end');
    }

    function resolveSkip() {
      toActIdx = nextIndex(toActIdx, 2);
    }

    function resolveReverse() {
      if (players.length === 2) {
        resolveSkip();
        return;
      }
      direction *= -1;
      toActIdx = nextIndex(toActIdx, 1);
    }

    function resolveDrawTwo() {
      if (cfg.houseRules === 'casual') {
        pendingDrawStack += 2;
        pendingDrawType = 'draw2';
        toActIdx = nextIndex(toActIdx, 1);
        return;
      }
      const nextIdx = nextIndex(toActIdx, 1);
      const nextPlayer = players[nextIdx];
      drawCardsFor(nextPlayer, 2);
      emitEvent('draw', nextPlayer.peerId, null, null);
      toActIdx = nextIndex(nextIdx, 1);
    }

    function resolveDrawFour() {
      if (cfg.houseRules === 'casual') {
        pendingDrawStack += 4;
        pendingDrawType = 'draw4';
        toActIdx = nextIndex(toActIdx, 1);
        return;
      }
      const nextIdx = nextIndex(toActIdx, 1);
      const nextPlayer = players[nextIdx];
      drawCardsFor(nextPlayer, 4);
      emitEvent('draw', nextPlayer.peerId, null, null);
      toActIdx = nextIndex(nextIdx, 1);
    }

    function forceDrawStack(peerId) {
      const p = players.find((x) => x.peerId === peerId);
      if (!p) return;
      if (pendingDrawStack <= 0) return;
      const count = pendingDrawStack;
      const drawn = drawCardsFor(p, count);
      pendingDrawStack = 0;
      pendingDrawType = null;
      drewCanPass = null;
      emitEvent('draw', peerId, null, null);
      message = drawn.length === count
        ? `${p.name} zieht ${count} Karten.`
        : `${p.name} zieht ${drawn.length} Karten (Stapel erschöpft).`;
      toActIdx = nextIndex(playerIndex(peerId), 1);
      scheduleTurnTimer();
    }

    function afterCardPlayed(player, card) {
      if (player.hand.length === 1) {
        pendingUnoPeer = player.peerId;
        player.saidUno = false;
      } else {
        player.saidUno = false;
      }

      if (player.hand.length === 0) {
        finishRound(player.peerId);
        return true;
      }

      if (card.value === 'skip') resolveSkip();
      else if (card.value === 'reverse') resolveReverse();
      else if (card.value === 'draw2') resolveDrawTwo();
      else toActIdx = nextIndex(toActIdx, 1);

      return false;
    }

    function publicState() {
      const actor = toActIdx >= 0 ? players[toActIdx] : null;
      return {
        gameId,
        hostPeerId: selfId,
        phase,
        direction,
        activeColor,
        topCard: topCard() ? { ...topCard() } : null,
        drawPileCount: drawPile.length,
        discardCount: discardPile.length,
        toAct: actor?.peerId || null,
        roundNumber,
        roundWinner,
        matchWinner,
        pendingColorChoice,
        pendingDrawStack,
        pendingDrawType,
        drewCanPass,
        pendingUnoPeer,
        savedAt,
        message,
        lastEvent: lastEvent ? { ...lastEvent, card: lastEvent.card ? { ...lastEvent.card } : null } : null,
        settings: { ...cfg },
        players: players.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          seat: p.seat,
          cardCount: p.hand.length,
          saidUno: p.saidUno,
          score: p.score,
          connected: p.connected !== false,
        })),
      };
    }

    function pushState() {
      broadcastWire({ wire: 'state', gameId, public: publicState() }, peerIds());
      sendAllHands();
      onTick?.();
    }

    function findSeat() {
      const taken = new Set(players.map((p) => p.seat));
      for (let s = 0; s < cfg.maxPlayers; s++) if (!taken.has(s)) return s;
      return -1;
    }

    function addPlayer(peerId, name) {
      const existing = players.find((p) => p.peerId === peerId);
      if (existing) {
        existing.connected = true;
        existing.name = sanitizeName(name, existing.name);
        pushState();
        return true;
      }
      if (players.length >= cfg.maxPlayers) return false;
      const seat = findSeat();
      if (seat < 0) return false;
      players.push({
        peerId,
        name: sanitizeName(name, peerId),
        seat,
        hand: [],
        saidUno: false,
        score: 0,
        connected: true,
      });
      players.sort((a, b) => a.seat - b.seat);
      if (phase === 'lobby') scheduleAutoStart();
      checkpoint('join');
      pushState();
      return true;
    }

    // Vollständiges Entfernen: freiwilliges Verlassen / Kick / Trennung in der Lobby.
    function dropPlayer(peerId) {
      const idx = playerIndex(peerId);
      if (idx < 0 || peerId === selfId) return;
      const wasActor = idx === toActIdx;
      if (idx < toActIdx) toActIdx -= 1;
      players.splice(idx, 1);
      if (toActIdx >= players.length) toActIdx = 0;
      if (dealerIdx >= players.length) dealerIdx = Math.max(0, players.length - 1);
      if (pendingColorChoice === peerId) pendingColorChoice = null;
      if (drewCanPass === peerId) drewCanPass = null;
      if (pendingUnoPeer === peerId) pendingUnoPeer = null;
      if (phase === 'playing' && activePlayers().length < 2) {
        phase = 'lobby';
        message = 'Zu wenige Spieler — zurück in die Lobby.';
        clearTurnTimer();
      } else if (phase === 'playing' && wasActor) {
        if (players[toActIdx]?.connected === false) toActIdx = nextIndex(toActIdx, 1);
        scheduleTurnTimer();
      }
      checkpoint('leave');
      pushState();
    }

    // Transiente Trennung: in laufender Runde Sitz + Hand behalten, damit der
    // Spieler wieder beitreten kann; sonst Sitz freigeben.
    function handleDisconnect(peerId) {
      if (peerId === selfId) return;
      const idx = playerIndex(peerId);
      if (idx < 0) return;
      if (phase !== 'playing') {
        dropPlayer(peerId);
        return;
      }
      const player = players[idx];
      if (player.connected === false) return;
      player.connected = false;

      // Offene Verpflichtungen des getrennten Spielers auflösen, damit die
      // Runde nicht blockiert.
      if (pendingColorChoice === peerId) {
        pendingColorChoice = null;
        activeColor = activeColor || COLORS[0];
        const played = topCard();
        if (played?.value === 'wild4' && cfg.houseRules === 'official') resolveDrawFour();
        else toActIdx = nextIndex(toActIdx, 1);
      } else if (idx === toActIdx) {
        pendingDrawStack = 0;
        pendingDrawType = null;
        if (activePlayers().length >= 2) toActIdx = nextIndex(toActIdx, 1);
      }
      if (drewCanPass === peerId) drewCanPass = null;
      if (pendingUnoPeer === peerId) pendingUnoPeer = null;

      if (activePlayers().length < 2) {
        message = `Warte auf Wiederverbindung von ${player.name}…`;
        clearTurnTimer();
      } else {
        message = `${player.name} ist offline.`;
        scheduleTurnTimer();
      }
      checkpoint('disconnect');
      pushState();
    }

    // Wiederverbindung: Zustand + Hand erneut zustellen (idempotent).
    function reconnectPlayer(peerId) {
      const p = players.find((x) => x.peerId === peerId);
      if (!p || peerId === selfId) return false;
      if (p.connected !== true) {
        p.connected = true;
        message = `${p.name} ist wieder verbunden.`;
      }
      sendWire(peerId, { wire: 'state', gameId, public: publicState() });
      sendHand(p);
      if (phase === 'playing') scheduleTurnTimer();
      checkpoint('reconnect');
      pushState();
      return true;
    }

    function kickPlayer(peerId) {
      if (peerId === selfId) return false;
      const idx = playerIndex(peerId);
      if (idx < 0) return false;
      const name = players[idx].name;
      sendWire(peerId, { wire: 'kicked', gameId, reason: 'Du wurdest vom Host aus dem Spiel entfernt.' });
      dropPlayer(peerId);
      message = `${name} wurde vom Host entfernt.`;
      checkpoint('kick');
      pushState();
      return true;
    }

    function pickStarterCard() {
      const skipped = [];
      while (drawPile.length) {
        const card = drawPile.pop();
        if (!isSpecialStartCard(card)) {
          discardPile.push(card);
          activeColor = card.color;
          if (skipped.length) drawPile = shuffle([...drawPile, ...skipped]);
          return card;
        }
        skipped.push(card);
      }
      if (skipped.length) {
        const card = skipped[0];
        discardPile.push(card);
        if (card.color === 'wild') {
          activeColor = COLORS[Math.floor(Math.random() * COLORS.length)];
        } else {
          activeColor = card.color;
        }
        drawPile = shuffle(skipped.slice(1));
        return card;
      }
      return null;
    }

    function startGame() {
      if (phase !== 'lobby' && phase !== 'roundOver') return false;
      if (players.length < 2) {
        message = 'Mindestens 2 Spieler nötig.';
        pushState();
        return false;
      }
      if (activePlayers().length < 2) {
        message = 'Mindestens 2 verbundene Spieler nötig.';
        pushState();
        return false;
      }
      clearTurnTimer();
      clearAutoStartTimer();
      roundWinner = null;
      pendingColorChoice = null;
      pendingDrawStack = 0;
      pendingDrawType = null;
      drewCanPass = null;
      pendingUnoPeer = null;
      direction = 1;
      discardPile = [];
      drawPile = shuffle(buildDeck());
      for (const p of players) {
        p.hand = [];
        p.saidUno = false;
        drawCardsFor(p, 7);
      }
      pickStarterCard();
      if (!topCard()) {
        message = 'Kartenstapel konnte nicht gestartet werden.';
        phase = 'lobby';
        pushState();
        return false;
      }
      roundNumber += 1;
      dealerIdx = dealerIdx < 0 ? 0 : nextIndex(dealerIdx, 1);
      toActIdx = nextIndex(dealerIdx, 1);
      phase = 'playing';
      message = `Runde ${roundNumber} — ${players[toActIdx]?.name || 'Spieler'} beginnt.`;
      emitEvent('start', null, topCard(), activeColor);
      checkpoint('round_start');
      scheduleTurnTimer();
      pushState();
      return true;
    }

    function playCard(peerId, cardId) {
      const idx = playerIndex(peerId);
      if (idx < 0 || toActIdx !== idx || phase !== 'playing') return false;
      if (pendingColorChoice) return false;
      const player = players[idx];
      const top = topCard();
      const cardIdx = player.hand.findIndex((c) => c.id === cardId);
      if (cardIdx < 0) return false;
      const card = player.hand[cardIdx];

      if (pendingDrawStack > 0 && cfg.houseRules === 'casual') {
        if (!canStackDraw(card, pendingDrawType, cfg.houseRules)) return false;
      } else if (pendingDrawStack > 0) {
        // Offene Regel: ausstehende Ziehkarten müssen erst gezogen werden.
        return false;
      } else if (!canPlay(card, top, activeColor, cfg.houseRules, player.hand)) {
        return false;
      }

      if (pendingUnoPeer && pendingUnoPeer !== peerId) {
        checkUnoPenalty(pendingUnoPeer);
      }
      pendingUnoPeer = null;
      drewCanPass = null;

      player.hand.splice(cardIdx, 1);
      discardPile.push(card);
      emitEvent('play', peerId, card, null);

      if (card.color === 'wild') {
        pendingColorChoice = peerId;
        if (card.value === 'wild4') {
          message = `${player.name} spielt Wild +4 — Farbe wählen.`;
        } else {
          message = `${player.name} spielt Wild — Farbe wählen.`;
        }
        if (player.hand.length === 0) {
          message += ' (Gewinn nach Farbwahl)';
        }
        pushState();
        return true;
      }

      activeColor = card.color;

      if (afterCardPlayed(player, card)) {
        pushState();
        return true;
      }
      message = `${player.name} spielt ${cardLabel(card)}.`;
      scheduleTurnTimer();
      pushState();
      return true;
    }

    function chooseColor(peerId, color) {
      if (pendingColorChoice !== peerId) return false;
      if (!isValidColor(color)) return false;
      activeColor = color;
      pendingColorChoice = null;
      const player = players.find((p) => p.peerId === peerId);
      const played = topCard();
      emitEvent('color', peerId, played, color);
      message = `${player?.name || 'Spieler'} wählt ${color}.`;

      if (player && player.hand.length === 0) {
        if (played?.value === 'wild4') resolveDrawFour();
        finishRound(peerId);
        pushState();
        return true;
      }

      if (played?.value === 'wild4') {
        resolveDrawFour();
      } else {
        toActIdx = nextIndex(toActIdx, 1);
      }
      scheduleTurnTimer();
      pushState();
      return true;
    }

    function drawCard(peerId) {
      const idx = playerIndex(peerId);
      if (idx < 0 || toActIdx !== idx || phase !== 'playing') return false;
      if (pendingColorChoice) return false;

      if (pendingUnoPeer && pendingUnoPeer !== peerId) {
        checkUnoPenalty(pendingUnoPeer);
        pendingUnoPeer = null;
      }

      if (pendingDrawStack > 0) {
        forceDrawStack(peerId);
        pushState();
        return true;
      }

      const player = players[idx];
      const drawn = drawCardsFor(player, 1);
      if (!drawn.length) {
        message = 'Keine Karten mehr im Stapel — Zug wird übersprungen.';
        drewCanPass = null;
        toActIdx = nextIndex(toActIdx, 1);
        scheduleTurnTimer();
        pushState();
        return true;
      }
      emitEvent('draw', peerId, drawn[0], null);
      const top = topCard();
      if (canPlay(drawn[0], top, activeColor, cfg.houseRules, player.hand)) {
        drewCanPass = peerId;
        message = `${player.name} zieht eine Karte — spielen oder passen.`;
      } else {
        drewCanPass = null;
        message = `${player.name} zieht eine Karte und passt.`;
        toActIdx = nextIndex(toActIdx, 1);
        scheduleTurnTimer();
      }
      pushState();
      return true;
    }

    function passTurn(peerId) {
      if (drewCanPass !== peerId) return false;
      drewCanPass = null;
      if (pendingUnoPeer && pendingUnoPeer !== peerId) checkUnoPenalty(pendingUnoPeer);
      pendingUnoPeer = null;
      toActIdx = nextIndex(toActIdx, 1);
      message = `${players[playerIndex(peerId)]?.name || 'Spieler'} passt.`;
      scheduleTurnTimer();
      pushState();
      return true;
    }

    function callUno(peerId) {
      const p = players.find((x) => x.peerId === peerId);
      if (!p || p.hand.length !== 1) return false;
      p.saidUno = true;
      if (pendingUnoPeer === peerId) pendingUnoPeer = null;
      message = `${p.name} ruft UNO!`;
      pushState();
      return true;
    }

    function applyAction(peerId, action) {
      if (!action?.type) return false;
      switch (action.type) {
        case 'play':
          return playCard(peerId, action.cardId);
        case 'chooseColor':
          return chooseColor(peerId, action.color);
        case 'draw':
          return drawCard(peerId);
        case 'pass':
          return passTurn(peerId);
        case 'callUno':
          return callUno(peerId);
        default:
          return false;
      }
    }

    function onWire(from, body) {
      if (!body?.wire) return;
      if (body.wire === 'join' && body.gameId === gameId) {
        const existing = players.find((p) => p.peerId === from);
        // Wiederbeitritt eines bekannten Spielers ist jederzeit erlaubt
        // (Reconnect mitten in der Runde), ohne Sitz/Hand zu verlieren.
        if (existing) {
          existing.connected = true;
          existing.name = sanitizeName(body.name, existing.name);
          if (phase === 'lobby') scheduleAutoStart();
          else if (phase === 'playing') scheduleTurnTimer();
          sendWire(from, { wire: 'join_ok', gameId, public: publicState() });
          sendHand(existing);
          checkpoint('rejoin');
          pushState();
          return;
        }
        if (phase !== 'lobby' && phase !== 'roundOver') {
          sendWire(from, { wire: 'join_reject', gameId, reason: 'Spiel läuft bereits.' });
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
          : { wire: 'join_reject', gameId, reason: 'Tisch voll oder Beitritt fehlgeschlagen.' });
        if (ok) sendHand(players.find((p) => p.peerId === from));
        return;
      }
      if (body.wire === 'leave') {
        dropPlayer(from);
        return;
      }
      if (body.wire === 'action' && body.gameId === gameId) {
        const action = sanitizeIncomingAction(body.action);
        if (action) applyAction(from, action);
      }
    }

    function bootstrapHost() {
      addPlayer(selfId, me?.name || 'Host');
      checkpoint(restoredGame ? 'resumed' : 'game_created');
    }

    return {
      gameId,
      cfg,
      bootstrapHost,
      getMyHand() {
        const p = players.find((x) => x.peerId === selfId);
        return (p?.hand || []).map((c) => ({ ...c }));
      },
      get settings() {
        return cfg;
      },
      updateSettings(patch) {
        const occupiedSeats = Math.max(2, ...players.map((p) => p.seat + 1));
        Object.assign(cfg, sanitizeSettings(patch, cfg, occupiedSeats));
        message = phase === 'lobby' || phase === 'roundOver'
          ? 'Einstellungen aktualisiert.'
          : 'Einstellungen gespeichert — gelten ab der nächsten Runde.';
        if (phase === 'lobby') scheduleAutoStart();
        checkpoint('settings');
        pushState();
      },
      invitePeer(peerId) {
        if (!peerId || players.some((p) => p.peerId === peerId)) return false;
        const connected = (api.peers() || []).some((p) => p.id === peerId);
        if (!connected || isContactBlocked(api, peerId)) return false;
        invitedPeers.add(peerId);
        void api.chat.send(peerId, this.invitePayload());
        message = 'Einladung wurde im Chat gesendet.';
        pushState();
        return true;
      },
      saveNow() {
        if (phase === 'playing') {
          message = 'Während einer laufenden Runde wird automatisch gespeichert.';
          pushState();
          return false;
        }
        checkpoint('manual');
        message = 'Spielstand gespeichert.';
        pushState();
        return true;
      },
      invitePayload() {
        const modeLabel = cfg.gameMode === 'points' ? `Punkte bis ${cfg.targetScore}` : 'Einzelrunde';
        const rulesLabel = cfg.houseRules === 'casual' ? 'Casual' : 'Offiziell';
        const sum = `UNO · max. ${cfg.maxPlayers} · ${modeLabel} · ${rulesLabel}`;
        return {
          kind: 'uno-invite',
          gameId,
          tableName: cfg.tableName,
          hostPeerId: selfId,
          unoSettings: { ...cfg },
          unoSettingsSummary: sum,
          lobbyAccess: cfg.lobbyAccess,
          content: `🎴 ${cfg.tableName} — ${sum}`,
        };
      },
      startGame,
      onWire,
      handleDisconnect,
      reconnectPlayer,
      removePlayer: dropPlayer,
      kickPlayer,
      publicState,
      pushState,
      applyAction: (pid, a) => applyAction(pid, a),
      destroy() {
        clearTurnTimer();
        clearAutoStartTimer();
      },
    };
  };
}
