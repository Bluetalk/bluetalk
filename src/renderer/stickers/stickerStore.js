export const DEFAULT_PACK_ID = 'default';
const STORE_PACKS_KEY = 'stickers.packs';
const STORE_FAVORITES_KEY = 'stickers.favorites';
const STORE_RECENT_KEY = 'stickers.recent';
export const MAX_STICKER_SIZE_BYTES = 2 * 1024 * 1024;
export const MAX_STICKER_STORAGE_BYTES = 32 * 1024 * 1024;
export const MAX_STICKER_PACKS = 30;
export const MAX_STICKERS_PER_PACK = 100;
export const MAX_RECENT = 30;

const MIME_BY_SIGNATURE = [
  { mime: 'image/png', matches: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', matches: (b) => String.fromCharCode(...b.slice(0, 4)) === 'GIF8' },
  {
    mime: 'image/webp',
    matches: (b) => String.fromCharCode(...b.slice(0, 4)) === 'RIFF'
      && String.fromCharCode(...b.slice(8, 12)) === 'WEBP',
  },
];
const ALLOWED_MIMES = new Set(MIME_BY_SIGNATURE.map((entry) => entry.mime));

function cleanText(value, fallback, max = 100) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (text || fallback).slice(0, max);
}

function cleanId(value, fallback = '') {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : fallback;
}

export function base64ByteLength(value) {
  const data = String(value || '');
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return -1;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function firstBytes(base64, count = 12) {
  try {
    const binary = atob(base64.slice(0, Math.ceil(count / 3) * 4));
    return Array.from(binary.slice(0, count), (char) => char.charCodeAt(0));
  } catch {
    return [];
  }
}

export function validateStickerData({ fileData, fileType, fileSize } = {}) {
  const actualSize = base64ByteLength(fileData);
  if (actualSize < 1) throw new Error('Ungültige oder leere Sticker-Datei');
  if (actualSize > MAX_STICKER_SIZE_BYTES) throw new Error('Sticker darf maximal 2 MB groß sein');
  const bytes = firstBytes(fileData);
  const detected = MIME_BY_SIGNATURE.find((entry) => entry.matches(bytes))?.mime || '';
  if (!detected) throw new Error('Nur PNG, JPEG, GIF und WebP werden unterstützt');
  const declared = String(fileType || '').toLowerCase().split(';', 1)[0].trim();
  if (declared && (!ALLOWED_MIMES.has(declared) || declared !== detected)) {
    throw new Error('Dateityp und Dateiinhalt stimmen nicht überein');
  }
  if (Number(fileSize) > 0 && Math.abs(Number(fileSize) - actualSize) > 2) {
    throw new Error('Ungültige Sticker-Dateigröße');
  }
  return { fileData, fileType: detected, fileSize: actualSize };
}

export function readStickerFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Keine Datei'));
    if (file.size > MAX_STICKER_SIZE_BYTES) return reject(new Error('Sticker darf maximal 2 MB groß sein'));
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = reader.result;
        if (typeof result !== 'string') throw new Error('Ungültiges Leseergebnis');
        const comma = result.indexOf(',');
        if (comma < 0) throw new Error('Ungültige Datei');
        resolve({
          ...validateStickerData({
            fileData: result.slice(comma + 1),
            fileType: file.type,
            fileSize: file.size,
          }),
          fileName: cleanText(file.name, 'sticker.png', 180),
        });
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Lesen fehlgeschlagen'));
    reader.readAsDataURL(file);
  });
}

export function generateStickerId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `st-${random}`;
}

export function generatePackId() {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `pack-${random}`;
}

function defaultPacks() {
  return [{ id: DEFAULT_PACK_ID, name: 'Meine Sticker', stickers: [] }];
}

