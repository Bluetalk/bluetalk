/**
 * BlueTalk Poker — Texas Hold'em (Host-autoritativ, P2P).
 * ui.js: Karten-Engine, Host-Zustand, Vanilla-UI.
 */
(function pokerPluginUi() {
  const api = BlueTalkPlugin;

  const RN = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SN = ['♣', '♦', '♥', '♠'];

  /** Lokaler Debug-Bot (nur Host, keine Netzwerk-Verbindung) */
  const POKER_BOT_PEER_ID = '__bt_poker_bot_debug__';
  function isPokerBotId(id) {
    return id === POKER_BOT_PEER_ID;
  }

  function cardLabel(c) {
    const r = c % 13;
    const s = (c / 13) | 0;
    return RN[r] + SN[s];
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

  function makeDeck() {
    const d = [];
    for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push(s * 13 + r);
    return d;
  }

  /** 5-Karten-Score: höher = besser; vergleichbar als Tuple */
  function scoreFive(cards5) {
    const r = cards5.map((c) => c % 13).sort((a, b) => b - a);
    const suits = cards5.map((c) => (c / 13) | 0);
    const flush = suits.every((x) => x === suits[0]);
    const cnt = {};
    for (const x of r) cnt[x] = (cnt[x] || 0) + 1;
    const byFreq = Object.keys(cnt)
      .map((k) => ({ k: Number(k), n: cnt[k] }))
      .sort((a, b) => b.n - a.n || b.k - a.k);
    const uniq = [...new Set(r)].sort((a, b) => b - a);
    let straightHigh = -1;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
      if (uniq[0] === 12 && uniq[1] === 3 && uniq[2] === 2 && uniq[3] === 1 && uniq[4] === 0) straightHigh = 3;
    }
    const sf = flush && straightHigh >= 0;
    if (sf) {
      return [8, straightHigh];
    }
    if (byFreq[0].n === 4) {
      const quad = byFreq[0].k;
      const k = r.find((x) => x !== quad);
      return [7, quad, k];
    }
    if (byFreq[0].n === 3 && byFreq[1].n === 2) return [6, byFreq[0].k, byFreq[1].k];
    if (flush) return [5].concat(r);
    if (straightHigh >= 0) {
      return [4, straightHigh];
    }
    if (byFreq[0].n === 3) {
      const t = byFreq[0].k;
      const kick = r.filter((x) => x !== t).sort((a, b) => b - a);
      return [3, t].concat(kick.slice(0, 2));
    }
    if (byFreq[0].n === 2 && byFreq[1].n === 2) {
      const p1 = Math.max(byFreq[0].k, byFreq[1].k);
      const p2 = Math.min(byFreq[0].k, byFreq[1].k);
      const k = r.find((x) => x !== p1 && x !== p2);
      return [2, p1, p2, k];
    }
    if (byFreq[0].n === 2) {
      const p = byFreq[0].k;
      const kick = r.filter((x) => x !== p).sort((a, b) => b - a);
      return [1, p].concat(kick.slice(0, 3));
    }
    return [0].concat(r);
  }

  function cmpScore(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x !== y) return x - y;
    }
    return 0;
  }

  function best7(cards7) {
    const idx = [0, 1, 2, 3, 4, 5, 6];
    let best = null;
    for (let a = 0; a < 7; a++)
      for (let b = a + 1; b < 7; b++)
        for (let c = b + 1; c < 7; c++)
          for (let d = c + 1; d < 7; d++)
            for (let e = d + 1; e < 7; e++) {
              const five = [cards7[a], cards7[b], cards7[c], cards7[d], cards7[e]];
              const s = scoreFive(five);
              if (!best || cmpScore(s, best) > 0) best = s;
            }
    return best;
  }

  function handLabel(score) {
    const cat = score[0];
    const map = {
      8: 'Straight Flush',
      7: 'Vierling',
      6: 'Full House',
      5: 'Flush',
      4: 'Straight',
      3: 'Drilling',
      2: 'Zwei Paare',
      1: 'Paar',
      0: 'High Card',
    };
    return map[cat] || 'Hand';
  }

  function buildSidePots(contrib) {
    const ids = Object.keys(contrib).filter((id) => contrib[id] > 0);
    if (!ids.length) return [];
    const levels = [...new Set(ids.map((id) => contrib[id]))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const cap of levels) {
      const layer = cap - prev;
      const elig = ids.filter((id) => contrib[id] >= cap);
      pots.push({ amount: layer * elig.length, eligible: elig.slice() });
      prev = cap;
    }
    return pots;
  }

  function defaultSettings() {
    return {
      tableName: 'Poker-Tisch',
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      maxPlayers: 6,
      startingChips: 2000,
      turnTimeSec: 0,
      minRaiseBB: 1,
      autoStart: false,
    };
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Math.round(Number(value));
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
  }

  function sanitizeSettings(input = {}, fallback = defaultSettings(), minSeats = 2) {
    const next = { ...defaultSettings(), ...fallback, ...input };
    next.tableName = String(next.tableName || 'Poker-Tisch').trim().slice(0, 48) || 'Poker-Tisch';
    next.smallBlind = clampInt(next.smallBlind, 1, 1000000, fallback.smallBlind || 10);
    next.bigBlind = clampInt(next.bigBlind, next.smallBlind, 2000000, Math.max(next.smallBlind, fallback.bigBlind || 20));
    next.ante = clampInt(next.ante, 0, 1000000, fallback.ante || 0);
    next.startingChips = clampInt(next.startingChips, next.bigBlind * 2, 1000000000, fallback.startingChips || 2000);
    next.maxPlayers = clampInt(next.maxPlayers, Math.max(2, minSeats), 9, Math.max(6, minSeats));
    next.turnTimeSec = clampInt(next.turnTimeSec, 0, 300, fallback.turnTimeSec || 0);
    next.minRaiseBB = clampInt(next.minRaiseBB, 1, 10, fallback.minRaiseBB || 1);
    next.autoStart = next.autoStart === true;
    return next;
  }

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

  /** --- Host --- */
  function createHost(settings, onTick, me, restoredGame = null) {
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
        if (!elig.length) continue;
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

  if (window.__BLUETALK_POKER_TEST_HOOKS__) {
    Object.assign(window.__BLUETALK_POKER_TEST_HOOKS__, {
      scoreFive,
      cmpScore,
      best7,
      buildSidePots,
      sanitizeSettings,
      createHost,
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
  let rootRender = null;

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
      rootRender?.();
      return;
    }

    if (w.wire === 'state' && w.public) {
      if (w.public.hostPeerId === selfId && host) {
        rootRender?.();
        return;
      }
      if (host) return;
      if (!clientState || clientState.tableId !== w.tableId || clientState.hostPeerId !== msg.from) return;
      if (msg.from !== w.public.hostPeerId) return;
      clientState = w.public;
      tryPump();
      void openGameWindowIfNeeded();
      rootRender?.();
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
        rootRender?.();
      }
    }
    if (w.wire === 'leave' && clientState?.tableId === w.tableId && msg.from === clientState.hostPeerId) {
      clientState = null;
      myHole = [];
      tryPump();
      rootRender?.();
    }
    if (w.wire === 'kicked' && (!w.tableId || w.tableId === clientState?.tableId)) {
      api.notify.toast?.({ title: 'Poker', message: w.reason || 'Du wurdest vom Tisch entfernt.' });
      clientState = null;
      myHole = [];
      tryPump();
      rootRender?.();
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

  function render(container) {
    let contacts = api.contacts() || [];
    let peers = api.peers() || [];

    function refreshLists() {
      contacts = api.contacts() || [];
      peers = api.peers() || [];
    }

    container.innerHTML = `
      <div class="poker-plugin-root">
        <div class="poker-plugin-hero">
          <h2>Texas Hold'em</h2>
          <p class="poker-plugin-sub">Host erstellt den Tisch, lädt per Chat ein, alle müssen als Peers verbunden sein.</p>
        </div>
        <div class="poker-plugin-panels"></div>
      </div>
      <style>
        .poker-plugin-root { max-width: 880px; margin: 0 auto; padding: 12px 16px 32px; }
        .poker-plugin-hero h2 { margin: 0 0 6px; font-size: 1.35rem; }
        .poker-plugin-sub { margin: 0; color: var(--fg-2); font-size: 13px; line-height: 1.45; }
        .poker-plugin-panels { margin-top: 16px; display: flex; flex-direction: column; gap: 14px; }
        .poker-card {
          background: var(--bg-1);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 14px 16px;
        }
        .poker-card h3 { margin: 0 0 10px; font-size: 15px; }
        .poker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
        .poker-field label { display: block; font-size: 11px; color: var(--fg-3); margin-bottom: 4px; }
        .poker-field input, .poker-field select {
          width: 100%; padding: 6px 8px; border-radius: 6px;
          border: 1px solid var(--border); background: var(--bg-input); color: var(--fg-0); font-size: 13px;
        }
        .poker-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .poker-board {
          display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;
          padding: 12px; background: var(--green-soft); border-radius: 8px; margin: 10px 0;
          min-height: 52px;
        }
        .poker-card-chip {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 36px; padding: 6px 8px; border-radius: 6px;
          background: var(--bg-2); border: 1px solid var(--border-strong);
          font-family: var(--mono, monospace); font-size: 14px;
        }
        .poker-pot { font-weight: 600; margin: 8px 0; text-align: center; }
        .poker-players { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .poker-seat {
          display: flex; justify-content: space-between; align-items: center;
          padding: 8px 10px; border-radius: 8px; background: var(--bg-2); font-size: 13px;
        }
        .poker-seat span.muted { color: var(--fg-3); font-size: 12px; }
        .poker-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .poker-msg { font-size: 12px; color: var(--fg-2); margin-top: 8px; }
        .poker-btn { padding: 6px 12px; border-radius: 6px; border: 0; cursor: pointer; font-size: 13px; }
        .poker-btn-primary { background: var(--accent); color: var(--accent-fg); }
        .poker-btn-ghost { background: var(--bg-2); color: var(--fg-0); border: 1px solid var(--border); }
        .poker-launch-card { min-height: 190px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 14px; }
        .poker-launch-mark { font-size: 42px; line-height: 1; color: var(--accent); }
      </style>
    `;

    const panels = container.querySelector('.poker-plugin-panels');

    async function paint() {
      {
        await refreshPokerSelfId();
        const pending = tryConsumePendingJoin();
        if (pending?.hostPeerId && pending?.tableId && !host && !clientState) {
          clientState = {
            tableId: pending.tableId,
            hostPeerId: pending.hostPeerId,
            phase: 'lobby',
            players: [],
            settings: sanitizeSettings(pending.pokerSettings || {}),
            message: 'Verbindung zum Tisch wird hergestellt…',
          };
          sendWire(pending.hostPeerId, {
            wire: 'join',
            tableId: pending.tableId,
            name: pokerSelfPeerName || 'Spieler',
          });
          await openGameWindowIfNeeded();
          tryPump();
        }

        const activeState = host ? host.publicState() : clientState;
        const savedGame = api.storage.get('savedPokerGame', null);
        panels.innerHTML = activeState
          ? `
            <div class="poker-card poker-launch-card">
              <div class="poker-launch-mark">♠</div>
              <div>
                <h3>${activeState.settings?.tableName || 'Poker-Tisch'}</h3>
                <p class="poker-plugin-sub">Das Spiel, Einladungen, Chips und Einstellungen werden vollständig im Poker-Fenster verwaltet.</p>
              </div>
              <button type="button" class="poker-btn poker-btn-primary" id="poker-launch-open">Poker-Fenster öffnen</button>
            </div>`
          : `
            <div class="poker-card poker-launch-card">
              <div class="poker-launch-mark">♠</div>
              <div>
                <h3>Pokerrunde starten</h3>
                <p class="poker-plugin-sub">Starte hier nur das Spiel. Alles Weitere erledigst du anschließend direkt am Tisch.</p>
              </div>
              <div class="poker-row">
                <button type="button" class="poker-btn poker-btn-primary" id="poker-launch-new">Neues Spiel</button>
                ${savedGame?.players?.length ? '<button type="button" class="poker-btn poker-btn-ghost" id="poker-launch-resume">Gespeichertes Spiel fortsetzen</button>' : ''}
              </div>
            </div>`;

        const launchHost = async (saved = null) => {
          const peerInfo = await window.bluetalk?.peer?.getInfo?.();
          if (!peerInfo?.id) {
            api.notify.toast?.({ title: 'Poker', message: 'Peer-ID noch nicht verfügbar. Bitte erneut versuchen.' });
            return;
          }
          pokerSelfPeerId = peerInfo.id;
          pokerSelfPeerName = peerInfo.name || '';
          const settings = saved?.settings || api.storage.get('pokerSettings', defaultSettings());
          host = createHost(settings, () => {
            tryPump();
            rootRender?.();
          }, { id: peerInfo.id, name: peerInfo.name || 'Host' }, saved);
          hostRef = host;
          host.bootstrapHost();
          clientState = host.publicState();
          myHole = [];
          await openGameWindowIfNeeded();
          tryPump();
          void paint();
        };

        panels.querySelector('#poker-launch-open')?.addEventListener('click', () => {
          void openGameWindowIfNeeded().then(() => tryPump());
        });
        panels.querySelector('#poker-launch-new')?.addEventListener('click', () => void launchHost(null));
        panels.querySelector('#poker-launch-resume')?.addEventListener('click', () => void launchHost(savedGame));
        return;
      }
      refreshLists();
      await refreshPokerSelfId();
      let debugPoker = false;
      try {
        const appSettings = await window.bluetalk?.store?.get?.('settings', {});
        debugPoker = Boolean(appSettings?.debugMode);
      } catch {
        debugPoker = false;
      }

      const selfId = pokerSelfPeerId;

      const st = host ? host.publicState() : clientState;
      const pending = tryConsumePendingJoin();
      if (pending && pending.hostPeerId && pending.tableId && !host && !clientState) {
        sendWire(pending.hostPeerId, {
          wire: 'join',
          tableId: pending.tableId,
          name: pokerSelfPeerName || 'Spieler',
        });
        clientState = {
          tableId: pending.tableId,
          hostPeerId: pending.hostPeerId,
          phase: 'lobby',
          players: [],
          settings: pending.pokerSettings || {},
        };
      }

      if (!st && !clientState) {
        panels.innerHTML = `
          <div class="poker-card">
            <h3>Tisch erstellen (du bist Host)</h3>
            <div class="poker-grid" id="poker-form"></div>
            <div class="poker-row" style="margin-top:12px">
              <button type="button" class="poker-btn poker-btn-primary" id="poker-create">Tisch hosten</button>
            </div>
          </div>
          <div class="poker-card">
            <h3>Per Chat eingeladen?</h3>
            <p class="poker-plugin-sub">Öffne die Einladung im Chat und tippe auf <strong>Tisch beitreten</strong>, oder verbinde dich mit dem Host und tritt unten bei.</p>
          </div>
        `;
        const form = panels.querySelector('#poker-form');
        const s = { ...defaultSettings(), ...JSON.parse(JSON.stringify(api.storage.get('pokerSettings', defaultSettings()))) };
        form.innerHTML = `
          <div class="poker-field"><label>Name</label><input data-k="tableName" value="${s.tableName.replace(/"/g, '&quot;')}" /></div>
          <div class="poker-field"><label>Small Blind</label><input data-k="smallBlind" type="number" value="${s.smallBlind}" /></div>
          <div class="poker-field"><label>Big Blind</label><input data-k="bigBlind" type="number" value="${s.bigBlind}" /></div>
          <div class="poker-field"><label>Ante</label><input data-k="ante" type="number" value="${s.ante}" /></div>
          <div class="poker-field"><label>Start-Chips</label><input data-k="startingChips" type="number" value="${s.startingChips}" /></div>
          <div class="poker-field"><label>Max. Spieler</label><input data-k="maxPlayers" type="number" min="2" max="9" value="${s.maxPlayers}" /></div>
          <div class="poker-field"><label>Zugzeit (Sek., 0=aus)</label><input data-k="turnTimeSec" type="number" value="${s.turnTimeSec}" /></div>
          <div class="poker-field"><label>Auto-Start</label><input data-k="autoStart" type="checkbox" ${s.autoStart ? 'checked' : ''} /></div>
        `;
        panels.querySelector('#poker-create').onclick = () => {
          void (async () => {
            const inputs = form.querySelectorAll('[data-k]');
            const next = { ...s };
            inputs.forEach((el) => {
              const k = el.getAttribute('data-k');
              const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
              next[k] = v;
            });
            api.storage.set('pokerSettings', next);
            const peerInfo = await window.bluetalk?.peer?.getInfo?.();
            if (!peerInfo?.id) {
              api.notify.toast?.({ title: 'Poker', message: 'Peer-ID nicht verfügbar. Bitte kurz warten und erneut versuchen.' });
              return;
            }
            pokerSelfPeerId = peerInfo.id;
            pokerSelfPeerName = peerInfo.name || '';
            host = createHost(next, () => {
              void (async () => {
                await paint();
                tryPump();
              })();
            }, { id: peerInfo.id, name: peerInfo.name || 'Host' });
            hostRef = host;
            host.bootstrapHost();
            clientState = host.publicState();
            myHole = [];
            await paint();
            // Öffne das Spiel-Fenster automatisch
            try {
              await window.bluetalk?.poker?.openGameWindow?.();
            } catch {}
          })();
        };
        return;
      }

      const view = st || clientState;
      const isHost = Boolean(host);
      const tableId = view.tableId;
      const ps = view.players || [];
      const inGame = view && view.phase && view.phase !== 'lobby';
      const hasBot = ps.some((p) => p.peerId === POKER_BOT_PEER_ID);

      let debugHtml = '';
      if (debugPoker && isHost) {
        debugHtml = `
          <div class="poker-card">
            <h3>Debug</h3>
            <p class="poker-plugin-sub">Aktiv, weil <strong>Einstellungen → Debug-Modus</strong> eingeschaltet ist. Lokaler Bot ohne Netzwerk.</p>
            <div class="poker-row">
              ${
                hasBot
                  ? '<button type="button" class="poker-btn poker-btn-ghost" id="poker-rm-bot">Bot entfernen</button>'
                  : '<button type="button" class="poker-btn poker-btn-primary" id="poker-add-bot">Bot hinzufügen</button>'
              }
            </div>
          </div>
        `;
      }

      let inviteHtml = '';
      if (isHost) {
        const opts = contacts
          .filter((c) => c?.id && !c.blocked && peers.some((p) => p.id === c.id))
          .map((c) => `<option value="${c.id}">${(c.nickname || c.name || c.id).replace(/</g, '')}</option>`)
          .join('');
        inviteHtml = `
          <div class="poker-card">
            <h3>Spieler einladen</h3>
            <p class="poker-plugin-sub">Sendet eine Einladung in den Chat — der Kontakt muss online sein.</p>
            <div class="poker-row">
              <select id="poker-invite-peer" style="flex:1;min-width:200px;padding:6px;border-radius:6px;border:1px solid var(--border)">${opts || '<option value="">Kein verbundener Kontakt</option>'}</select>
              <button type="button" class="poker-btn poker-btn-primary" id="poker-send-invite">Einladung senden</button>
            </div>
          </div>
        `;
      }

      const actionRow =
        isHost && view.phase !== 'lobby'
          ? `<div class="poker-row" style="margin-top:10px">
               <button type="button" class="poker-btn poker-btn-primary" id="poker-next-hand">Nächste Hand</button>
             </div>`
          : '';

      panels.innerHTML = `
        <div class="poker-card">
          <h3>${view.settings?.tableName || 'Tisch'} <span class="muted" style="font-size:12px;color:var(--fg-3)">(${view.phase})</span></h3>
          ${
            inGame
              ? `<p class="poker-plugin-sub" style="margin:0 0 10px;line-height:1.5">
                  <strong>Poker-Fenster</strong> — Das Spiel läuft im separaten Fenster.
                  <button type="button" class="poker-btn poker-btn-primary" id="poker-open-window" style="margin-left:8px">Fenster öffnen</button>
                </p>
                <div class="poker-msg">Pot: ${view.pot ?? 0} · Hand #${view.handNumber ?? 0}</div>`
              : `<p class="poker-plugin-sub" style="margin:0">Lobby — Spieler am Tisch:</p>`
          }
          <div class="poker-players" style="margin-top:10px">
            ${ps
              .map(
                (p) => `
              <div class="poker-seat">
                <span>${p.name}${p.peerId === selfId ? ' (du)' : ''}${p.peerId === view.hostPeerId ? ' · Host' : ''}${p.isBot || p.peerId === POKER_BOT_PEER_ID ? ' · Bot' : ''}</span>
                <span class="muted">Chips ${p.chips}${p.folded ? ' · fold' : ''}${p.allIn ? ' · all-in' : ''}</span>
              </div>`
              )
              .join('')}
          </div>
          <div class="poker-msg">${view.message || ''}</div>
          ${actionRow}
        </div>
        ${debugHtml}
        ${inviteHtml}
        <div class="poker-card">
          <h3>Host-Steuerung</h3>
          <div class="poker-row">
            ${isHost ? `<button type="button" class="poker-btn poker-btn-primary" id="poker-start">Hand starten</button>` : ''}
            <button type="button" class="poker-btn poker-btn-ghost" id="poker-leave">Tisch verlassen</button>
          </div>
        </div>
      `;

      if (isHost) {
        const sel = panels.querySelector('#poker-invite-peer');
        const btn = panels.querySelector('#poker-send-invite');
        if (btn && sel?.value) {
          btn.onclick = () => {
            const peerId = sel.value;
            const payload = host.invitePayload();
            api.chat.send(peerId, payload);
            api.notify.toast?.({ title: 'Poker', message: 'Einladung gesendet.' });
          };
        }
        const sh = panels.querySelector('#poker-start');
        if (sh) sh.onclick = () => host.startHand();
        const nh = panels.querySelector('#poker-next-hand');
        if (nh) nh.onclick = () => host.startHand();
        const addBot = panels.querySelector('#poker-add-bot');
        if (addBot) {
          addBot.onclick = () => {
            const ok = host.addDebugBot();
            if (ok) {
              api.notify.toast?.({ title: 'Poker', message: 'Debug-Bot am Tisch.' });
            } else {
              api.notify.toast?.({ title: 'Poker', message: 'Bot konnte nicht hinzugefügt werden (bereits da oder voll).' });
            }
            void paint();
          };
        }
        const rmBot = panels.querySelector('#poker-rm-bot');
        if (rmBot) {
          rmBot.onclick = () => {
            host.removeDebugBot();
            void paint();
          };
        }
      }

      // Öffne Spiel-Fenster Button
      const openWinBtn = panels.querySelector('#poker-open-window');
      if (openWinBtn) {
        openWinBtn.onclick = () => {
          void openGameWindowIfNeeded();
        };
      }

      const leave = panels.querySelector('#poker-leave');
      if (leave) {
        leave.onclick = () => {
          if (host) {
            broadcastWire({ wire: 'leave', tableId: host.tableId }, host.publicState().players.map((p) => p.peerId));
            host.destroy();
            host = null;
            hostRef = null;
          } else if (clientState?.hostPeerId) {
            sendWire(clientState.hostPeerId, { wire: 'leave', tableId: clientState.tableId });
          }
          clientState = null;
          myHole = [];
          void paint();
        };
      }
    }

    rootRender = () => void paint();
    void paint();

    return () => {
      rootRender = null;
    };
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
    rootRender?.();
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
        clientState = null;
        myHole = [];
        tryPump();
        rootRender?.();
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

  api.ui.registerTab({
    id: 'table',
    label: 'Poker',
    icon: 'Spade',
    order: 40,
    render,
  });

  api.onDeactivate(() => {
    offPokerChild?.();
    offPokerMessage?.();
    offPokerDisconnect?.();
    offPokerConnect?.();
    host?.destroy?.();
    host = null;
    hostRef = null;
    rootRender = null;
  });

  api.log.info('Poker-Plugin UI geladen');
})();
