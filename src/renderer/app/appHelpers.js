// Reine top-level Helfer, ausgelagert aus App.jsx.
// Keine Abhängigkeit von React-State/Hooks; Refs werden als Parameter übergeben.

export function newChatMessageId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore */
  }
  return `bt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Ausgehende E2EE, sofern der Kontakt nicht explizit `e2eeEnabled: false` hat. */
export function contactWantsOutgoingE2ee(contactsRef, peerId) {
  if (!peerId) return true;
  const c = contactsRef.current.find((x) => x?.id === peerId);
  if (c?.e2eeEnabled === false) return false;
  return true;
}
