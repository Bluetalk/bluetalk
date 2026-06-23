/**
 * BlueTalk UNO — Host-autoritativ, P2P.
 */
(function unoPluginUi() {
  const api = BlueTalkPlugin;

  const COLORS = ['red', 'yellow', 'green', 'blue'];
  const NUMBER_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const ACTION_VALUES = ['skip', 'reverse', 'draw2'];
  const WILD_VALUES = ['wild', 'wild4'];

  function clampInt(value, min, max, fallback) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function defaultSettings() {
    return {
      tableName: 'UNO-Tisch',
      maxPlayers: 4,
      turnTimeSec: 0,
      autoStart: false,
      gameMode: 'single',
      houseRules: 'official',
      targetScore: 500,
      penaltyCards: 2,
    };
  }

  function sanitizeSettings(input = {}, fallback = defaultSettings(), minSeats = 2) {
    const next = { ...defaultSettings(), ...fallback, ...input };
    next.tableName = String(next.tableName || 'UNO-Tisch').trim().slice(0, 48) || 'UNO-Tisch';
    next.maxPlayers = clampInt(next.maxPlayers, Math.max(2, minSeats), 8, Math.max(4, minSeats));
    next.turnTimeSec = clampInt(next.turnTimeSec, 0, 300, fallback.turnTimeSec || 0);
    next.autoStart = next.autoStart === true;
    next.gameMode = next.gameMode === 'points' ? 'points' : 'single';
    next.houseRules = next.houseRules === 'casual' ? 'casual' : 'official';
    next.targetScore = clampInt(next.targetScore, 100, 10000, fallback.targetScore || 500);
    next.penaltyCards = clampInt(next.penaltyCards, 1, 10, fallback.penaltyCards || 2);
    return next;
  }

  function shuffle(arr) {
    const a = arr.slice();
    const buf = new Uint32Array(a.length);
    crypto.getRandomValues(buf);
    for (let i = a.length - 1; i > 0; i--) {
      const j = buf[i] % (i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function buildDeck() {
    const deck = [];
    let seq = 0;
    for (const color of COLORS) {
      deck.push({ id: `${color[0]}_0_${seq++}`, color, value: '0' });
      for (const value of NUMBER_VALUES.slice(1)) {
        deck.push({ id: `${color[0]}_${value}_a_${seq++}`, color, value });
        deck.push({ id: `${color[0]}_${value}_b_${seq++}`, color, value });
      }
      for (const value of ACTION_VALUES) {
        deck.push({ id: `${color[0]}_${value}_a_${seq++}`, color, value });
        deck.push({ id: `${color[0]}_${value}_b_${seq++}`, color, value });
      }
    }
    for (let i = 0; i < 4; i++) {
      deck.push({ id: `wild_${i}_${seq++}`, color: 'wild', value: 'wild' });
      deck.push({ id: `wild4_${i}_${seq++}`, color: 'wild', value: 'wild4' });
    }
    return deck;
  }

  function isNumberCard(card) {
    return card && NUMBER_VALUES.includes(card.value);
  }

  function isSpecialStartCard(card) {
    if (!card) return true;
    if (card.color === 'wild') return true;
    return ACTION_VALUES.includes(card.value);
  }

  function topEffectiveColor(topCard, activeColor) {
    if (!topCard) return activeColor;
    if (topCard.color === 'wild') return activeColor;
    return topCard.color;
  }

  function hasMatchingColor(hand, color) {
    if (!color || color === 'wild') return false;
    return hand.some((c) => c.color === color);
  }

  function cardsMatch(a, b, activeColor) {
    if (!a || !b) return false;
    if (a.color === 'wild' || b.color === 'wild') return true;
    const colorA = a.color === 'wild' ? activeColor : a.color;
    const colorB = b.color === 'wild' ? activeColor : b.color;
    if (colorA && colorB && colorA === colorB) return true;
    return a.value === b.value;
  }

  function canPlay(card, topCard, activeColor, houseRules, hand) {
    if (!card || !topCard) return false;
    if (card.color === 'wild') {
      if (card.value === 'wild4' && houseRules === 'official') {
        return !hasMatchingColor(hand, topEffectiveColor(topCard, activeColor));
      }
      return true;
    }
    const effColor = topEffectiveColor(topCard, activeColor);
    if (card.color === effColor) return true;
    return card.value === topCard.value;
  }

  function canStackDraw(card, pendingDrawType, houseRules) {
    if (houseRules !== 'casual' || !pendingDrawType) return false;
    if (pendingDrawType === 'draw2') return card.value === 'draw2' || card.value === 'wild4';
    if (pendingDrawType === 'draw4') return card.value === 'wild4';
    return false;
  }

  function cardPoints(card) {
    if (!card) return 0;
    if (card.value === 'wild' || card.value === 'wild4') return 50;
    if (ACTION_VALUES.includes(card.value)) return 20;
    const n = Number(card.value);
    return Number.isFinite(n) ? n : 0;
  }

  function cardLabel(card) {
    if (!card) return '';
    if (card.value === 'wild') return 'Wild';
    if (card.value === 'wild4') return '+4';
    if (card.value === 'skip') return 'Skip';
    if (card.value === 'reverse') return 'Rev';
    if (card.value === 'draw2') return '+2';
    return String(card.value);
  }

  function isContactBlocked(peerId) {
    const list = api.contacts() || [];
    return list.some((c) => c?.id === peerId && c.blocked === true);
  }

  function sendWire(peerId, body) {
    if (!peerId || isContactBlocked(peerId)) return;
    api.peer.send(peerId, { kind: 'uno', uno: body, timestamp: Date.now() });
  }

  function broadcastWire(body, peerIds) {
    for (const id of peerIds) sendWire(id, body);
  }

  function createHost(settings, onTick, me, restoredGame = null) {
    const selfId = me?.id;
    const gameId = restoredGame?.gameId || `uno_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

    for (const row of restoredPlayers) {
      if (!row?.peerId || players.some((p) => p.peerId === row.peerId)) continue;
      const isSelf = row.peerId === selfId;
      players.push({
        peerId: row.peerId,
        name: String(row.name || row.peerId).slice(0, 48),
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

    function nextIndex(fromIdx, steps = 1) {
      const list = players;
      if (!list.length) return -1;
      let idx = fromIdx;
      for (let s = 0; s < steps; s++) {
        idx = (idx + direction + list.length) % list.length;
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
      const ready = activePlayers();
      if (ready.length >= 2) {
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
      if (!actor) return;
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
      if (drawPile.length > 0) return;
      if (discardPile.length <= 1) return;
      const top = discardPile.pop();
      drawPile = shuffle(discardPile);
      discardPile = top ? [top] : [];
    }

    function drawCardsFor(player, count) {
      const drawn = [];
      for (let i = 0; i < count; i++) {
        ensureDrawPile();
        if (!drawPile.length) break;
        const card = drawPile.pop();
        player.hand.push(card);
        drawn.push(card);
      }
      return drawn;
    }

    function sendHand(p) {
      if (p.peerId === selfId) return;
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
      if (!p || pendingDrawStack <= 0) return;
      const count = pendingDrawStack;
      drawCardsFor(p, count);
      pendingDrawStack = 0;
      pendingDrawType = null;
      drewCanPass = null;
      emitEvent('draw', peerId, null, null);
      message = `${p.name} zieht ${count} Karten.`;
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
        existing.name = String(name || existing.name).slice(0, 48);
        pushState();
        return true;
      }
      if (players.length >= cfg.maxPlayers) return false;
      const seat = findSeat();
      if (seat < 0) return false;
      players.push({
        peerId,
        name: String(name || peerId).slice(0, 48),
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

    function removePlayer(peerId) {
      const idx = playerIndex(peerId);
      if (idx < 0) return;
      if (peerId === selfId) return;
      players.splice(idx, 1);
      if (toActIdx >= players.length) toActIdx = 0;
      if (dealerIdx >= players.length) dealerIdx = Math.max(0, players.length - 1);
      if (phase === 'playing' && players.length < 2) {
        phase = 'lobby';
        message = 'Zu wenige Spieler — zurück in die Lobby.';
      }
      checkpoint('leave');
      pushState();
    }

    function pickStarterCard() {
      while (drawPile.length) {
        const card = drawPile.pop();
        if (!isSpecialStartCard(card)) {
          discardPile.push(card);
          activeColor = card.color;
          return card;
        }
        drawPile.unshift(card);
        drawPile = shuffle(drawPile);
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
        message = 'Mindestens 2 verbundene Spieler noetig.';
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
      if (!COLORS.includes(color)) return false;
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

      if (pendingDrawStack > 0 && cfg.houseRules === 'official') {
        forceDrawStack(peerId);
        pushState();
        return true;
      }

      if (pendingDrawStack > 0 && cfg.houseRules === 'casual') {
        forceDrawStack(peerId);
        pushState();
        return true;
      }

      const player = players[idx];
      const drawn = drawCardsFor(player, 1);
      if (!drawn.length) {
        message = 'Keine Karten mehr im Stapel.';
        pushState();
        return false;
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
      pendingUnoPeer = null;
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
        if (phase !== 'lobby' && phase !== 'roundOver') {
          sendWire(from, { wire: 'join_reject', gameId, reason: 'Spiel läuft bereits.' });
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
        removePlayer(from);
        return;
      }
      if (body.wire === 'action' && body.gameId === gameId) {
        applyAction(from, body.action || {});
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
        if (!connected || isContactBlocked(peerId)) return false;
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
          content: `🎴 ${cfg.tableName} — ${sum}`,
        };
      },
      startGame,
      onWire,
      removePlayer,
      publicState,
      pushState,
      applyAction: (pid, a) => applyAction(pid, a),
      destroy() {
        clearTurnTimer();
        clearAutoStartTimer();
      },
    };
  }

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
  let rootRender = null;

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

  function handleWire(msg) {
    if (msg.kind !== 'uno' || !msg.uno) return;
    if (isContactBlocked(msg.from)) return;
    const w = msg.uno;
    const selfId = unoSelfPeerId;

    if (w.wire === 'hand' && w.gameId === clientState?.gameId) {
      if (host) return;
      if (clientState?.hostPeerId && msg.from !== clientState.hostPeerId) return;
      myHand = w.cards || [];
      tryPump();
      void openGameWindowIfNeeded();
      rootRender?.();
      return;
    }

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        rootRender?.();
        return;
      }
      if (host) return;
      if (!clientState || clientState.gameId !== w.gameId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      rootRender?.();
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
        rootRender?.();
      }
    }
    if (w.wire === 'leave' && clientState?.gameId === w.gameId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myHand = [];
      tryPump();
      rootRender?.();
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

  function render(container) {
    container.innerHTML = `
      <div class="uno-plugin-root">
        <div class="uno-plugin-hero">
          <h2>UNO <span class="uno-alpha-tag">Alpha</span></h2>
          <p class="uno-plugin-sub">Host erstellt das Spiel, lädt per Chat ein — bis zu 8 Spieler über P2P.</p>
          <p class="uno-alpha-notice" role="note">Alpha-Version: Spielregeln, Sync und UI können noch fehlerhaft sein und sich jederzeit ändern.</p>
        </div>
        <div class="uno-plugin-panels"></div>
      </div>
      <style>
        .uno-plugin-root { max-width: 880px; margin: 0 auto; padding: 12px 16px 32px; }
        .uno-plugin-hero h2 { margin: 0 0 6px; font-size: 1.35rem; display: flex; align-items: center; gap: 8px; }
        .uno-alpha-tag {
          display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 999px;
          font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
          color: #fde68a; background: rgba(234, 179, 8, 0.16); border: 1px solid rgba(234, 179, 8, 0.35);
        }
        .uno-alpha-notice {
          margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.45;
          color: var(--fg-2); background: rgba(234, 179, 8, 0.08); border: 1px solid rgba(234, 179, 8, 0.22);
        }
        .uno-plugin-sub { margin: 0; color: var(--fg-2); font-size: 13px; line-height: 1.45; }
        .uno-plugin-panels { margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
        .uno-card-panel {
          background: var(--bg-1); border: 1px solid var(--border); border-radius: 10px;
          padding: 14px 16px;
        }
        .uno-launch-card { min-height: 190px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 14px; }
        .uno-launch-mark { font-size: 42px; line-height: 1; }
        .uno-btn { padding: 6px 12px; border-radius: 6px; border: 0; cursor: pointer; font-size: 13px; }
        .uno-btn-primary { background: var(--accent); color: var(--accent-fg); }
        .uno-btn-ghost { background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); }
        .uno-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      </style>
    `;

    const panels = container.querySelector('.uno-plugin-panels');

    async function paint() {
      await refreshUnoSelfId();
      const pending = tryConsumePendingJoin();
      if (pending?.hostPeerId && pending?.gameId && !host && !clientState) {
        clientState = {
          gameId: pending.gameId,
          hostPeerId: pending.hostPeerId,
          phase: 'lobby',
          players: [],
          settings: sanitizeSettings(pending.unoSettings || {}),
          message: 'Verbindung zum Tisch wird hergestellt…',
        };
        sendWire(pending.hostPeerId, {
          wire: 'join',
          gameId: pending.gameId,
          name: unoSelfPeerName || 'Spieler',
        });
        await openGameWindowIfNeeded();
        tryPump();
      }

      const activeState = host ? host.publicState() : clientState;
      const savedGame = api.storage.get('savedUnoGame', null);
      panels.innerHTML = activeState
        ? `
          <div class="uno-card-panel uno-launch-card">
            <div class="uno-launch-mark">🎴</div>
            <div>
              <h3>${activeState.settings?.tableName || 'UNO-Tisch'}</h3>
              <p class="uno-plugin-sub">Spiel, Einladungen und Einstellungen werden im UNO-Fenster verwaltet.</p>
            </div>
            <button type="button" class="uno-btn uno-btn-primary" id="uno-launch-open">UNO-Fenster öffnen</button>
          </div>`
        : `
          <div class="uno-card-panel uno-launch-card">
            <div class="uno-launch-mark">🎴</div>
            <div>
              <h3>UNO-Runde starten</h3>
              <p class="uno-plugin-sub">Starte hier das Spiel — alles Weitere erledigst du im UNO-Fenster.</p>
            </div>
            <div class="uno-row">
              <button type="button" class="uno-btn uno-btn-primary" id="uno-launch-new">Neues Spiel</button>
              ${savedGame?.players?.length ? '<button type="button" class="uno-btn uno-btn-ghost" id="uno-launch-resume">Gespeichertes Spiel fortsetzen</button>' : ''}
            </div>
          </div>`;

      const launchHost = async (saved = null) => {
        const peerInfo = await window.bluetalk?.peer?.getInfo?.();
        if (!peerInfo?.id) {
          api.notify.toast?.({ title: 'UNO', message: 'Peer-ID noch nicht verfügbar.' });
          return;
        }
        unoSelfPeerId = peerInfo.id;
        unoSelfPeerName = peerInfo.name || '';
        const settings = saved?.settings || api.storage.get('unoSettings', defaultSettings());
        host = createHost(settings, () => {
          tryPump();
          rootRender?.();
        }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
        hostRef = host;
        host.bootstrapHost();
        clientState = host.publicState();
        myHand = [];
        await openGameWindowIfNeeded();
        tryPump();
        void paint();
      };

      panels.querySelector('#uno-launch-open')?.addEventListener('click', () => {
        void openGameWindowIfNeeded().then(() => tryPump());
      });
      panels.querySelector('#uno-launch-new')?.addEventListener('click', () => void launchHost(null));
      panels.querySelector('#uno-launch-resume')?.addEventListener('click', () => void launchHost(savedGame));
    }

    rootRender = () => void paint();
    void paint();
    return () => { rootRender = null; };
  }

  const offUnoMessage = api.on('peer:message', (msg) => {
    if (msg.kind !== 'uno' || !msg.uno || isContactBlocked(msg.from)) return;
    if (host && msg.from !== unoSelfPeerId) host.onWire(msg.from, msg.uno);
    handleWire(msg);
  });
  const offUnoDisconnect = api.on('peer:disconnected', (peerId) => {
    if (host) host.removePlayer(peerId);
  });
  const offUnoConnect = api.on('peer:connected', (peer) => {
    if (!host && clientState?.hostPeerId === peer?.id && clientState?.gameId) {
      sendWire(peer.id, {
        wire: 'join',
        gameId: clientState.gameId,
        name: unoSelfPeerName || 'Spieler',
      });
    }
    tryPump();
    rootRender?.();
  });

  let offUnoChild = null;
  if (window.bluetalk?.uno?.onFromChild) {
    offUnoChild = window.bluetalk.uno.onFromChild((payload) => {
      if (!payload) return;
      const pid = unoSelfPeerId;

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
        clientState = null;
        myHand = [];
        tryPump();
        rootRender?.();
      } else if (payload.type === 'update_settings' && payload.settings) {
        hostRef?.updateSettings(payload.settings);
      } else if (payload.type === 'invite' && payload.peerId) {
        hostRef?.invitePeer(payload.peerId);
      } else if (payload.type === 'save_game') {
        hostRef?.saveNow();
      }
    });
  }

  void refreshUnoSelfId();

  api.ui.registerTab({
    id: 'game',
    label: 'UNO',
    icon: 'Layers',
    order: 41,
    render,
  });

  api.onDeactivate(() => {
    offUnoChild?.();
    offUnoMessage?.();
    offUnoDisconnect?.();
    offUnoConnect?.();
    host?.destroy?.();
    host = null;
    hostRef = null;
    rootRender = null;
  });

  api.log.info('UNO-Plugin UI geladen');
})();
