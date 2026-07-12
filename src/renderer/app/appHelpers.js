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
