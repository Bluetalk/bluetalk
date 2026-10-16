/**
 * Reine Chat-Hilfslogik (ohne DOM/React): Bearbeiten, Suche, Entwürfe,
 * Erwähnungen, Datums-Trenner, Anheften und sichere Links.
 * Wird von Renderer und `node --test` gemeinsam genutzt.
 */

export const MESSAGE_EDIT_KIND = 'message-edit';
export const MESSAGE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CHAT_DRAFTS_STORE_KEY = 'chatDrafts';

/** Wire-Fähigkeiten, die dieser Client in Presence/Profil meldet. */
export const PEER_FEATURE_MESSAGE_EDIT = 'message-edit';
export const PEER_FEATURE_MENTIONS = 'mentions';
export const PEER_FEATURE_PINS = 'pins';
export const PEER_FEATURE_VIDEO_CALL = 'video-call';

export const OWN_PEER_FEATURES = Object.freeze([
  PEER_FEATURE_MESSAGE_EDIT,
  PEER_FEATURE_MENTIONS,
  PEER_FEATURE_PINS,
  PEER_FEATURE_VIDEO_CALL,
]);

const KNOWN_PEER_FEATURES = new Set(OWN_PEER_FEATURES);

/**
 * Normalisiert ein gemeldetes `features`-Array. Unbekannte IDs fallen weg.
 * Fehlendes/kein Array → leer (älterer Client, der das Feld nicht kennt).
 */
export function normalizePeerFeatures(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const id = String(item || '').trim();
    if (!KNOWN_PEER_FEATURES.has(id) || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** Letzte gemeldete Fähigkeiten eines Kontakts (Mehrgeräte: zuletzt gewinnt). */
export function contactHasPeerFeature(contact, feature) {
  return normalizePeerFeatures(contact?.features).includes(feature);
}

export function selectFeatureCapablePeerIds(peerIds, contacts, feature) {
  const byId = new Map(
    (Array.isArray(contacts) ? contacts : []).filter((row) => row?.id).map((row) => [row.id, row])
  );
  return (Array.isArray(peerIds) ? peerIds : []).filter((id) => (
    contactHasPeerFeature(byId.get(id), feature)
  ));
}

export function legacyEditNotice(displayName) {
  const name = String(displayName || '').trim() || 'Dieser Kontakt';
  return `${name} nutzt eine ältere BlueTalk-Version — die Änderung sieht nur du`;
}

/** Nachrichtentypen, die als Chatverlauf gespeichert werden dürfen. */
export const STOREABLE_CHAT_KINDS = new Set([
  'chat',
  'file',
  'sticker',
  'contact-share',
]);

export function isStoreableChatKind(kind) {
  return STOREABLE_CHAT_KINDS.has(kind);
}

export function canEditOwnTextMessage(message, { now = Date.now(), isSelf } = {}) {
  if (!message || message.kind !== 'chat') return false;
  const own = typeof isSelf === 'boolean' ? isSelf : message.from === 'self';
  if (!own) return false;
  if (!message.messageId) return false;
  const ts = Number(message.timestamp);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  if (now - ts > MESSAGE_EDIT_WINDOW_MS) return false;
  return true;
}

export function findLastEditableOwnMessage(messages, now = Date.now()) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (canEditOwnTextMessage(list[i], { now, isSelf: list[i]?.from === 'self' })) {
      return list[i];
    }
  }
  return null;
}

export function validateMessageEditPayload(payload, { maxChars = 128 * 1024 } = {}) {
  if (!payload || payload.kind !== MESSAGE_EDIT_KIND) {
    return { ok: false, error: 'invalid_kind' };
  }
  const refMessageId = String(payload.refMessageId || '').trim();
  if (!refMessageId) return { ok: false, error: 'missing_ref' };
  if (typeof payload.content !== 'string') return { ok: false, error: 'invalid_content' };
  if (!payload.content.trim()) return { ok: false, error: 'empty' };
  if (payload.content.length > maxChars) return { ok: false, error: 'too_long' };
  const editedAt = Number(payload.editedAt);
  if (!Number.isFinite(editedAt) || editedAt <= 0) return { ok: false, error: 'invalid_edited_at' };
  return { ok: true, refMessageId, content: payload.content, editedAt };
}

/**
 * Wendet ein eingehendes Edit auf eine vorhandene Textnachricht an.
 * `editorIsOriginalSender` muss der Aufrufer anhand from/senderPeerId setzen.
 */
