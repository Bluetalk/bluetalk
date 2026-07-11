/**
 * UNO — Nachrichten-Serialisierung, Guards und Kontakt-Checks für P2P.
 * Kapselt die Plugin-API-Aufrufe für den Draht-Transport.
 */

/** Ob ein Peer als blockierter Kontakt gilt (dann keine Nachrichten). */
export function isContactBlocked(api, peerId) {
  const list = api.contacts() || [];
  return list.some((c) => c?.id === peerId && c.blocked === true);
}

/**
 * Erzeugt gebundene Sende-Helfer für UNO-Draht-Nachrichten.
 * `send` verwirft leere/blockierte Ziele; `broadcast` verteilt an eine Peer-Liste.
 */
export function createWire(api) {
  const send = (peerId, body) => {
    if (!peerId || isContactBlocked(api, peerId)) return;
    api.peer.send(peerId, { kind: 'uno', uno: body, timestamp: Date.now() });
  };
  const broadcast = (body, peerIds) => {
    for (const id of peerIds || []) send(id, body);
  };
  return { send, broadcast };
}

/**
 * Validiert und normalisiert eine eingehende Spieler-Aktion.
 * Gibt `null` zurück, wenn die Nachricht keinen brauchbaren Aktionstyp trägt.
 */
export function sanitizeIncomingAction(action) {
  if (!action || typeof action !== 'object') return null;
  const type = typeof action.type === 'string' ? action.type : null;
  if (!type) return null;
  const out = { type };
  if (typeof action.cardId === 'string') out.cardId = action.cardId;
  if (typeof action.color === 'string') out.color = action.color;
  return out;
}

/** Kürzt/normalisiert einen Anzeigenamen. */
export function sanitizeName(name, fallback = 'Spieler') {
  const s = String(name == null ? '' : name).trim().slice(0, 48);
  return s || fallback;
}
