const path = require('path');

const BLUETALK_OLLAMA_MODELS_ENV = 'BLUETALK_OLLAMA_MODELS';
const LEGACY_BLUETALK_OLLAMA_MODELS_ENV = 'BLUETALK_OLLAMA_MODELS_DIR';

function cleanCustomModelsDir(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function hasNonAsciiPathChars(value) {
  return /[^\x00-\x7F]/.test(String(value || ''));
}

function defaultModelsDir(appUserDataDir) {
  return path.join(appUserDataDir, 'ollama', 'models');
}

function windowsSafeModelsDir(env = process.env) {
  const programData = cleanCustomModelsDir(env.ProgramData) || 'C:\\ProgramData';
  return path.win32.join(programData, 'BlueTalk', 'ollama', 'models');
}

function windowsPublicModelsDir(env = process.env) {
  const publicDir = cleanCustomModelsDir(env.PUBLIC) || 'C:\\Users\\Public';
  return path.win32.join(publicDir, 'BlueTalk', 'ollama', 'models');
}

function resolveOllamaModelsDir({ appUserDataDir, env = process.env, platform = process.platform } = {}) {
  const custom = cleanCustomModelsDir(
    env[BLUETALK_OLLAMA_MODELS_ENV] || env[LEGACY_BLUETALK_OLLAMA_MODELS_ENV]
  );
  if (custom) {
    return {
      dir: path.resolve(custom),
      source: BLUETALK_OLLAMA_MODELS_ENV,
    };
  }

  const userModelsDir = defaultModelsDir(appUserDataDir);
  if (platform === 'win32' && hasNonAsciiPathChars(userModelsDir)) {
    return {
      dir: windowsSafeModelsDir(env),
      source: 'windows-safe',
    };
  }

  return {
    dir: userModelsDir,
    source: 'userData',
  };
}

function isSameOrInsidePath(childPath, parentPath) {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isBlueTalkManagedModelsDir(value) {
  const parts = path.normalize(String(value || '')).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 3) return false;
  const tail = parts.slice(-3).map((part) => part.toLowerCase());
  return tail[0] === 'bluetalk' && tail[1] === 'ollama' && tail[2] === 'models';
}

module.exports = {
  BLUETALK_OLLAMA_MODELS_ENV,
  LEGACY_BLUETALK_OLLAMA_MODELS_ENV,
  cleanCustomModelsDir,
  defaultModelsDir,
  hasNonAsciiPathChars,
  isBlueTalkManagedModelsDir,
  isSameOrInsidePath,
  resolveOllamaModelsDir,
  windowsPublicModelsDir,
  windowsSafeModelsDir,
};
