/** Kontakt-Patches: undefined darf Name/Profilbild nicht überschreiben. */

import groupChat from '../../shared/group-chat.js';
import { isAiChatPeerId } from '../aiChatConstants.js';

const { isGroupChatId } = groupChat;

const PLACEHOLDER_NAMES = new Set(['', 'Anonymous', 'BlueTalk user']);

export function isPlaceholderDisplayName(name) {
  return PLACEHOLDER_NAMES.has(String(name || '').trim());
}

export function shouldKeepExistingContactName(existing, incoming, peerId) {
  if (incoming === undefined) return Boolean(String(existing || '').trim());
  const have = String(existing || '').trim();
  if (!have) return false;
  const next = String(incoming || '').trim();
  if (isPlaceholderDisplayName(next)) return true;
  if (next === String(peerId || '') && have !== next) return true;
  return false;
}

/**
 * Führt einen Kontakt-Patch zusammen. `undefined`-Felder (z. B. fehlendes
 * Profilbild beim Handshake) lassen den gespeicherten Wert stehen.
 * `notifyMutedUntil: undefined` bleibt die bewusste Aufhebung der Stummschaltung.
 */
export function applyContactPatchToList(prev, patch) {
  if (!patch?.id) return Array.isArray(prev) ? prev : [];
  const list = Array.isArray(prev) ? prev : [];
  const idx = list.findIndex((contact) => contact?.id === patch.id);
  const base = idx >= 0 ? list[idx] : { id: patch.id, addedAt: Date.now() };
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedUntil') && patch.notifyMutedUntil === undefined) {
    delete merged.notifyMutedUntil;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedManual') && patch.notifyMutedManual === false) {
    delete merged.notifyMutedManual;
  }
  if (shouldKeepExistingContactName(base.name, patch.name, patch.id)) {
    merged.name = base.name;
  }
  return idx >= 0
    ? list.map((contact, i) => (i === idx ? merged : contact))
    : [...list, merged];
}

/** Name aus einer eingehenden Nachricht, wenn der Kontakt noch keinen echten hat. */
export function upsertContactNameFromIncomingMessage(contacts, peerId, message) {
  const list = Array.isArray(contacts) ? contacts : [];
  if (!peerId || !message || message.from === 'self' || isGroupChatId(peerId) || isAiChatPeerId(peerId)) {
    return { contacts: list, changed: false };
  }
  const name = typeof message.sender === 'string' ? message.sender.trim() : '';
  if (!name || isPlaceholderDisplayName(name) || name === peerId) {
    return { contacts: list, changed: false };
  }
  const idx = list.findIndex((row) => row?.id === peerId);
  if (idx >= 0) {
    const existing = list[idx];
    if (!isPlaceholderDisplayName(existing?.name) && existing?.name && existing.name !== peerId) {
      return { contacts: list, changed: false };
    }
    const next = list.slice();
    next[idx] = { ...existing, name };
    return { contacts: next, changed: true };
  }
  return {
    contacts: [...list, { id: peerId, name, addedAt: Number(message.timestamp) || Date.now() }],
    changed: true,
  };
}
