/**
 * Theme Studio — color math, built-in tokens, presets and token metadata.
 * Pure module: no DOM, no plugin API. Safe to `node --check`.
 */

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  if (h.length !== 6) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const x = (n) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${((1 << 24) + (x(r) << 16) + (x(g) << 8) + x(b)).toString(16).slice(1)}`;
}

export function relLum(rgb) {
  if (!rgb) return 0;
  const srgb = [rgb.r, rgb.g, rgb.b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

export function isHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
}

/** Derive accent-related tokens from a single accent color. */
export function accentBundle(accentHex, isDark) {
  const rgb = hexToRgb(accentHex);
  if (!rgb) return {};
  const hover = rgbToHex(
    rgb.r + (isDark ? 28 : -22),
    rgb.g + (isDark ? 28 : -22),
    rgb.b + (isDark ? 28 : -22),
  );
  const lum = relLum(rgb);
  const accentFg = lum > 0.55 ? '#0a0a0a' : '#fafafa';
  const alpha = isDark ? 0.14 : 0.1;
  const soft = `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  const sec = rgbToHex(
    rgb.r * 0.65 + (isDark ? 99 : 180) * 0.35,
    rgb.g * 0.65 + (isDark ? 102 : 140) * 0.35,
    rgb.b * 0.65 + (isDark ? 242 : 255) * 0.35,
  );
  return {
    '--accent': accentHex,
    '--accent-hover': hover,
    '--accent-fg': accentFg,
    '--accent-soft': soft,
    '--accent-2': sec,
  };
}

export const BUILTIN = {
  dark: {
    '--bg-0': '#0a0a0a',
    '--bg-1': '#111111',
    '--bg-input': '#111111',
    '--fg-0': '#ededed',
    '--border': '#262626',
    '--accent': '#ffffff',
  },
  light: {
    '--bg-0': '#ffffff',
    '--bg-1': '#fafafa',
    '--bg-input': '#ffffff',
    '--fg-0': '#171717',
    '--border': '#e5e5e5',
    '--accent': '#000000',
  },
};

