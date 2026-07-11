/**
 * UNO — Zugvalidierung, Effekte, Hausregeln, Einstellungen.
 * Reine Funktionen ohne Netzwerk-/API-Abhängigkeiten.
 */

import { COLORS } from './deck.js';

export function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function defaultSettings() {
  return {
    tableName: 'UNO-Tisch',
    maxPlayers: 4,
    turnTimeSec: 0,
    autoStart: false,
    gameMode: 'single',
    houseRules: 'official',
    targetScore: 500,
    penaltyCards: 2,
    lobbyAccess: 'invite',
  };
}

export function sanitizeSettings(input = {}, fallback = defaultSettings(), minSeats = 2) {
  const base = { ...defaultSettings(), ...fallback };
  const next = { ...base, ...(input && typeof input === 'object' ? input : {}) };
  next.tableName = String(next.tableName || 'UNO-Tisch').trim().slice(0, 48) || 'UNO-Tisch';
  next.maxPlayers = clampInt(next.maxPlayers, Math.max(2, minSeats), 8, Math.max(4, minSeats));
  next.turnTimeSec = clampInt(next.turnTimeSec, 0, 300, fallback.turnTimeSec || 0);
  next.autoStart = next.autoStart === true;
  next.gameMode = next.gameMode === 'points' ? 'points' : 'single';
  next.houseRules = next.houseRules === 'casual' ? 'casual' : 'official';
  next.targetScore = clampInt(next.targetScore, 100, 10000, fallback.targetScore || 500);
  next.penaltyCards = clampInt(next.penaltyCards, 1, 10, fallback.penaltyCards || 2);
  next.lobbyAccess = next.lobbyAccess === 'public' ? 'public' : 'invite';
  return next;
}

/** Effektive Farbe der obersten Karte (Wild → gewählte aktive Farbe). */
export function topEffectiveColor(topCard, activeColor) {
  if (!topCard) return activeColor;
  if (topCard.color === 'wild') return activeColor;
  return topCard.color;
}

/** Ob die Hand mindestens eine Karte der genannten Farbe enthält. */
export function hasMatchingColor(hand, color) {
  if (!color || color === 'wild') return false;
  return (hand || []).some((c) => c.color === color);
}

/**
 * Ob eine Karte auf die oberste Ablagekarte gespielt werden darf.
 * Bei offiziellen Regeln ist Wild +4 nur erlaubt, wenn keine passende Farbe auf der Hand liegt.
 */
export function canPlay(card, topCard, activeColor, houseRules, hand) {
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

/** Ob eine Karte auf einen laufenden Zieh-Stapel (Casual-Hausregel) gelegt werden darf. */
export function canStackDraw(card, pendingDrawType, houseRules) {
  if (houseRules !== 'casual' || !pendingDrawType || !card) return false;
  if (pendingDrawType === 'draw2') return card.value === 'draw2' || card.value === 'wild4';
  if (pendingDrawType === 'draw4') return card.value === 'wild4';
  return false;
}

/** Gültige Farbwahl. */
export function isValidColor(color) {
  return COLORS.includes(color);
}
