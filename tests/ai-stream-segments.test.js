const test = require('node:test');
const assert = require('node:assert/strict');
const {
  upsertStreamThinking,
  upsertStreamAnswer,
  consolidateSegments,
} = require('../src/main/ai-stream-segments.js');

test('stream upserts reuse thinking and answer instead of alternating duplicates', () => {
  const segments = [];
  upsertStreamThinking(segments, 'Schritt 1');
  upsertStreamAnswer(segments, 'Hallo');
  upsertStreamThinking(segments, 'Schritt 1+2');
  upsertStreamAnswer(segments, 'Hallo Welt');

  assert.equal(segments.length, 2);
  assert.equal(segments[0].type, 'thinking');
  assert.equal(segments[0].text, 'Schritt 1+2');
  assert.equal(segments[1].type, 'answer');
  assert.equal(segments[1].text, 'Hallo Welt');
});

test('stream upserts start new segments after tool events', () => {
  const segments = [
    { type: 'thinking', text: 'Plan A', toolAfter: true },
    { type: 'tool', event: { name: 'read_file' } },
  ];
  upsertStreamThinking(segments, 'Plan B');
  upsertStreamAnswer(segments, 'Ergebnis');

  assert.equal(segments.length, 4);
  assert.equal(segments[2].text, 'Plan B');
  assert.equal(segments[3].text, 'Ergebnis');
});

test('consolidateSegments merges consecutive duplicates', () => {
  const merged = consolidateSegments([
    { type: 'thinking', text: 'a' },
    { type: 'thinking', text: 'ab' },
    { type: 'answer', text: 'x' },
    { type: 'answer', text: 'xy' },
  ]);
  assert.deepEqual(merged, [
    { type: 'thinking', text: 'ab' },
    { type: 'answer', text: 'xy' },
  ]);
});
