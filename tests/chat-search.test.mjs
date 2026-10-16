import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findSearchHits,
  firstUnreadIndex,
  isNewLocalDay,
  dateSeparatorLabel,
  isSafeHttpUrl,
  stepSearchHit,
} from '../src/shared/chat-features.js';

const messages = [
  { messageId: 'a', from: 'self', content: 'Guten Morgen', timestamp: 10 },
  { messageId: 'b', from: 'peer', content: 'Foto folgt', fileName: 'urlaub.png', timestamp: 20 },
  { messageId: 'c', from: 'peer', content: 'Bis morgen', timestamp: 30 },
];

test('Suche findet Treffer unabhängig von Groß/Klein in Text und Dateiname', () => {
  assert.deepEqual(findSearchHits(messages, '  MORGEN  ').map((h) => h.messageId), ['a', 'c']);
  assert.equal(findSearchHits(messages, 'urlaub').length, 1);
  assert.equal(findSearchHits(messages, '   ').length, 0);
  assert.equal(findSearchHits(messages, 'xyz').length, 0);
});

test('Suche wrappt vor/zurück über die Trefferliste', () => {
  const hits = findSearchHits(messages, 'morgen');
  assert.equal(stepSearchHit(hits, -1, 1), 0);
  assert.equal(stepSearchHit(hits, 0, 1), 1);
  assert.equal(stepSearchHit(hits, 1, 1), 0);
  assert.equal(stepSearchHit(hits, 0, -1), 1);
  assert.equal(stepSearchHit([], 0, 1), -1);
});

test('Datums-Trenner: Heute, Gestern, Datum', () => {
  const now = Date.parse('2026-10-16T18:00:00');
  const today = Date.parse('2026-10-16T09:00:00');
  const yesterday = Date.parse('2026-10-15T22:00:00');
  const older = Date.parse('2026-03-03T12:00:00');
  assert.equal(dateSeparatorLabel(today, now), 'Heute');
  assert.equal(dateSeparatorLabel(yesterday, now), 'Gestern');
  assert.match(dateSeparatorLabel(older, now), /März|March|3/);
  assert.equal(isNewLocalDay(today, today + 1000), false);
  assert.equal(isNewLocalDay(yesterday, today), true);
  assert.equal(isNewLocalDay(null, today), true);
});

test('erster Ungelesen-Index liegt hinter lastViewedTs', () => {
  assert.equal(firstUnreadIndex(messages, 15), 1);
  assert.equal(firstUnreadIndex(messages, 30), -1);
});

test('nur http/https-Links gelten als sicher', () => {
  assert.equal(isSafeHttpUrl('https://example.com/x'), true);
  assert.equal(isSafeHttpUrl('http://localhost:8080'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('file:///etc/passwd'), false);
  assert.equal(isSafeHttpUrl('mention://bt-alice'), false);
});
