/**
 * BlueTalk Poker — Setzrunden-/Pot-Logik & Tisch-Einstellungen.
 * Reine Logik ohne Host-/Netzwerk-Bezug.
 */

/**
 * Baut Haupt- und Side-Pots aus den Gesamteinsätzen (contrib je Peer).
 * Jede Ebene: { amount, eligible } — eligible = Peers, die mindestens bis cap
 * eingezahlt haben. Die Auswertung (wer gewinnt) filtert später auf nicht
 * gefoldete Spieler.
 */
export function buildSidePots(contrib) {
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

export function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function defaultSettings() {
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
    lobbyAccess: 'invite',
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings(), minSeats = 2) {
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
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  return next;
}

export function isPokerLobbyJoinable(phase) {
  return phase === 'lobby' || phase === 'between';
}
