/**
 * Tic-Tac-Toe — benannte, trainierbare KI-Modelle.
 *
 * Verwaltet mehrere Selbstlern-Modelle (siehe ai.js) in einem Store unter dem
 * Plugin-Storage-Key `savedTicTacToeModels`. Ein Modell ist „aktiv" — es wird
 * trainiert (Selbstspiel + Lernen aus Solo-Partien) und standardmäßig
 * eingesetzt. Das alte Ein-Modell-Format (`savedTicTacToeModel`) wird beim
 * ersten Laden migriert.
 */

import { emptyModel } from './ai.js';

const STORE_KEY = 'savedTicTacToeModels';
const LEGACY_KEY = 'savedTicTacToeModel';
const MAX_MODELS = 8;
const MAX_NAME_LEN = 32;

function newModelId() {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sanitizeModelName(name, fallback = 'Modell') {
  const trimmed = String(name || '').trim().slice(0, MAX_NAME_LEN);
  return trimmed || fallback;
}

function emptyStore() {
  return { version: 1, activeId: '', models: [] };
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const model = row.model && row.model.V ? row.model : emptyModel();
  return {
    id: typeof row.id === 'string' && row.id ? row.id : newModelId(),
    name: sanitizeModelName(row.name),
    createdAt: Number(row.createdAt) || 0,
    model,
  };
}

/** Lädt den Modell-Store; migriert das alte Ein-Modell-Format. */
export function loadModelStore(api) {
  const stored = api.storage.get(STORE_KEY, null);
  if (stored && Array.isArray(stored.models)) {
    const store = emptyStore();
    store.models = stored.models.map(normalizeRow).filter(Boolean).slice(0, MAX_MODELS);
    store.activeId = store.models.some((m) => m.id === stored.activeId)
      ? stored.activeId
      : (store.models[0]?.id || '');
    return store;
  }

  const store = emptyStore();
  const legacy = api.storage.get(LEGACY_KEY, null);
  if (legacy && legacy.V && Object.keys(legacy.V).length) {
    const row = { id: newModelId(), name: 'Modell 1', createdAt: Date.now(), model: legacy };
    store.models.push(row);
    store.activeId = row.id;
    saveModelStore(api, store);
  }
  return store;
}

export function saveModelStore(api, store) {
  api.storage.set(STORE_KEY, store);
}

export function getModelRow(store, id) {
  return store.models.find((m) => m.id === id) || null;
}

export function getActiveModelRow(store) {
  return getModelRow(store, store.activeId) || store.models[0] || null;
}

/** Legt (bis MAX_MODELS) ein neues, leeres Modell an und aktiviert es. */
export function createModel(store, name) {
  if (store.models.length >= MAX_MODELS) return null;
  const row = {
    id: newModelId(),
    name: sanitizeModelName(name, `Modell ${store.models.length + 1}`),
    createdAt: Date.now(),
    model: emptyModel(),
  };
  store.models.push(row);
  store.activeId = row.id;
  return row;
}

export function renameModel(store, id, name) {
  const row = getModelRow(store, id);
  if (!row) return false;
  row.name = sanitizeModelName(name, row.name);
  return true;
}

export function deleteModel(store, id) {
  const idx = store.models.findIndex((m) => m.id === id);
  if (idx < 0) return false;
  store.models.splice(idx, 1);
  if (store.activeId === id) store.activeId = store.models[0]?.id || '';
  return true;
}

export function selectModel(store, id) {
  if (!getModelRow(store, id)) return false;
  store.activeId = id;
  return true;
}

/** Kompakte, UI-taugliche Übersicht aller Modelle (ohne die V-Tabellen). */
export function summarizeModels(store) {
  return {
    activeId: getActiveModelRow(store)?.id || '',
    models: store.models.map((row) => ({
      id: row.id,
      name: row.name,
      games: row.model?.games || 0,
      states: row.model?.V ? Object.keys(row.model.V).length : 0,
      wins: row.model?.wins || 0,
      losses: row.model?.losses || 0,
      draws: row.model?.draws || 0,
      available: Boolean(row.model?.V && Object.keys(row.model.V).length),
      createdAt: row.createdAt,
    })),
  };
}
