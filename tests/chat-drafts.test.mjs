import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_DRAFTS_STORE_KEY,
  formatDraftPreview,
  getDraftText,
  normalizeDraftMap,
  setDraftInMap,
} from '../src/shared/chat-features.js';
import { SYNCED_STORE_KEYS } from '../src/bridge/syncLayer.js';

test('Entwürfe werden pro Chat normalisiert und leere verworfen', () => {
  const stored = {
    'peer-a': 'Hallo  ',
    'peer-b': { text: 'Draft', updatedAt: 42 },
    'peer-c': '   ',
    '': 'nope',
  };
  const map = normalizeDraftMap(stored);
  assert.equal(getDraftText(map, 'peer-a'), 'Hallo  ');
  assert.equal(getDraftText(map, 'peer-b'), 'Draft');
  assert.equal(getDraftText(map, 'peer-c'), '');
  assert.equal('peer-c' in map, false);
});

test('setDraftInMap speichert, aktualisiert und löscht', () => {
  let drafts = {};
  drafts = setDraftInMap(drafts, 'p1', 'eins', 100);
  assert.equal(getDraftText(drafts, 'p1'), 'eins');
  drafts = setDraftInMap(drafts, 'p1', 'zwei', 200);
  assert.equal(drafts.p1.updatedAt, 200);
  drafts = setDraftInMap(drafts, 'p1', '  ', 300);
  assert.equal(getDraftText(drafts, 'p1'), '');
});

test('chatDrafts bleibt gerätelokal und wird nicht synchronisiert', () => {
  assert.equal(CHAT_DRAFTS_STORE_KEY, 'chatDrafts');
  assert.equal(SYNCED_STORE_KEYS.includes(CHAT_DRAFTS_STORE_KEY), false);
});

test('Chatlisten-Vorschau trägt Entwurf-Präfix', () => {
  assert.equal(formatDraftPreview('  Bitte später senden  '), 'Entwurf: Bitte später senden');
  assert.equal(formatDraftPreview(''), '');
  const long = formatDraftPreview('x'.repeat(90), 20);
  assert.equal(long.startsWith('Entwurf: '), true);
  assert.equal(long.endsWith('…'), true);
  assert.ok(long.length <= 'Entwurf: '.length + 20);
});