function normalizeSticker(sticker) {
  if (!sticker || typeof sticker !== 'object') return null;
  try {
    const valid = validateStickerData(sticker);
    const id = cleanId(sticker.id);
    if (!id) return null;
    return {
      id,
      name: cleanText(sticker.name, sticker.fileName || 'Sticker'),
      fileName: cleanText(sticker.fileName, 'sticker.png', 180),
      ...valid,
      createdAt: Number.isFinite(sticker.createdAt) ? sticker.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function sanitizeStickerPacks(value) {
  const source = Array.isArray(value) ? value : [];
  const packs = [];
  const seenPackIds = new Set();
  const seenStickerIds = new Set();
  let totalBytes = 0;
  for (const rawPack of source.slice(0, MAX_STICKER_PACKS)) {
    const requestedId = cleanId(rawPack?.id);
    const id = requestedId && !seenPackIds.has(requestedId) ? requestedId : generatePackId();
    seenPackIds.add(id);
    const stickers = [];
    for (const rawSticker of (Array.isArray(rawPack?.stickers) ? rawPack.stickers : []).slice(0, MAX_STICKERS_PER_PACK)) {
      const sticker = normalizeSticker(rawSticker);
      if (!sticker || seenStickerIds.has(sticker.id)) continue;
      if (totalBytes + sticker.fileSize > MAX_STICKER_STORAGE_BYTES) break;
      seenStickerIds.add(sticker.id);
      totalBytes += sticker.fileSize;
      stickers.push(sticker);
    }
    packs.push({ id, name: cleanText(rawPack?.name, 'Sticker-Pack', 60), stickers });
  }
  if (!packs.some((pack) => pack.id === DEFAULT_PACK_ID)) packs.unshift(defaultPacks()[0]);
  return packs.slice(0, MAX_STICKER_PACKS);
}

export async function loadStickerPacks() {
  if (!window.bluetalk?.store) return defaultPacks();
  return sanitizeStickerPacks(await window.bluetalk.store.get(STORE_PACKS_KEY, null));
}

export async function saveStickerPacks(packs) {
  const safe = sanitizeStickerPacks(packs);
  if (window.bluetalk?.store) await window.bluetalk.store.set(STORE_PACKS_KEY, safe);
  return safe;
}

function normalizeIdList(value, max) {
  return [...new Set((Array.isArray(value) ? value : []).map((id) => cleanId(id)).filter(Boolean))].slice(0, max);
}

export async function loadFavorites() {
  if (!window.bluetalk?.store) return [];
  return normalizeIdList(await window.bluetalk.store.get(STORE_FAVORITES_KEY, []), 500);
}

export async function saveFavorites(favorites) {
  const safe = normalizeIdList(favorites, 500);
  if (window.bluetalk?.store) await window.bluetalk.store.set(STORE_FAVORITES_KEY, safe);
  return safe;
}

export async function loadRecent() {
  if (!window.bluetalk?.store) return [];
  return normalizeIdList(await window.bluetalk.store.get(STORE_RECENT_KEY, []), MAX_RECENT);
}

export async function saveRecent(recent) {
  const safe = normalizeIdList(recent, MAX_RECENT);
  if (window.bluetalk?.store) await window.bluetalk.store.set(STORE_RECENT_KEY, safe);
  return safe;
}

export function findSticker(packs, stickerId) {
  for (const pack of packs) {
    const sticker = pack.stickers?.find((item) => item.id === stickerId);
    if (sticker) return { pack, sticker };
  }
  return null;
}

export async function toggleFavorite(stickerId) {
  const id = cleanId(stickerId);
  if (!id) return loadFavorites();
  const favorites = await loadFavorites();
  const next = favorites.includes(id) ? favorites.filter((item) => item !== id) : [id, ...favorites];
  return saveFavorites(next);
}

export async function addToRecent(stickerId) {
  const id = cleanId(stickerId);
  if (!id) return;
  const recent = await loadRecent();
  await saveRecent([id, ...recent.filter((item) => item !== id)]);
}

export async function addSticker({ packId, fileName, fileType, fileData, fileSize, name }) {
  const packs = await loadStickerPacks();
  const pack = packs.find((item) => item.id === packId) || packs[0];
  if ((pack.stickers || []).length >= MAX_STICKERS_PER_PACK) throw new Error('Dieses Pack ist voll');
  const valid = validateStickerData({ fileData, fileType, fileSize });
  if (computePacksSize(packs) + valid.fileSize > MAX_STICKER_STORAGE_BYTES) {
    throw new Error('Sticker-Speicherlimit von 32 MB erreicht');
  }
  const sticker = {
    id: generateStickerId(),
    name: cleanText(name, fileName || 'Sticker'),
    fileName: cleanText(fileName, 'sticker.png', 180),
    ...valid,
    createdAt: Date.now(),
  };
  pack.stickers = [...(pack.stickers || []), sticker];
  const saved = await saveStickerPacks(packs);
  return { packs: saved, sticker, packId: pack.id };
}

export async function deleteSticker(stickerId) {
  const packs = await loadStickerPacks();
  let removed = false;
  for (const pack of packs) {
    const before = pack.stickers?.length || 0;
    pack.stickers = (pack.stickers || []).filter((item) => item.id !== stickerId);
    if (pack.stickers.length < before) removed = true;
  }
  const saved = await saveStickerPacks(packs);
  await saveFavorites((await loadFavorites()).filter((id) => id !== stickerId));
  await saveRecent((await loadRecent()).filter((id) => id !== stickerId));
  return { packs: saved, removed };
}

export async function createPack(name) {
  const packs = await loadStickerPacks();
  if (packs.length >= MAX_STICKER_PACKS) throw new Error('Maximal 30 Sticker-Packs sind erlaubt');
  const pack = { id: generatePackId(), name: cleanText(name, 'Neues Pack', 60), stickers: [] };
  packs.push(pack);
  const saved = await saveStickerPacks(packs);
  return { packs: saved, pack };
}

export async function deletePack(packId) {
  if (packId === DEFAULT_PACK_ID) return null;
  const packs = await loadStickerPacks();
  const pack = packs.find((item) => item.id === packId);
  if (!pack) return null;
  const stickerIds = new Set((pack.stickers || []).map((item) => item.id));
  const next = await saveStickerPacks(packs.filter((item) => item.id !== packId));
  await saveFavorites((await loadFavorites()).filter((id) => !stickerIds.has(id)));
  await saveRecent((await loadRecent()).filter((id) => !stickerIds.has(id)));
  return next;
}

export function getStickerDataUrl(sticker) {
  if (!sticker?.fileData || !ALLOWED_MIMES.has(sticker.fileType)) return '';
  return `data:${sticker.fileType};base64,${sticker.fileData}`;
}

export function computePacksSize(packs) {
  let total = 0;
  for (const pack of packs || []) {
    for (const sticker of pack.stickers || []) {
      const actual = base64ByteLength(sticker.fileData);
      total += actual > 0 ? actual : 0;
    }
  }
  return total;
}

export function formatStickerSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
