import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_EDIT_KIND,
  MESSAGE_EDIT_WINDOW_MS,
  OWN_PEER_FEATURES,
  PEER_FEATURE_MESSAGE_EDIT,
  applyInboundMessageEdit,
  canEditOwnTextMessage,
  contactHasPeerFeature,
  findLastEditableOwnMessage,
  isStoreableChatKind,
  legacyEditNotice,
  normalizePeerFeatures,
  selectFeatureCapablePeerIds,
  validateMessageEditPayload,
} from '../src/shared/chat-features.js';
import { buildUserPresencePayload } from '../src/shared/user-presence.js';
import { SYNCED_STORE_KEYS } from '../src/bridge/syncLayer.js';

const NOW = 1_700_000_000_000;

function ownText(overrides = {}) {
  return {
    kind: 'chat',
    from: 'self',
    messageId: 'm1',
    content: 'Hallo',
    timestamp: NOW - 60_000,
    ...overrides,
  };
}

test('eigene Textnachricht ist innerhalb von 24 h bearbeitbar', () => {
  assert.equal(canEditOwnTextMessage(ownText(), { now: NOW }), true);
  assert.equal(canEditOwnTextMessage(ownText({ timestamp: NOW - MESSAGE_EDIT_WINDOW_MS + 1 }), { now: NOW }), true);
});

test('Bearbeiten ist nach 24 h, für Fremde und Nicht-Text gesperrt', () => {
  assert.equal(canEditOwnTextMessage(ownText({ timestamp: NOW - MESSAGE_EDIT_WINDOW_MS - 1 }), { now: NOW }), false);
  assert.equal(canEditOwnTextMessage(ownText({ from: 'peer' }), { now: NOW }), false);
  assert.equal(canEditOwnTextMessage(ownText({ kind: 'file' }), { now: NOW }), false);
  assert.equal(canEditOwnTextMessage(ownText({ messageId: '' }), { now: NOW }), false);
});

test('letzte eigene Textnachricht im Zeitfenster wird gefunden', () => {
  const messages = [
    ownText({ messageId: 'old', timestamp: NOW - MESSAGE_EDIT_WINDOW_MS - 5_000 }),
    { kind: 'sticker', from: 'self', messageId: 'st', timestamp: NOW - 1_000 },
    ownText({ messageId: 'keep', timestamp: NOW - 2_000, content: 'Letzte' }),
  ];
  assert.equal(findLastEditableOwnMessage(messages, NOW)?.messageId, 'keep');
});

test('Edit-Payload braucht ref, Inhalt und editedAt', () => {
  assert.equal(validateMessageEditPayload({ kind: MESSAGE_EDIT_KIND }).ok, false);
  assert.equal(validateMessageEditPayload({
    kind: MESSAGE_EDIT_KIND,
    refMessageId: 'm1',
    content: '   ',
    editedAt: NOW,
  }).ok, false);
  assert.equal(validateMessageEditPayload({
    kind: 'chat',
    refMessageId: 'm1',
    content: 'Neu',
    editedAt: NOW,
  }).error, 'invalid_kind');
  const ok = validateMessageEditPayload({
    kind: MESSAGE_EDIT_KIND,
    refMessageId: 'm1',
    content: 'Neu',
    editedAt: NOW,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.content, 'Neu');
});

test('Empfänger patched nur eigene Original-Texte im Zeitfenster', () => {
  const existing = ownText({ from: 'alice', timestamp: NOW - 3_600_000 });
  const payload = {
    kind: MESSAGE_EDIT_KIND,
    refMessageId: 'm1',
    content: 'Korrigiert',
    editedAt: NOW,
  };
  const applied = applyInboundMessageEdit(existing, payload, { now: NOW, editorIsOriginalSender: true });
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.patch, { content: 'Korrigiert', editedAt: NOW, edited: true });

  assert.equal(applyInboundMessageEdit(existing, payload, { now: NOW, editorIsOriginalSender: false }).ok, false);
  assert.equal(applyInboundMessageEdit(
    { ...existing, kind: 'file' },
    payload,
    { now: NOW },
  ).error, 'not_text');
  assert.equal(applyInboundMessageEdit(existing, {
    ...payload,
    editedAt: existing.timestamp + MESSAGE_EDIT_WINDOW_MS + 1,
  }, { now: NOW + MESSAGE_EDIT_WINDOW_MS + 1 }).error, 'window_expired');
});

