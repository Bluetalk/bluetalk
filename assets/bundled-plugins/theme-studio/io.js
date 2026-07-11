/**
 * Theme Studio — persistence, export and import.
 * Wraps the plugin storage and (de)serialization behind a small store object.
 */
import { sanitizeState } from './tokens.js';

const DEFAULT_STATE = { preset: 'default', dark: {}, light: {} };

export function createThemeIo({ api, storageKey }) {
  function loadState() {
    return sanitizeState(api.storage.get(storageKey, { ...DEFAULT_STATE }));
  }

  function saveState(state) {
    api.storage.set(storageKey, state);
  }

  function clear() {
    api.storage.delete(storageKey);
  }

  /** Pretty JSON of the sanitized current state (for clipboard export). */
  function exportJson() {
    return JSON.stringify(loadState(), null, 2);
  }

  /** Parse + sanitize imported JSON. Throws on structurally invalid input. */
  function parseImportText(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') throw new Error('invalid theme file');
    return sanitizeState(data);
  }

  return { loadState, saveState, clear, exportJson, parseImportText };
}
