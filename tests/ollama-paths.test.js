const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  BLUETALK_OLLAMA_MODELS_ENV,
  hasNonAsciiPathChars,
  isBlueTalkManagedModelsDir,
  isSameOrInsidePath,
  resolveOllamaModelsDir,
  windowsPublicModelsDir,
} = require('../src/main/ollama-paths.js');

test('resolveOllamaModelsDir avoids non-ASCII Windows user profiles', () => {
  const result = resolveOllamaModelsDir({
    platform: 'win32',
    appUserDataDir: 'C:\\Users\\schüler.HFERBER23\\AppData\\Roaming\\BlueTalk',
    env: { ProgramData: 'C:\\ProgramData' },
  });

  assert.equal(hasNonAsciiPathChars('C:\\Users\\schüler.HFERBER23'), true);
  assert.equal(result.dir, path.win32.join('C:\\ProgramData', 'BlueTalk', 'ollama', 'models'));
  assert.equal(result.source, 'windows-safe');
});

test('resolveOllamaModelsDir allows an explicit BlueTalk model path', () => {
  const customDir = path.join(process.cwd(), 'custom-ollama-models');
  const result = resolveOllamaModelsDir({
    platform: 'win32',
    appUserDataDir: 'C:\\Users\\schüler.HFERBER23\\AppData\\Roaming\\BlueTalk',
    env: {
      ProgramData: 'C:\\ProgramData',
      [BLUETALK_OLLAMA_MODELS_ENV]: `"${customDir}"`,
    },
  });

  assert.equal(result.dir, path.resolve(customDir));
  assert.equal(result.source, BLUETALK_OLLAMA_MODELS_ENV);
});

test('windowsPublicModelsDir provides an ASCII fallback location', () => {
  assert.equal(
    windowsPublicModelsDir({ PUBLIC: 'C:\\Users\\Public' }),
    path.win32.join('C:\\Users\\Public', 'BlueTalk', 'ollama', 'models')
  );
});

test('isSameOrInsidePath distinguishes contained and sibling paths', () => {
  const root = path.join(process.cwd(), 'root');
  assert.equal(isSameOrInsidePath(root, root), true);
  assert.equal(isSameOrInsidePath(path.join(root, 'models'), root), true);
  assert.equal(isSameOrInsidePath(path.join(process.cwd(), 'root-sibling'), root), false);
});

test('isBlueTalkManagedModelsDir only matches the managed models leaf', () => {
  assert.equal(
    isBlueTalkManagedModelsDir(path.win32.join('C:\\ProgramData', 'BlueTalk', 'ollama', 'models')),
    true
  );
  assert.equal(isBlueTalkManagedModelsDir(path.win32.join('C:\\Users\\Public')), false);
  assert.equal(isBlueTalkManagedModelsDir(path.win32.join('D:\\Models')), false);
});
