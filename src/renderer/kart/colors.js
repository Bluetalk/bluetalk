/** Kart-Farben (Index = Platz in der Lobby). */
export const PLAYER_COLORS = [
  { name: 'Rot', hex: '#ef4444', accent: '#ffffff' },
  { name: 'Blau', hex: '#3b82f6', accent: '#e0f2fe' },
  { name: 'Gelb', hex: '#facc15', accent: '#1f2937' },
  { name: 'Grün', hex: '#22c55e', accent: '#ffffff' },
  { name: 'Orange', hex: '#f97316', accent: '#1f2937' },
  { name: 'Lila', hex: '#a855f7', accent: '#fdf4ff' },
  { name: 'Pink', hex: '#ec4899', accent: '#ffffff' },
  { name: 'Türkis', hex: '#14b8a6', accent: '#0f172a' },
];

export function colorOf(index) {
  return PLAYER_COLORS[((Number(index) || 0) % PLAYER_COLORS.length + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}