export function applyInboundMessageEdit(existing, payload, {
  now = Date.now(),
  editorIsOriginalSender = true,
} = {}) {
  const validated = validateMessageEditPayload(payload);
  if (!validated.ok) return { ok: false, error: validated.error };
  if (!editorIsOriginalSender) return { ok: false, error: 'sender_mismatch' };
  if (existing) {
    if (existing.kind !== 'chat') return { ok: false, error: 'not_text' };
    const originalTs = Number(existing.timestamp);
    if (!Number.isFinite(originalTs) || originalTs <= 0) return { ok: false, error: 'no_timestamp' };
    if (validated.editedAt - originalTs > MESSAGE_EDIT_WINDOW_MS) {
      return { ok: false, error: 'window_expired' };
    }
    const prevEdited = Number(existing.editedAt);
    if (Number.isFinite(prevEdited) && prevEdited > 0 && validated.editedAt <= prevEdited) {
      return { ok: true, skipped: true, refMessageId: validated.refMessageId };
    }
  }
  if (validated.editedAt > now + 5 * 60 * 1000) return { ok: false, error: 'edited_in_future' };
  return {
    ok: true,
    refMessageId: validated.refMessageId,
    patch: {
      content: validated.content,
      editedAt: validated.editedAt,
      edited: true,
    },
  };
}

export function buildMessageEditInner({
  refMessageId,
  content,
  editedAt = Date.now(),
  sender,
  messageId,
}) {
  return {
    kind: MESSAGE_EDIT_KIND,
    refMessageId,
    content,
    editedAt,
    sender,
    messageId,
    timestamp: editedAt,
  };
}

