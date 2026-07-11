/**
 * UNO — Kartendefinitionen, Deck-Aufbau, Mischen, Kartenwerte.
 * Reine Funktionen ohne Netzwerk-/API-Abhängigkeiten.
 */

export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const NUMBER_VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const ACTION_VALUES = ['skip', 'reverse', 'draw2'];
export const WILD_VALUES = ['wild', 'wild4'];

/** Kryptografisch faires Fisher-Yates-Mischen (kopiert, mutiert das Original nicht). */
export function shuffle(arr) {
  const a = arr.slice();
  if (a.length < 2) return a;
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

/** Baut ein vollständiges 108-Karten-UNO-Deck mit stabilen Karten-IDs. */
export function buildDeck() {
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

/** Karten, die nicht als Startkarte der Ablage dienen dürfen (Aktions-/Wildkarten). */
export function isSpecialStartCard(card) {
  if (!card) return true;
  if (card.color === 'wild') return true;
  return ACTION_VALUES.includes(card.value);
}

/** Punktwert einer Karte für die Punkte-Wertung. */
export function cardPoints(card) {
  if (!card) return 0;
  if (card.value === 'wild' || card.value === 'wild4') return 50;
  if (ACTION_VALUES.includes(card.value)) return 20;
  const n = Number(card.value);
  return Number.isFinite(n) ? n : 0;
}

/** Kurzes Label für Statusmeldungen. */
export function cardLabel(card) {
  if (!card) return '';
  if (card.value === 'wild') return 'Wild';
  if (card.value === 'wild4') return '+4';
  if (card.value === 'skip') return 'Skip';
  if (card.value === 'reverse') return 'Rev';
  if (card.value === 'draw2') return '+2';
  return String(card.value);
}
