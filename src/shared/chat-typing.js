export const TYPING_KIND = 'typing';
export const TYPING_EXPIRE_MS = 4000;
export const TYPING_REFRESH_MS = 2000;

export function buildTypingPayload(active) {
  return {
    kind: TYPING_KIND,
    active: Boolean(active),
    timestamp: Date.now(),
  };
}

export function typingExpiresAt(message, now = Date.now()) {
  if (message?.active === false) return 0;
  const sentAt = typeof message?.timestamp === 'number' ? message.timestamp : now;
  return sentAt + TYPING_EXPIRE_MS;
}

export function isTypingActive(expiresAt, now = Date.now()) {
  return Number(expiresAt) > now;
}