export function getMentionQueryAtCursor(text, cursor) {
  const value = String(text || '');
  const pos = Math.max(0, Math.min(Number(cursor) || 0, value.length));
  const before = value.slice(0, pos);
  const match = before.match(/(^|[\s([{])@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] || '';
  const start = before.length - query.length - 1;
  return { query, start, end: pos };
}

export function filterMentionMembers(members, query, ownPeerId) {
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(members) ? members : [])
    .filter((member) => member?.peerId && member.peerId !== ownPeerId)
    .filter((member) => member.state !== 'left' && member.state !== 'removed')
    .filter((member) => {
      if (!q) return true;
      const name = String(member.displayName || member.name || '').toLowerCase();
      return name.includes(q) || String(member.peerId).toLowerCase().includes(q);
    });
}

function mentionBoundaryOk(text, index, tokenLength) {
  if (index > 0 && !/[\s([{]/.test(text[index - 1])) return false;
  const after = text[index + tokenLength];
  return !after || /[\s.,!?;:)\]}]/.test(after);
}

export function parseMentions(text, members) {
  const str = String(text || '');
  const names = (Array.isArray(members) ? members : [])
    .map((member) => ({
      peerId: member?.peerId,
      name: String(member?.displayName || member?.name || '').trim(),
    }))
    .filter((member) => member.peerId && member.name)
    .sort((a, b) => b.name.length - a.name.length);

  const found = [];
  const seen = new Set();
  for (const member of names) {
    const token = `@${member.name}`;
    let idx = 0;
    while (idx < str.length) {
      const at = str.indexOf(token, idx);
      if (at < 0) break;
      if (mentionBoundaryOk(str, at, token.length) && !seen.has(member.peerId)) {
        seen.add(member.peerId);
        found.push({ peerId: member.peerId, name: member.name, index: at });
      }
      idx = at + token.length;
    }
  }
  return found;
}

export function applyMentionReplacement(text, start, end, name) {
  const value = String(text || '');
  const from = Math.max(0, start);
  const to = Math.max(from, end);
  const insertion = `@${name} `;
  const next = `${value.slice(0, from)}${insertion}${value.slice(to)}`;
  return { text: next, cursor: from + insertion.length };
}

export function messageMentionsPeer(text, members, peerId) {
  if (!peerId) return false;
  return parseMentions(text, members).some((entry) => entry.peerId === peerId);
}

export function collectMentionPeerIds(text, members, extraIds = []) {
  const ids = new Set(
    extraIds.filter(Boolean).map((id) => String(id))
  );
  for (const entry of parseMentions(text, members)) ids.add(entry.peerId);
  return [...ids];
}

export function wrapMentionTokensForMarkdown(text, members) {
  const mentions = parseMentions(text, members);
  if (mentions.length === 0) return String(text || '');
  const sorted = [...mentions].sort((a, b) => b.index - a.index);
  let next = String(text || '');
  for (const mention of sorted) {
    const token = `@${mention.name}`;
    next = `${next.slice(0, mention.index)}[@${mention.name}](mention://${encodeURIComponent(mention.peerId)})${next.slice(mention.index + token.length)}`;
  }
  return next;
}

export function normalizeSearchQuery(query) {
  return String(query || '').trim().toLowerCase();
}

export function messageSearchHaystack(message) {
  if (!message) return '';
  return [
    message.content,
    message.fileName,
    message.sender,
    message.replyTo?.preview,
    message.sharedContact?.displayName,
  ].filter(Boolean).join('\n').toLowerCase();
}

export function findSearchHits(messages, query) {
  const q = normalizeSearchQuery(query);
  if (!q) return [];
  const hits = [];
  (Array.isArray(messages) ? messages : []).forEach((message, index) => {
    if (!message?.messageId) return;
    if (messageSearchHaystack(message).includes(q)) {
      hits.push({ messageId: message.messageId, index });
    }
  });
  return hits;
}

export function stepSearchHit(hits, currentIndex, direction) {
  const list = Array.isArray(hits) ? hits : [];
  if (list.length === 0) return -1;
  const dir = direction < 0 ? -1 : 1;
  if (!Number.isInteger(currentIndex) || currentIndex < 0) {
    return dir > 0 ? 0 : list.length - 1;
  }
  const next = currentIndex + dir;
  if (next < 0) return list.length - 1;
  if (next >= list.length) return 0;
  return next;
}

export function normalizeDraftMap(stored) {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const next = {};
  for (const [peerId, value] of Object.entries(stored)) {
    if (!peerId) continue;
    const text = typeof value === 'string'
      ? value
      : (value && typeof value.text === 'string' ? value.text : '');
    if (!String(text).trim()) continue;
    next[peerId] = {
      text: String(text),
      updatedAt: typeof value === 'object' && Number.isFinite(Number(value?.updatedAt))
        ? Number(value.updatedAt)
        : 0,
    };
  }
  return next;
}

export function setDraftInMap(drafts, peerId, text, now = Date.now()) {
  const next = { ...(drafts || {}) };
  if (!peerId) return next;
  if (!String(text || '').trim()) {
    delete next[peerId];
    return next;
  }
  next[peerId] = { text: String(text), updatedAt: now };
  return next;
}

export function getDraftText(drafts, peerId) {
  const row = drafts?.[peerId];
  if (!row) return '';
  return typeof row === 'string' ? row : String(row.text || '');
}

export function formatDraftPreview(text, max = 72) {
  const body = String(text || '').replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const clipped = body.length > max ? `${body.slice(0, Math.max(1, max - 1))}…` : body;
  return `Entwurf: ${clipped}`;
}

export function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateSeparatorLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const day = startOfLocalDay(ts);
  const today = startOfLocalDay(now);
  const yesterday = today - 86400000;
  if (day === today) return 'Heute';
  if (day === yesterday) return 'Gestern';
  return new Date(ts).toLocaleDateString('de-DE', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

export function isNewLocalDay(prevTs, ts) {
  if (!Number.isFinite(Number(ts))) return false;
  if (!Number.isFinite(Number(prevTs))) return true;
  return startOfLocalDay(prevTs) !== startOfLocalDay(ts);
}

export function firstUnreadIndex(messages, lastViewedTs) {
  const bound = typeof lastViewedTs === 'number' ? lastViewedTs : 0;
  const list = Array.isArray(messages) ? messages : [];
  return list.findIndex((message) => (
    message
    && message.from !== 'self'
    && typeof message.timestamp === 'number'
    && message.timestamp > bound
  ));
}

export function collectPinnedMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message && message.pinned === true && message.messageId)
    .sort((a, b) => (Number(a.pinnedAt) || 0) - (Number(b.pinnedAt) || 0));
}

export function nextPinnedIndex(length, current, direction = 1) {
  const len = Number(length) || 0;
  if (len <= 0) return 0;
  const dir = direction < 0 ? -1 : 1;
  const from = Number.isInteger(current) ? current : 0;
  return (from + dir + len) % len;
}

export function isSafeHttpUrl(href) {
  if (typeof href !== 'string') return false;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openSafeHttpUrl(href) {
  if (!isSafeHttpUrl(href)) return false;
  const open = typeof window !== 'undefined' ? window.bluetalk?.app?.openUrl : null;
  if (typeof open === 'function') {
    void open(href);
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
