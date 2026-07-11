/**
 * BlueTalk Poker — Host-autoritative Zustandsmaschine (Texas Hold'em).
 *
 * createHost() kapselt den gesamten Tischzustand. Netzwerk-/Host-Abhängigkeiten
 * werden über `deps` injiziert (api, sendWire, broadcastWire, isContactBlocked),
 * damit die Engine unabhängig vom UI-/Bridge-Code bleibt.
 */

import {
  POKER_BOT_PEER_ID,
  isPokerBotId,
  cardLabel,
  shuffle,
  makeDeck,
} from './cards.js';
import { cmpScore, best7, handLabel } from './handRank.js';
import {
  buildSidePots,
  clampInt,
  defaultSettings,
  sanitizeSettings,
  isPokerLobbyJoinable,
} from './betting.js';

/** --- Host --- */
export function createHost(deps, settings, onTick, me, restoredGame = null) {
  const { api, sendWire, broadcastWire, isContactBlocked } = deps;
  const selfId = me?.id;
  const tableId = restoredGame?.tableId || `tbl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const restoredPlayers = Array.isArray(restoredGame?.players) ? restoredGame.players : [];
  const minSeats = Math.max(2, ...restoredPlayers.map((p) => Number(p?.seat) + 1 || 0));
  const cfg = sanitizeSettings(settings, restoredGame?.settings || defaultSettings(), minSeats);
  const players = [];
  let phase = 'lobby';
  let dealerIdx = -1;
  let deck = [];
  let board = [];
  let pot = 0;
  let currentBet = 0;
  let minRaise = cfg.bigBlind;
  let street = 'idle';
  let toActIdx = -1;
  let acted = new Set();
  let lastRaise = cfg.bigBlind;
  let handNumber = clampInt(restoredGame?.handNumber, 0, 1000000000, 0);
  let winners = [];
  let showdownCards = [];
  let message = '';
  let turnTimer = null;
  let botTimer = null;
  let autoStartTimer = null;
  let nextHandTimer = null;
  let savedAt = Number(restoredGame?.savedAt) || 0;
  const invitedPeers = new Set(Array.isArray(restoredGame?.invitedPeers) ? restoredGame.invitedPeers : []);

  for (const row of restoredPlayers) {
    if (!row?.peerId || players.some((p) => p.peerId === row.peerId)) continue;
    const isSelf = row.peerId === selfId;
    const isBot = isPokerBotId(row.peerId);
    players.push({
      peerId: row.peerId,
      name: String(row.name || row.peerId).slice(0, 48),
      seat: clampInt(row.seat, 0, cfg.maxPlayers - 1, players.length),
      chips: clampInt(row.chips, 0, 1000000000, cfg.startingChips),
      folded: false,
      allIn: false,
      currentRoundBet: 0,
      totalBet: 0,
      hole: [],
      inHand: false,
      isBot,
      connected: isSelf || isBot || (api.peers() || []).some((p) => p.id === row.peerId),
      pendingChips: clampInt(row.pendingChips, 0, 1000000000, 0),
      stats: {
        handsPlayed: clampInt(row.stats?.handsPlayed, 0, 1000000000, 0),
        handsWon: clampInt(row.stats?.handsWon, 0, 1000000000, 0),
        chipsGranted: clampInt(row.stats?.chipsGranted, 0, 1000000000, 0),
      },
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
    if (botTimer) {
      api.timer.clearTimeout(botTimer);
      botTimer = null;
    }
  }

  function clearAutoStartTimer() {
    if (autoStartTimer) {
      api.timer.clearTimeout(autoStartTimer);
      autoStartTimer = null;
    }
    if (nextHandTimer) {
      api.timer.clearTimeout(nextHandTimer);
      nextHandTimer = null;
    }
  }

  function checkpoint(reason = 'auto') {
    savedAt = Date.now();
    const saved = {
      version: 2,
      tableId,
      savedAt,
      reason,
      handNumber,
      settings: { ...cfg },
      players: players.map((p) => ({
        peerId: p.peerId,
        name: p.name,
        seat: p.seat,
        chips: p.chips,
        pendingChips: p.pendingChips || 0,
        stats: { ...(p.stats || {}) },
      })),
    };
    api.storage.set('savedPokerGame', saved);
    api.storage.set('pokerSettings', { ...cfg });
    return saved;
  }

  function scheduleAutoStart() {
    clearAutoStartTimer();
    if (!cfg.autoStart || phase !== 'lobby') return;
    const ready = players.filter((p) => p.chips > 0 && !p.isBot);
    if (ready.length >= 2) {
      autoStartTimer = api.timer.setTimeout(() => {
        if (phase === 'lobby') startHand();
      }, 5000);
    }
  }

  function scheduleTurnTimer() {
    clearTurnTimer();
    const sec = Number(cfg.turnTimeSec) || 0;
    if (sec <= 0 || phase === 'lobby' || phase === 'between') return;
    const actor = players[toActIdx];
    if (!actor || actor.folded || actor.allIn) return;
    if (isPokerBotId(actor.peerId)) return;
    turnTimer = api.timer.setTimeout(() => {
      applyAction(actor.peerId, { type: 'fold' });
    }, sec * 1000);
  }

  function publicState() {
    const actor = toActIdx >= 0 ? players[toActIdx] : null;
    const maxBet = players.some((p) => p.inHand && !p.folded)
      ? Math.max(...players.filter((p) => p.inHand && !p.folded).map((p) => p.currentRoundBet))
      : 0;
    const actorMax = actor ? actor.currentRoundBet + actor.chips : 0;
    const minRaiseTo = actor ? Math.min(actorMax, maxBet + minRaise) : 0;
    return {
      tableId,
      hostPeerId: selfId,
      phase,
      street,
      board: board.map(cardLabel),
      boardRaw: board.slice(),
      pot,
      currentBet,
      minRaise,
      toAct: toActIdx >= 0 && players[toActIdx] ? players[toActIdx].peerId : null,
      dealerSeat: dealerIdx >= 0 ? players[dealerIdx]?.seat ?? null : null,
      handNumber,
      winners,
      showdownCards,
      savedAt,
      message,
      settings: cfg,
      actionBounds: actor ? {
        toCall: Math.max(0, maxBet - actor.currentRoundBet),
        minRaiseTo,
        maxRaiseTo: actorMax,
        canRaise: actorMax > maxBet,
      } : null,
      players: players.map((p) => ({
        peerId: p.peerId,
        name: p.name,
        seat: p.seat,
        chips: p.chips,
        folded: p.folded,
        allIn: p.allIn,
        currentRoundBet: p.currentRoundBet,
        bet: p.currentRoundBet,
        isBot: Boolean(p.isBot),
        connected: p.connected !== false,
        pendingChips: p.pendingChips || 0,
        stats: { ...(p.stats || {}) },
      })),
    };
  }

  function pushState() {
    broadcastWire({ wire: 'state', tableId, public: publicState() }, peerIds());
    onTick?.();
    queueMicrotask(() => {
      try {
        scheduleBotTurn();
      } catch (e) {
        api.log.error('poker bot:', e);
      }
    });
  }

  function sendHole(p, cards) {
    if (isPokerBotId(p.peerId)) return;
    sendWire(p.peerId, { wire: 'hole', tableId, cards: cards.map(cardLabel), cardsRaw: cards });
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
      existing.name = String(name || existing.name || peerId).slice(0, 48);
      message = `${existing.name} ist wieder verbunden.`;
      if (existing.hole?.length) sendHole(existing, existing.hole);
      pushState();
      return true;
    }
    if (players.length >= cfg.maxPlayers) return false;
    const seat = findSeat();
    if (seat < 0) return false;
    players.push({
      peerId,
      name: name || peerId.slice(0, 8),
      seat,
      chips: cfg.startingChips,
      folded: false,
      allIn: false,
      currentRoundBet: 0,
      totalBet: 0,
      hole: [],
      inHand: false,
      isBot: isPokerBotId(peerId),
      connected: true,
      pendingChips: 0,
      stats: { handsPlayed: 0, handsWon: 0, chipsGranted: 0 },
    });
    players.sort((a, b) => a.seat - b.seat);
    message = `${name || peerId} ist am Tisch.`;
    scheduleAutoStart();
    pushState();
    return true;
  }

  function removePlayer(peerId) {
    const i = players.findIndex((p) => p.peerId === peerId);
    if (i < 0) return;
    const player = players[i];
    if (player.inHand && phase !== 'lobby' && phase !== 'between') {
      player.connected = false;
      if (i === toActIdx) {
        applyAction(peerId, { type: 'fold' });
        return;
      }
      player.folded = true;
      acted.add(peerId);
      message = `${player.name} ist nicht mehr verbunden und foldet.`;
      if (awardUncontested()) return;
    } else {
      players.splice(i, 1);
      if (i < dealerIdx) dealerIdx -= 1;
      if (dealerIdx >= players.length) dealerIdx = players.length - 1;
    }
    if (players.length === 0) {
      phase = 'lobby';
      street = 'idle';
    }
    message = 'Spieler hat den Tisch verlassen.';
    pushState();
  }

  function kickPlayer(peerId) {
    if (peerId === selfId) return false;
    const i = players.findIndex((p) => p.peerId === peerId);
    if (i < 0) return false;
    const player = players[i];
    const name = player.name;
    sendWire(peerId, { wire: 'kicked', tableId, reason: 'Du wurdest vom Host vom Tisch entfernt.' });

    const activeHand = player.inHand && phase !== 'lobby' && phase !== 'between';
    if (activeHand && !player.folded) {
      const wasToAct = peerId === players[toActIdx]?.peerId;
      player.folded = true;
      acted.add(peerId);
      if (awardUncontested()) {
        const idxAfter = players.findIndex((p) => p.peerId === peerId);
        if (idxAfter >= 0) {
          players.splice(idxAfter, 1);
          if (idxAfter < dealerIdx) dealerIdx -= 1;
          if (dealerIdx >= players.length) dealerIdx = Math.max(0, players.length - 1);
        }
        if (players.length === 0) {
          phase = 'lobby';
          street = 'idle';
        }
        message = `${name} wurde vom Host entfernt.`;
        checkpoint('kick');
        pushState();
        return true;
      }
      if (wasToAct) {
        toActIdx = nextLiveSeat(toActIdx);
        let guard = 0;
        while (guard++ < players.length + 2) {
          const nx = players[toActIdx];
          if (nx && nx.inHand && !nx.folded && !nx.allIn) break;
          toActIdx = nextLiveSeat(toActIdx);
        }
        scheduleTurnTimer();
      }
    }

    const idx = players.findIndex((p) => p.peerId === peerId);
    if (idx < 0) return true;
    if (idx < dealerIdx) dealerIdx -= 1;
    if (idx < toActIdx) toActIdx -= 1;
    players.splice(idx, 1);
    if (dealerIdx >= players.length) dealerIdx = Math.max(0, players.length - 1);
    if (toActIdx >= players.length) toActIdx = Math.max(0, players.length - 1);
    if (players.length === 0) {
      phase = 'lobby';
      street = 'idle';
    }
    message = `${name} wurde vom Host entfernt.`;
    checkpoint('kick');
    pushState();
    return true;
  }

  function activeInHand() {
    return players.filter((p) => p.inHand && !p.folded);
  }

  function nextLiveSeat(from) {
    const n = players.length;
    if (!n) return -1;
    for (let k = 1; k <= n; k++) {
      const idx = (from + k) % n;
      const p = players[idx];
      if (p.inHand && !p.folded && !p.allIn) return idx;
    }
    return -1;
  }

  function bettingComplete() {
    const live = activeInHand().filter((p) => !p.allIn);
    if (live.length === 0) return true;
    const maxBet = Math.max(...players.filter((p) => p.inHand && !p.folded).map((p) => p.currentRoundBet));
    const allMatched = live.every((p) => p.currentRoundBet === maxBet);
    const allActed = live.every((p) => acted.has(p.peerId));
    return allMatched && allActed;
  }

  /** Alle Chips im Pot, alle noch aktiv all-in — Board ausspielen ohne weitere Bets */
  function runoutBoard() {
    clearTurnTimer();
    while (street !== 'river') {
      for (const p of players) {
        if (p.inHand) p.currentRoundBet = 0;
      }
      currentBet = 0;
      if (street === 'preflop') {
        street = 'flop';
        deck.pop();
        board.push(deck.pop(), deck.pop(), deck.pop());
      } else if (street === 'flop') {
        street = 'turn';
        deck.pop();
        board.push(deck.pop());
      } else if (street === 'turn') {
        street = 'river';
        deck.pop();
        board.push(deck.pop());
      } else {
        break;
      }
      phase = street;
    }
  }

  function advanceStreet() {
    clearTurnTimer();
    for (const p of players) {
      if (p.inHand) p.currentRoundBet = 0;
    }
    currentBet = 0;
    minRaise = cfg.bigBlind * cfg.minRaiseBB;
    lastRaise = minRaise;
    acted = new Set();

    if (street === 'preflop') {
      street = 'flop';
      deck.pop();
      board.push(deck.pop(), deck.pop(), deck.pop());
    } else if (street === 'flop') {
      street = 'turn';
      deck.pop();
      board.push(deck.pop());
    } else if (street === 'turn') {
      street = 'river';
      deck.pop();
      board.push(deck.pop());
    }
    const n = players.length;
    const inHandCount = players.filter((p) => p.inHand).length;
    if (inHandCount <= 2) {
      toActIdx = dealerIdx % n;
    } else {
      toActIdx = nextLiveSeat(dealerIdx);
    }
    let guard = 0;
    while (guard++ < n + 3) {
      const pl = players[toActIdx];
      if (pl && pl.inHand && !pl.folded && !pl.allIn) break;
      const nx = nextLiveSeat(toActIdx);
      if (nx < 0 || nx === toActIdx) break;
      toActIdx = nx;
    }
    phase = street;
    scheduleTurnTimer();
    pushState();
  }

  function showdown() {
    clearTurnTimer();
    phase = 'showdown';
    street = 'showdown';
    const contrib = {};
    for (const p of players) {
      if (p.inHand) contrib[p.peerId] = p.totalBet;
    }
    const pots = buildSidePots(contrib);
    const results = [];
    showdownCards = players
      .filter((p) => p.inHand && !p.folded)
      .map((p) => ({ peerId: p.peerId, cards: p.hole.map(cardLabel) }));
    for (const potInfo of pots) {
      const elig = potInfo.eligible.filter((id) => {
        const pl = players.find((x) => x.peerId === id);
        return pl && pl.inHand && !pl.folded;
      });
      if (!elig.length) {
        // Unkontestierte Ebene: alle Einzahler dieser Ebene haben gefoldet.
        // Uncall'ter Rest wird an die Einzahler zurückgegeben, statt zu verfallen.
        if (potInfo.eligible.length > 0) {
          const layerShare = Math.floor(potInfo.amount / potInfo.eligible.length);
          let rem = potInfo.amount - layerShare * potInfo.eligible.length;
          for (const id of potInfo.eligible) {
            const pl = players.find((x) => x.peerId === id);
            if (!pl) continue;
            pl.chips += layerShare + (rem > 0 ? 1 : 0);
            rem = Math.max(0, rem - 1);
          }
        }
        continue;
      }
      let best = null;
      let winnersLocal = [];
      for (const id of elig) {
        const pl = players.find((x) => x.peerId === id);
        const sc = best7(pl.hole.concat(board));
        const cmp = best ? cmpScore(sc, best) : 1;
        if (cmp > 0) {
          best = sc;
          winnersLocal = [id];
        } else if (cmp === 0) {
          winnersLocal.push(id);
        }
      }
      const share = Math.floor(potInfo.amount / winnersLocal.length);
      let remainder = potInfo.amount - share * winnersLocal.length;
      for (const id of winnersLocal) {
        const pl = players.find((x) => x.peerId === id);
        const amount = share + (remainder > 0 ? 1 : 0);
        remainder = Math.max(0, remainder - 1);
        pl.chips += amount;
        results.push({ peerId: id, amount, hand: handLabel(best) });
      }
    }
    const aggregated = new Map();
    for (const result of results) {
      const previous = aggregated.get(result.peerId);
      aggregated.set(result.peerId, previous
        ? { ...previous, amount: previous.amount + result.amount }
        : result);
    }
    winners = [...aggregated.values()];
    for (const result of winners) {
      const winner = players.find((p) => p.peerId === result.peerId);
      if (winner?.stats) winner.stats.handsWon += 1;
    }
    phase = 'between';
    street = 'idle';
    toActIdx = -1;
    message = 'Hand beendet.';
    checkpoint('hand_complete');
    pushState();

    // Auto-start nächste Hand nach 3 Sekunden
    if (cfg.autoStart) {
      nextHandTimer = api.timer.setTimeout(() => {
        if (phase === 'between') startHand();
      }, 3000);
    }
  }

  function awardUncontested() {
    clearTurnTimer();
    const alive = activeInHand();
    if (alive.length !== 1) return false;
    const w = alive[0];
    w.chips += pot;
    if (w.stats) w.stats.handsWon += 1;
    winners = [{ peerId: w.peerId, amount: pot, hand: 'Gewinn (alle anderen gefoldet)' }];
    showdownCards = [];
    phase = 'between';
    street = 'idle';
    toActIdx = -1;
    message = `${w.name} gewinnt den Pot.`;
    checkpoint('hand_complete');
    pushState();

    // Auto-start nächste Hand nach 3 Sekunden
    if (cfg.autoStart) {
      nextHandTimer = api.timer.setTimeout(() => {
        if (phase === 'between') startHand();
      }, 3000);
    }
    return true;
  }

  function startHand() {
    if (phase !== 'lobby' && phase !== 'between') {
      message = 'Die aktuelle Hand läuft noch.';
      pushState();
      return false;
    }
    try {
      if (window.bluetalk?.poker?.openGameWindow) {
        void window.bluetalk.poker.openGameWindow();
      }
    } catch {
      /* ignore */
    }
    clearTurnTimer();
    clearAutoStartTimer();
    winners = [];
    showdownCards = [];
    for (const player of players) {
      if (player.pendingChips > 0) {
        player.chips = Math.min(1000000000, player.chips + player.pendingChips);
        player.pendingChips = 0;
      }
    }
    const ready = players.filter((p) => p.chips > 0 && (p.connected !== false || p.isBot));
    if (ready.length < 2) {
      message = 'Mindestens zwei Spieler mit Chips benötigt.';
      pushState();
      return false;
    }
    handNumber += 1;
    deck = shuffle(makeDeck());
    board = [];
    pot = 0;
    currentBet = 0;
    minRaise = cfg.bigBlind * cfg.minRaiseBB;
    lastRaise = minRaise;
    acted = new Set();

    for (const p of players) {
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.currentRoundBet = 0;
      p.totalBet = 0;
      p.hole = [];
      p.inHand = p.chips > 0 && (p.connected !== false || p.isBot);
      if (p.inHand && p.stats) p.stats.handsPlayed += 1;
    }

    const nextInHandIndex = (from) => {
      for (let step = 1; step <= players.length; step += 1) {
        const index = (from + step + players.length) % players.length;
        if (players[index]?.inHand) return index;
      }
      return -1;
    };
    dealerIdx = nextInHandIndex(dealerIdx);

    const ante = Math.max(0, Number(cfg.ante) || 0);
    if (ante > 0) {
      for (const p of players) {
        if (!p.inHand) continue;
        const a = Math.min(ante, p.chips);
        p.chips -= a;
        p.totalBet += a;
        pot += a;
        if (p.chips === 0) p.allIn = true;
      }
    }

    const n = ready.length;
    const d = dealerIdx;
    let sbIdx;
    let bbIdx;
    if (n === 2) {
      sbIdx = d;
      bbIdx = nextInHandIndex(d);
    } else {
      sbIdx = nextInHandIndex(d);
      bbIdx = nextInHandIndex(sbIdx);
    }
    const sbP = players[sbIdx];
    const bbP = players[bbIdx];

    const sb = Math.min(cfg.smallBlind, sbP.chips);
    sbP.chips -= sb;
    sbP.currentRoundBet += sb;
    sbP.totalBet += sb;
    pot += sb;
    if (sbP.chips === 0) sbP.allIn = true;

    const bb = Math.min(cfg.bigBlind, bbP.chips);
    bbP.chips -= bb;
    bbP.currentRoundBet += bb;
    bbP.totalBet += bb;
    pot += bb;
    if (bbP.chips === 0) bbP.allIn = true;

    currentBet = Math.max(sbP.currentRoundBet, bbP.currentRoundBet);

    for (const p of players) {
      if (!p.inHand) continue;
      p.hole = [deck.pop(), deck.pop()];
      sendHole(p, p.hole);
    }

    phase = 'preflop';
    street = 'preflop';
    let firstIdx = n === 2 ? d : nextLiveSeat(bbIdx);
    toActIdx = firstIdx;
    {
      let g = 0;
      while (g++ < n + 3) {
        const pl = players[toActIdx];
        if (pl && pl.inHand && !pl.folded && !pl.allIn) break;
        const nx = nextLiveSeat(toActIdx);
        if (nx < 0 || nx === toActIdx) break;
        toActIdx = nx;
      }
    }
    if (toActIdx < 0 || !players[toActIdx] || players[toActIdx].allIn) {
      showdown();
      return;
    }
    scheduleTurnTimer();
    message = `Hand #${handNumber}`;
    pushState();
    return true;
  }

  function applyAction(peerId, act) {
    if (peerId !== players[toActIdx]?.peerId) return;
    const p = players[toActIdx];
    if (!p || !p.inHand || p.folded || p.allIn) return;

    const maxBet = Math.max(...players.filter((x) => x.inHand && !x.folded).map((x) => x.currentRoundBet));
    const toCall = maxBet - p.currentRoundBet;

    if (act.type === 'fold') {
      p.folded = true;
      acted.add(peerId);
    } else if (act.type === 'check') {
      if (toCall !== 0) return;
      acted.add(peerId);
    } else if (act.type === 'call') {
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay;
      p.currentRoundBet += pay;
      p.totalBet += pay;
      pot += pay;
      if (p.chips === 0) p.allIn = true;
      acted.add(peerId);
    } else if (act.type === 'raise') {
      const requestedTarget = Number(act.raiseTo) || (maxBet + Number(act.amount || 0));
      const playerMax = p.currentRoundBet + p.chips;
      if (playerMax <= maxBet) return;
      const minimumTarget = maxBet + minRaise;
      const totalTarget = Math.min(playerMax, Math.max(minimumTarget, Math.round(requestedTarget)));
      const need = totalTarget - p.currentRoundBet;
      const pay = Math.min(need, p.chips);
      p.chips -= pay;
      p.currentRoundBet += pay;
      p.totalBet += pay;
      pot += pay;
      if (p.chips === 0) p.allIn = true;
      const raiseSize = p.currentRoundBet - maxBet;
      currentBet = Math.max(currentBet, p.currentRoundBet);
      if (raiseSize >= minRaise) {
        lastRaise = raiseSize;
        minRaise = Math.max(cfg.bigBlind * cfg.minRaiseBB, lastRaise);
        acted = new Set([peerId]);
      } else {
        acted.add(peerId);
      }
    } else if (act.type === 'all_in') {
      const pay = p.chips;
      p.chips = 0;
      p.currentRoundBet += pay;
      p.totalBet += pay;
      pot += pay;
      p.allIn = true;
      const raiseSize = p.currentRoundBet - maxBet;
      currentBet = Math.max(currentBet, p.currentRoundBet);
      if (raiseSize >= minRaise) {
        lastRaise = raiseSize;
        minRaise = Math.max(cfg.bigBlind * cfg.minRaiseBB, lastRaise);
        acted = new Set([peerId]);
      } else {
        acted.add(peerId);
      }
    }

    if (awardUncontested()) return;

    if (bettingComplete()) {
      const anyLive = activeInHand().some((x) => !x.allIn);
      if (!anyLive && street !== 'river') {
        runoutBoard();
      }
      if (!anyLive || street === 'river') {
        showdown();
      } else {
        advanceStreet();
      }
    } else {
      toActIdx = nextLiveSeat(toActIdx);
      let guard = 0;
      while (guard++ < players.length + 2) {
        const nx = players[toActIdx];
        if (nx && nx.inHand && !nx.folded && !nx.allIn) break;
        toActIdx = nextLiveSeat(toActIdx);
      }
      scheduleTurnTimer();
    }
    pushState();
  }

  function scheduleBotTurn() {
    if (phase === 'lobby' || phase === 'between' || street === 'idle') return;
    const actor = players[toActIdx];
    if (!actor || !isPokerBotId(actor.peerId) || actor.folded || actor.allIn) return;
    if (botTimer) return;
    botTimer = api.timer.setTimeout(() => {
      botTimer = null;
      const a2 = players[toActIdx];
      if (!a2 || a2.peerId !== POKER_BOT_PEER_ID || a2.folded || a2.allIn) return;
      const maxBet = Math.max(...players.filter((x) => x.inHand && !x.folded).map((x) => x.currentRoundBet));
      const toCall = maxBet - a2.currentRoundBet;
      let act;
      if (toCall <= 0) {
        act = Math.random() < 0.07 ? { type: 'raise', amount: cfg.bigBlind } : { type: 'check' };
      } else if (toCall >= a2.chips) {
        act = Math.random() < 0.22 ? { type: 'fold' } : { type: 'call' };
      } else if (toCall > cfg.bigBlind * 6 && Math.random() < 0.58) {
        act = { type: 'fold' };
      } else if (toCall > cfg.bigBlind * 3 && Math.random() < 0.28) {
        act = { type: 'fold' };
      } else {
        act = { type: 'call' };
      }
      applyAction(POKER_BOT_PEER_ID, act);
    }, 140);
  }

  function onWire(from, body) {
    if (!body || body.tableId !== tableId) return;
    if (body.wire === 'join' && from !== selfId) {
      if (isPokerBotId(from)) return;
      if (!isPokerLobbyJoinable(phase)) {
        sendWire(from, { wire: 'join_reject', tableId, reason: 'Eine Hand läuft bereits — Beitritt später erneut versuchen.' });
        return;
      }
      if (cfg.lobbyAccess !== 'public' && !invitedPeers.has(from)) {
        sendWire(from, {
          wire: 'join_reject',
          tableId,
          reason: 'Nur auf Einladung — bitte zuerst eine Einladung im Chat erhalten.',
        });
        return;
      }
      if (addPlayer(from, body.name)) {
        sendWire(from, { wire: 'join_ok', tableId, seat: players.find((p) => p.peerId === from)?.seat });
      } else {
        sendWire(from, { wire: 'join_reject', tableId, reason: 'Tisch voll oder bereits gesetzt.' });
      }
    }
    if (body.wire === 'leave' && from !== selfId) {
      removePlayer(from);
    }
    if (body.wire === 'action' && from !== selfId) {
      applyAction(from, body.action || {});
    }
  }

  function bootstrapHost() {
    addPlayer(selfId, me?.name || 'Host');
    checkpoint(restoredGame ? 'resumed' : 'table_created');
  }

  function addDebugBot() {
    if (players.some((p) => p.peerId === POKER_BOT_PEER_ID)) return false;
    return addPlayer(POKER_BOT_PEER_ID, 'Debug-Bot');
  }

  function removeDebugBot() {
    if (!players.some((p) => p.peerId === POKER_BOT_PEER_ID)) return false;
    removePlayer(POKER_BOT_PEER_ID);
    return true;
  }

  return {
    tableId,
    cfg,
    bootstrapHost,
    addDebugBot,
    removeDebugBot,
    getMyHole() {
      const p = players.find((x) => x.peerId === selfId);
      return p?.hole || [];
    },
    get settings() {
      return cfg;
    },
    updateSettings(patch) {
      const occupiedSeats = Math.max(2, ...players.map((p) => p.seat + 1));
      Object.assign(cfg, sanitizeSettings(patch, cfg, occupiedSeats));
      message = phase === 'lobby' || phase === 'between'
        ? 'Tischeinstellungen aktualisiert.'
        : 'Einstellungen gespeichert; Blind- und Ante-Änderungen gelten ab der nächsten Hand.';
      if (phase === 'lobby') {
        scheduleAutoStart();
      } else if (phase === 'between') {
        clearAutoStartTimer();
        if (cfg.autoStart) {
          nextHandTimer = api.timer.setTimeout(() => {
            if (phase === 'between') startHand();
          }, 3000);
        }
      } else {
        scheduleTurnTimer();
      }
      if (phase === 'lobby' || phase === 'between') checkpoint('settings');
      pushState();
    },
    addChips(peerId, amount) {
      const player = players.find((p) => p.peerId === peerId);
      const value = clampInt(amount, 1, 1000000000, 0);
      if (!player || value <= 0) return false;
      const activeHand = phase !== 'lobby' && phase !== 'between';
      if (activeHand) player.pendingChips = Math.min(1000000000, (player.pendingChips || 0) + value);
      else player.chips = Math.min(1000000000, player.chips + value);
      if (player.stats) player.stats.chipsGranted += value;
      message = activeHand
        ? `${player.name} erhält ${value.toLocaleString()} Chips ab der nächsten Hand.`
        : `${player.name} erhält ${value.toLocaleString()} Chips.`;
      if (phase === 'lobby' || phase === 'between') checkpoint('admin_chips');
      pushState();
      return true;
    },
    removeChips(peerId, amount) {
      const player = players.find((p) => p.peerId === peerId);
      const value = clampInt(amount, 1, 1000000000, 0);
      if (!player || value <= 0) return false;
      const activeHand = phase !== 'lobby' && phase !== 'between';
      if (activeHand) {
        message = 'Chips koennen nur zwischen Haenden entfernt werden.';
        pushState();
        return false;
      }
      const removed = Math.min(player.chips, value);
      player.chips = Math.max(0, player.chips - value);
      message = `${player.name} verliert ${removed.toLocaleString()} Chips.`;
      checkpoint('admin_chips');
      pushState();
      return true;
    },
    invitePeer(peerId) {
      if (!peerId || players.some((p) => p.peerId === peerId)) return false;
      const connected = (api.peers() || []).some((p) => p.id === peerId);
      if (!connected || isContactBlocked(peerId)) return false;
      invitedPeers.add(peerId);
      void api.chat.send(peerId, this.invitePayload());
      message = 'Einladung wurde im Chat gesendet.';
      pushState();
      return true;
    },
    saveNow() {
      if (phase !== 'lobby' && phase !== 'between') {
        message = 'Der sichere Spielstand wird automatisch nach dieser Hand gespeichert.';
        pushState();
        return false;
      }
      checkpoint('manual');
      message = 'Spielstand gespeichert.';
      pushState();
      return true;
    },
    invitePayload() {
      const sum = `NL Hold'em · Blinds ${cfg.smallBlind}/${cfg.bigBlind} · max. ${cfg.maxPlayers} · ${cfg.startingChips.toLocaleString('de-DE')} Chips`;
      return {
        kind: 'poker-invite',
        tableId,
        tableName: cfg.tableName,
        hostPeerId: selfId,
        pokerSettings: { ...cfg },
        pokerSettingsSummary: sum,
        lobbyAccess: cfg.lobbyAccess,
        content: `🃏 ${cfg.tableName} — ${sum}`,
      };
    },
    startHand,
    onWire,
    removePlayer,
    kickPlayer,
    publicState,
    pushState,
    applyAction: (pid, a) => applyAction(pid, a),
    destroy() {
      clearTurnTimer();
      clearAutoStartTimer();
      if (botTimer) api.timer.clearTimeout(botTimer);
    },
  };
}
