/** @param {object | null | undefined} contact */
function isContactNotificationMuted(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return false;
  if (contact.notifyMutedManual === true) return true;
  if (typeof contact.notifyMutedUntil === 'number' && now < contact.notifyMutedUntil) return true;
  return false;
}

/** @param {unknown} contacts @param {string} peerId */
function isPeerNotificationMuted(contacts, peerId, now = Date.now()) {
  if (!peerId || !Array.isArray(contacts)) return false;
  const contact = contacts.find((c) => c && c.id === peerId);
  return isContactNotificationMuted(contact, now);
}

module.exports = {
  isContactNotificationMuted,
  isPeerNotificationMuted,
};
