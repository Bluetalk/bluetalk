const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FEATURE_FLAG_DEFINITIONS,
  mergeFeatureFlagDefaults,
  getEffectiveFlag,
} = require('../src/shared/featureFlags');

test('mergeFeatureFlagDefaults fills missing keys from definitions', () => {
  const merged = mergeFeatureFlagDefaults({ resizableUi: true });
  assert.equal(merged.resizableUi, true);
  assert.equal(merged.chatUnreadListBadges, false);
  assert.equal(merged.contactNotificationMute, true);
  assert.equal(merged.settingsHub, false);
});

test('getEffectiveFlag prefers stored boolean over default', () => {
  const settings = { featureFlags: { settingsHub: true } };
  assert.equal(getEffectiveFlag(settings, 'settingsHub'), true);
  assert.equal(getEffectiveFlag(settings, 'chatUnreadListBadges'), false);
  assert.equal(getEffectiveFlag({}, 'contactNotificationMute'), true);
  assert.equal(getEffectiveFlag(null, 'unknownFlag'), false);
});

test('FEATURE_FLAG_DEFINITIONS has unique ids', () => {
  const ids = FEATURE_FLAG_DEFINITIONS.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
});
