const test = require('node:test');
const assert = require('node:assert/strict');

const { compareVersionParts } = require('../src/shared/version.js');

test('version comparison handles patch and prerelease versions', () => {
  assert.ok(compareVersionParts('1.1.3', '1.1.2') > 0);
  assert.ok(compareVersionParts('1.0.7-alpha', '1.0.6-alpha') > 0);
  assert.ok(compareVersionParts('1.1.0', '1.1.0-alpha') > 0);
  assert.ok(compareVersionParts('v2.0.0', '1.99.99') > 0);
  assert.equal(compareVersionParts('1.1', '1.1.0'), 0);
});
