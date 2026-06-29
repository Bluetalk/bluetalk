function parseVersion(value) {
  const normalized = String(value || '0').trim().replace(/^v/i, '');
  const [core = '0', prerelease = ''] = normalized.split('-', 2);
  const parts = core.split('.').map((part) => {
    const match = /^\d+/.exec(part);
    return match ? Number(match[0]) : 0;
  });
  return { parts, prerelease };
}

function compareVersionParts(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const count = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < count; index += 1) {
    const delta = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (delta !== 0) return delta;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, undefined, { numeric: true });
}

module.exports = { compareVersionParts };
