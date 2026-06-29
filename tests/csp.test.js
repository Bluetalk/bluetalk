const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('content security policy permits bundled data fonts', () => {
  const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(html, /font-src 'self' data:/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri 'none'/);
});