test('unbekannte Wire-Kinds werden nicht als Chatverlauf gespeichert', () => {
  assert.equal(isStoreableChatKind('chat'), true);
  assert.equal(isStoreableChatKind('file'), true);
  assert.equal(isStoreableChatKind('message-edit'), false);
  assert.equal(isStoreableChatKind('call-offer'), false);
  assert.equal(isStoreableChatKind('reaction'), false);
});

test('doppeltes Edit mit gleichem oder älterem editedAt ist idempotent', () => {
  const existing = ownText({ from: 'alice', timestamp: NOW - 3_600_000 });
  const payload = {
    kind: MESSAGE_EDIT_KIND,
    refMessageId: 'm1',
    content: 'Korrigiert',
    editedAt: NOW,
  };
  const first = applyInboundMessageEdit(existing, payload, { now: NOW, editorIsOriginalSender: true });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, undefined);
  const patched = { ...existing, ...first.patch };
  const duplicate = applyInboundMessageEdit(patched, payload, { now: NOW, editorIsOriginalSender: true });
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.skipped, true);
  const stale = applyInboundMessageEdit(patched, { ...payload, editedAt: NOW - 1, content: 'Älter' }, {
    now: NOW,
    editorIsOriginalSender: true,
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.skipped, true);
  const newer = applyInboundMessageEdit(patched, { ...payload, editedAt: NOW + 50, content: 'Neuer' }, {
    now: NOW + 50,
    editorIsOriginalSender: true,
  });
  assert.equal(newer.ok, true);
  assert.equal(newer.skipped, undefined);
  assert.equal(newer.patch.content, 'Neuer');
});

test('Presence-Payload wirbt message-edit und weitere Fähigkeiten', () => {
  const payload = buildUserPresencePayload({ displayName: 'Ada', presenceStatus: 'online' });
  assert.equal(payload.kind, 'user-presence');
  assert.deepEqual(payload.features, [...OWN_PEER_FEATURES]);
  assert.ok(payload.features.includes(PEER_FEATURE_MESSAGE_EDIT));
});

test('fehlende oder unbekannte features gelten als alter Client', () => {
  assert.deepEqual(normalizePeerFeatures(undefined), []);
  assert.deepEqual(normalizePeerFeatures('message-edit'), []);
  assert.deepEqual(normalizePeerFeatures(['message-edit', 'ghost-line', 'pins', 'message-edit']), [
    PEER_FEATURE_MESSAGE_EDIT,
    'pins',
  ]);
  assert.equal(contactHasPeerFeature({ features: undefined }, PEER_FEATURE_MESSAGE_EDIT), false);
  assert.equal(contactHasPeerFeature({ features: [] }, PEER_FEATURE_MESSAGE_EDIT), false);
  assert.equal(contactHasPeerFeature({ features: OWN_PEER_FEATURES }, PEER_FEATURE_MESSAGE_EDIT), true);
});

test('message-edit nur an zuletzt gemeldete fähige Kontakte', () => {
  const contacts = [
    { id: 'old', name: 'Olga' },
    { id: 'mixed-last-old', features: [] },
    { id: 'new', features: ['message-edit', 'mentions'] },
    { id: 'pins-only', features: ['pins'] },
  ];
  assert.deepEqual(
    selectFeatureCapablePeerIds(['old', 'mixed-last-old', 'new', 'pins-only', 'unknown'], contacts, PEER_FEATURE_MESSAGE_EDIT),
    ['new']
  );
  assert.equal(
    legacyEditNotice('Olga'),
    'Olga nutzt eine ältere BlueTalk-Version — die Änderung sieht nur du'
  );
});

test('Entwürfe sind bewusst nicht im Cloud-Sync, Verlaufspatches schon', () => {
  assert.equal(SYNCED_STORE_KEYS.includes('chatDrafts'), false);
  assert.ok(SYNCED_STORE_KEYS.includes('contacts'));
});
