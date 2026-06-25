/** Renderer-Einstieg; abgestimmt mit src/shared/contactNotificationMute.js (kein direkter Import — CJS im Browser). */

/** @param {object | null | undefined} contact */
export function isContactNotificationMuted(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return false;
  if (contact.notifyMutedManual === true) return true;
  if (typeof contact.notifyMutedUntil === 'number' && now < contact.notifyMutedUntil) return true;
  return false;
}
