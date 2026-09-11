export const REACTION_KIND = 'reaction';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

const ALLOWED = new Set(REACTION_EMOJIS);

export function isAllowedReactionEmoji(emoji) {
  return typeof emoji === 'string' && ALLOWED.has(emoji);
}

export function reactorHasEmoji(reactions, reactorId, emoji) {
  const list = reactions?.[emoji];
  return Array.isArray(list) && list.includes(reactorId);
}

/** Ein Emoji pro Person: setzen oder entfernen (active). */
export function setReactorEmoji(reactions, emoji, reactorId, active) {
  const next = {};
  for (const [key, ids] of Object.entries(reactions && typeof reactions === 'object' ? reactions : {})) {
    if (!isAllowedReactionEmoji(key) || !Array.isArray(ids)) continue;
    const list = ids.filter((id) => id && id !== reactorId);
    if (list.length) next[key] = list;
  }
  if (active && isAllowedReactionEmoji(emoji) && reactorId) {
    next[emoji] = [...(next[emoji] || []), reactorId];
  }
  return next;
}

export function reactionEntries(reactions) {
  if (!reactions || typeof reactions !== 'object') return [];
  return REACTION_EMOJIS
    .map((emoji) => {
      const ids = Array.isArray(reactions[emoji]) ? reactions[emoji].filter(Boolean) : [];
      return ids.length ? { emoji, ids, count: ids.length } : null;
    })
    .filter(Boolean);
}

export function findCachedMessage(cacheRef, chatId, messageId) {
  if (!chatId || !messageId) return null;
  const list = cacheRef?.current?.[chatId];
  if (!Array.isArray(list)) return null;
  return list.find((item) => item?.messageId === messageId) || null;
}

export async function findMessageForReaction(cacheRef, chatId, messageId) {
  const cached = findCachedMessage(cacheRef, chatId, messageId);
  if (cached) return cached;
  if (!window.bluetalk?.messages?.getBatch || !chatId || !messageId) return null;
  try {
    const batch = await window.bluetalk.messages.getBatch(chatId, { skip: 0, limit: 80 });
    return (batch.messages || []).find((item) => item?.messageId === messageId) || null;
  } catch {
    return null;
  }
}