export const PRESETS = {
  default: { dark: {}, light: {} },
  ocean: {
    dark: {
      '--bg-0': '#0b1220',
      '--bg-1': '#111b2d',
      '--bg-2': '#1a2942',
      '--bg-3': '#243552',
      '--bg-hover': '#152238',
      '--bg-active': '#1e2f4a',
      '--bg-input': '#111b2d',
      '--fg-0': '#e8eef7',
      '--fg-1': '#a8b8d0',
      '--fg-2': '#7a8fb0',
      '--fg-3': '#5a6d8a',
      '--border': '#233348',
      '--border-strong': '#334866',
      ...accentBundle('#3ba4f0', true),
    },
    light: {
      '--bg-0': '#f8fafc',
      '--bg-1': '#f1f5f9',
      '--bg-2': '#e2e8f0',
      '--bg-3': '#cbd5e1',
      '--bg-hover': '#e8edf4',
      '--bg-active': '#dce3ee',
      '--bg-input': '#ffffff',
      '--fg-0': '#0f172a',
      '--fg-1': '#334155',
      '--fg-2': '#64748b',
      '--fg-3': '#94a3b8',
      '--border': '#cbd5e1',
      '--border-strong': '#94a3b8',
      ...accentBundle('#0284c7', false),
    },
  },
  ember: {
    dark: {
      '--bg-0': '#140c0a',
      '--bg-1': '#1c1210',
      '--bg-2': '#281a14',
      '--bg-3': '#352118',
      '--bg-hover': '#221510',
      '--bg-active': '#301c14',
      '--bg-input': '#1c1210',
      '--fg-0': '#f8ece6',
      '--fg-1': '#d4b8a8',
      '--fg-2': '#a88472',
      '--fg-3': '#7d5f50',
      '--border': '#3d2820',
      '--border-strong': '#5c3d30',
      ...accentBundle('#fb923c', true),
    },
    light: {
      '--bg-0': '#fffbf7',
      '--bg-1': '#fff1e6',
      '--bg-2': '#ffe4cc',
      '--bg-3': '#ffd0a8',
      '--bg-hover': '#ffeedd',
      '--bg-active': '#ffe2c4',
      '--bg-input': '#ffffff',
      '--fg-0': '#292524',
      '--fg-1': '#57534e',
      '--fg-2': '#78716c',
      '--fg-3': '#a8a29e',
      '--border': '#e7d5c4',
      '--border-strong': '#cbb89f',
      ...accentBundle('#ea580c', false),
    },
  },
  amethyst: {
    dark: {
      '--bg-0': '#0f0a14',
      '--bg-1': '#16101f',
      '--bg-2': '#20172c',
      '--bg-3': '#2c1f3d',
      '--bg-hover': '#1a1224',
      '--bg-active': '#261a32',
      '--bg-input': '#16101f',
      '--fg-0': '#f3e8ff',
      '--fg-1': '#c4b5d8',
      '--fg-2': '#9480b8',
      '--fg-3': '#6b5a8f',
      '--border': '#342447',
      '--border-strong': '#4a3270',
      ...accentBundle('#c084fc', true),
    },
    light: {
      '--bg-0': '#faf5ff',
      '--bg-1': '#f3e8ff',
      '--bg-2': '#e9d5ff',
      '--bg-3': '#d8b4fe',
      '--bg-hover': '#ede3fa',
      '--bg-active': '#e4d4f7',
      '--bg-input': '#ffffff',
      '--fg-0': '#1e1b2e',
      '--fg-1': '#4c4768',
      '--fg-2': '#6f6888',
      '--fg-3': '#9088a8',
      '--border': '#ddd0f0',
      '--border-strong': '#b9a8d9',
      ...accentBundle('#7c3aed', false),
    },
  },
  forest: {
    dark: {
      '--bg-0': '#0a120e',
      '--bg-1': '#0f1a14',
      '--bg-2': '#15241c',
      '--bg-3': '#1c3226',
      '--bg-hover': '#122018',
      '--bg-active': '#1a2c22',
      '--bg-input': '#0f1a14',
      '--fg-0': '#e8f5ef',
      '--fg-1': '#a8cbb8',
      '--fg-2': '#6fa386',
      '--fg-3': '#4d7a62',
      '--border': '#1f3d2e',
      '--border-strong': '#2d5a44',
      ...accentBundle('#34d399', true),
    },
    light: {
      '--bg-0': '#f4fdf7',
      '--bg-1': '#e8faf0',
      '--bg-2': '#d1fae5',
      '--bg-3': '#a7f3d0',
      '--bg-hover': '#e2f6eb',
      '--bg-active': '#cfeee0',
      '--bg-input': '#ffffff',
      '--fg-0': '#0f2918',
      '--fg-1': '#365745',
      '--fg-2': '#4f7660',
      '--fg-3': '#6d9078',
      '--border': '#c5e5d4',
      '--border-strong': '#8fbf9f',
      ...accentBundle('#059669', false),
    },
  },
  midnight: {
    dark: {
      '--bg-0': '#050508',
      '--bg-1': '#0c0c12',
      '--bg-2': '#14141c',
      '--bg-3': '#1c1c26',
      '--bg-hover': '#101018',
      '--bg-active': '#181822',
      '--bg-input': '#0c0c12',
      '--fg-0': '#f4f4f5',
      '--fg-1': '#c4c4cc',
      '--fg-2': '#8b8b96',
      '--fg-3': '#5c5c66',
      '--border': '#22222e',
      '--border-strong': '#343444',
      ...accentBundle('#818cf8', true),
    },
    light: {
      '--bg-0': '#fafafa',
      '--bg-1': '#f4f4f5',
      '--bg-2': '#e4e4e7',
      '--bg-3': '#d4d4d8',
      '--bg-hover': '#ececee',
      '--bg-active': '#e2e2e5',
      '--bg-input': '#ffffff',
      '--fg-0': '#09090b',
      '--fg-1': '#3f3f46',
      '--fg-2': '#71717a',
      '--fg-3': '#a1a1aa',
      '--border': '#e4e4e7',
      '--border-strong': '#d4d4d8',
      ...accentBundle('#4f46e5', false),
    },
  },
  rose: {
    dark: {
      '--bg-0': '#120a10',
      '--bg-1': '#1a1018',
      '--bg-2': '#241622',
      '--bg-3': '#301c2c',
      '--bg-hover': '#1e121c',
      '--bg-active': '#2a1826',
      '--bg-input': '#1a1018',
      '--fg-0': '#fce7f3',
      '--fg-1': '#d8b4c8',
      '--fg-2': '#a87898',
      '--fg-3': '#7a5670',
      '--border': '#3a2434',
      '--border-strong': '#54344a',
      ...accentBundle('#f472b6', true),
    },
    light: {
      '--bg-0': '#fff1f2',
      '--bg-1': '#ffe4e6',
      '--bg-2': '#fecdd3',
      '--bg-3': '#fda4af',
      '--bg-hover': '#ffe8ea',
      '--bg-active': '#ffd6db',
      '--bg-input': '#ffffff',
      '--fg-0': '#1f1318',
      '--fg-1': '#5c4450',
      '--fg-2': '#7a6068',
      '--fg-3': '#9a8088',
      '--border': '#f5c4cc',
      '--border-strong': '#e8a0ac',
      ...accentBundle('#e11d48', false),
    },
  },
};

export const CUSTOM_TOKENS = [
  { key: '--accent', label: 'Accent', accent: true },
  { key: '--bg-0', label: 'Background' },
  { key: '--fg-0', label: 'Text' },
  { key: '--border', label: 'Border' },
];

export const GENERATED_ACCENT_TOKENS = ['--accent-hover', '--accent-fg', '--accent-soft', '--accent-2'];

export const ALLOWED_CUSTOM_TOKENS = new Set([
  ...CUSTOM_TOKENS.map((token) => token.key),
  ...GENERATED_ACCENT_TOKENS,
]);

export const PRESET_LABELS = {
  default: { title: 'Default', desc: 'Built-in BlueTalk' },
  ocean: { title: 'Ocean', desc: 'Cool blues' },
  ember: { title: 'Ember', desc: 'Warm orange' },
  amethyst: { title: 'Amethyst', desc: 'Soft purple' },
  forest: { title: 'Forest', desc: 'Mint & green' },
  midnight: { title: 'Midnight', desc: 'Indigo night' },
  rose: { title: 'Rose', desc: 'Pink blush' },
};

/**
 * Every CSS custom property any preset or built-in can set. Used to fully
 * clear stale inline vars from the live-preview element so switching presets
 * or resetting never leaves the preview "stuck" on an old palette.
 */
export const ALL_TOKENS = (() => {
  const set = new Set(GENERATED_ACCENT_TOKENS);
  for (const mode of ['dark', 'light']) {
    for (const key of Object.keys(BUILTIN[mode])) set.add(key);
    for (const preset of Object.values(PRESETS)) {
      for (const key of Object.keys(preset[mode] || {})) set.add(key);
    }
  }
  return [...set];
})();
