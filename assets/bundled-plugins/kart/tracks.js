/**
 * BlueKart — Streckenliste für Lobby und Einstellungen.
 * Die Geometrie liegt im Spielfenster (src/renderer/kart/tracks.js); hier
 * stehen nur IDs und Namen, damit das Plugin ohne 3D-Code auskommt.
 */
export const KART_TRACKS = [
  { id: 'sonnen-kurs', name: 'Sonnen-Kurs' },
  { id: 'kuestenstrasse', name: 'Küstenstraße' },
  { id: 'vulkanpass', name: 'Vulkanpass' },
  { id: 'neon-nacht', name: 'Neon-Nacht' },
  { id: 'eisgipfel', name: 'Eisgipfel' },
  { id: 'wuesten-canyon', name: 'Wüsten-Canyon' },
];

export const KART_TRACK_IDS = KART_TRACKS.map((track) => track.id);

export function trackName(id) {
  return KART_TRACKS.find((track) => track.id === id)?.name || KART_TRACKS[0].name;
}
