/**
 * BlueTalk Poker — Karten & Deck.
 * Reine Logik ohne Host-/Netzwerk-Bezug (ES-Modul, von engine.js/ui.js importiert).
 */

export const RANK_NAMES = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
export const SUIT_NAMES = ['♣', '♦', '♥', '♠'];

/** Lokaler Debug-Bot (nur Host, keine Netzwerk-Verbindung) */
export const POKER_BOT_PEER_ID = '__bt_poker_bot_debug__';

export function isPokerBotId(id) {
  return id === POKER_BOT_PEER_ID;
}

export function cardLabel(c) {
  const r = c % 13;
  const s = (c / 13) | 0;
  return RANK_NAMES[r] + SUIT_NAMES[s];
}

export function shuffle(arr) {
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

export function makeDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 0; r < 13; r++) d.push(s * 13 + r);
  return d;
}
