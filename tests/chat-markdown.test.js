const test = require('node:test');
const assert = require('node:assert/strict');

test('normalizeChatMarkdown converts single newlines to markdown line breaks', async () => {
  const { normalizeChatMarkdown } = await import('../src/renderer/utils/normalizeChatMarkdown.js');
  const input = 'Zeile eins\nZeile zwei';
  const output = normalizeChatMarkdown(input);
  assert.equal(output, 'Zeile eins  \nZeile zwei');
});

test('normalizeChatMarkdown preserves display math blocks', async () => {
  const { normalizeChatMarkdown } = await import('../src/renderer/utils/normalizeChatMarkdown.js');
  const input = 'Vorher\n$$\nE = mc^2\n$$\nNachher';
  const output = normalizeChatMarkdown(input);
  assert.ok(output.includes('$$\nE = mc^2\n$$'));
  assert.ok(output.includes('Vorher  \n'));
  assert.ok(output.includes('\nNachher'));
});

test('normalizeChatMarkdown preserves inline math', async () => {
  const { normalizeChatMarkdown } = await import('../src/renderer/utils/normalizeChatMarkdown.js');
  const input = 'Die Formel $a^2 + b^2 = c^2$ gilt.';
  const output = normalizeChatMarkdown(input);
  assert.equal(output, 'Die Formel $a^2 + b^2 = c^2$ gilt.');
});
