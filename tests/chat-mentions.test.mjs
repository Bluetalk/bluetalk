import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMentionReplacement,
  collectMentionPeerIds,
  filterMentionMembers,
  getMentionQueryAtCursor,
  messageMentionsPeer,
  parseMentions,
} from '../src/shared/chat-features.js';

const members = [
  { peerId: 'bt-self', displayName: 'Ich', state: 'active' },
  { peerId: 'bt-alice', displayName: 'Alice', state: 'active' },
  { peerId: 'bt-bob', displayName: 'Bob Schmidt', state: 'active' },
  { peerId: 'bt-gone', displayName: 'Weg', state: 'left' },
];

test('@ am Cursor liefert Query und Bereich', () => {
  assert.equal(getMentionQueryAtCursor('Hallo Welt', 11), null);
  assert.deepEqual(getMentionQueryAtCursor('Hey @Al', 7), { query: 'Al', start: 4, end: 7 });
  assert.deepEqual(getMentionQueryAtCursor('@', 1), { query: '', start: 0, end: 1 });
});

test('Autocomplete filtert aktive Mitglieder ohne sich selbst', () => {
  const hits = filterMentionMembers(members, 'al', 'bt-self');
  assert.deepEqual(hits.map((m) => m.peerId), ['bt-alice']);
  assert.equal(filterMentionMembers(members, '', 'bt-self').some((m) => m.peerId === 'bt-self'), false);
  assert.equal(filterMentionMembers(members, '', 'bt-self').some((m) => m.peerId === 'bt-gone'), false);
});

test('parseMentions erkennt @Namen an Wortgrenzen, längere zuerst', () => {
  const found = parseMentions('Hi @Alice und @Bob Schmidt!', members);
  assert.deepEqual(found.map((m) => m.peerId).sort(), ['bt-alice', 'bt-bob']);
  assert.equal(parseMentions('email@Alice.com', members).length, 0);
});

test('Ersetzung setzt @Name plus Leerzeichen', () => {
  const next = applyMentionReplacement('Hey @Al', 4, 7, 'Alice');
  assert.equal(next.text, 'Hey @Alice ');
  assert.equal(next.cursor, 11);
});

test('Mentions-Peer-IDs inkl. expliziter Liste', () => {
  assert.equal(messageMentionsPeer('Ping @Alice', members, 'bt-alice'), true);
  assert.equal(messageMentionsPeer('Ping @Alice', members, 'bt-bob'), false);
  assert.deepEqual(
    collectMentionPeerIds('Ping @Alice', members, ['bt-extra']).sort(),
    ['bt-alice', 'bt-extra'],
  );
});
