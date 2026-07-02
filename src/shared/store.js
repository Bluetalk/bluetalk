const fs = require('fs');
const path = require('path');

// Electron is only needed to resolve the default userData path. Load it
// lazily so the store can run in plain Node (tests) with an explicit baseDir.
function getDefaultUserDataPath() {
  const { app } = require('electron');
  return app.getPath('userData');
}

const FORBIDDEN_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

function splitSafeKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const parts = key.split('.');
  if (parts.some((part) => !part || FORBIDDEN_PATH_PARTS.has(part))) return null;
  return parts;
}

class Store {
  constructor(opts) {
    const userDataPath = opts.baseDir || getDefaultUserDataPath();
    this.path = path.join(userDataPath, opts.configName + '.json');
    this.data = this._load();
    this._dirty = false;
    this._writePromise = null;
    // Writes serialize the whole store — a short coalescing window turns
    // bursts (e.g. many incoming messages) into a single disk write.
    this._debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 200;
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._writePromise) return;

    this._writePromise = (async () => {
      if (this._debounceMs > 0) await new Promise((r) => setTimeout(r, this._debounceMs));
      await this._flushLoop();
    })().finally(() => {
      this._writePromise = null;
      if (this._dirty) {
        this._scheduleSave();
      }
    });
  }

  async _flushLoop() {
    while (this._dirty) {
      this._dirty = false;

      try {
        await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
        const tempPath = this.path + '.tmp';
        await fs.promises.writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf-8');
        await fs.promises.rename(tempPath, this.path);
      } catch (e) {
        console.error('Store save error:', e);
        // Mark dirty again so we retry on next schedule
        this._dirty = true;
        // Brief backoff to avoid tight error loops
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  get(key, defaultValue) {
    const keys = splitSafeKey(key);
    if (!keys) return defaultValue;
    let result = this.data;
    for (const k of keys) {
      if (
        result === undefined
        || result === null
        || typeof result !== 'object'
        || !Object.prototype.hasOwnProperty.call(result, k)
      ) return defaultValue;
      result = result[k];
    }
    return result !== undefined ? result : defaultValue;
  }

  set(key, value) {
    const keys = splitSafeKey(key);
    if (!keys) throw new Error('Invalid store key');
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (
        !Object.prototype.hasOwnProperty.call(obj, keys[i])
        || obj[keys[i]] === null
        || typeof obj[keys[i]] !== 'object'
        || Array.isArray(obj[keys[i]])
      ) {
        obj[keys[i]] = {};
      }
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    this._scheduleSave();
  }

  delete(key) {
    const keys = splitSafeKey(key);
    if (!keys) return;
    let obj = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj || typeof obj !== 'object' || !Object.prototype.hasOwnProperty.call(obj, keys[i])) return;
      obj = obj[keys[i]];
    }
    delete obj[keys[keys.length - 1]];
    this._scheduleSave();
  }

  getAll() {
    return { ...this.data };
  }

  async waitForWrites() {
    if (this._writePromise) {
      await this._writePromise;
    }
  }

  /** Replace persisted data with an empty object (used for “delete all data”). */
  async clearAll() {
    await this.waitForWrites();
    this.data = {};
    this._dirty = false;
    try {
      await fs.promises.mkdir(path.dirname(this.path), { recursive: true });
      const tempPath = this.path + '.tmp';
      await fs.promises.writeFile(tempPath, '{}', 'utf-8');
      await fs.promises.rename(tempPath, this.path);
    } catch (e) {
      console.error('Store clear error:', e);
      throw e;
    }
  }
}

module.exports = Store;
