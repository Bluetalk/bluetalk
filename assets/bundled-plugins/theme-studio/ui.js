/**
 * Theme Studio — overrides BlueTalk design tokens via html[data-theme] rules.
 */
(function themeStudioUi() {
  const api = BlueTalkPlugin;
  const STYLE_ID = 'bt-theme-studio-overrides';
  const STORAGE_KEY = 'themeOverrides';

  function hexToRgb(hex) {
    const h = String(hex).replace('#', '');
    if (h.length !== 6) return null;
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(r, g, b) {
    const x = (n) => Math.max(0, Math.min(255, Math.round(n)));
    return `#${((1 << 24) + (x(r) << 16) + (x(g) << 8) + x(b)).toString(16).slice(1)}`;
  }

  function relLum(rgb) {
    if (!rgb) return 0;
    const srgb = [rgb.r, rgb.g, rgb.b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
  }

  function isHex(v) {
    return /^#[0-9a-fA-F]{6}$/.test(String(v || '').trim());
  }

  /** Derive accent-related tokens from a single accent color. */
  function accentBundle(accentHex, isDark) {
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

  const BUILTIN = {
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

  const PRESETS = {
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

  const CUSTOM_TOKENS = [
    { key: '--accent', label: 'Accent', accent: true },
    { key: '--bg-0', label: 'Background' },
    { key: '--fg-0', label: 'Text' },
    { key: '--border', label: 'Border' },
  ];

  const GENERATED_ACCENT_TOKENS = ['--accent-hover', '--accent-fg', '--accent-soft', '--accent-2'];
  const ALLOWED_CUSTOM_TOKENS = new Set([
    ...CUSTOM_TOKENS.map((token) => token.key),
    ...GENERATED_ACCENT_TOKENS,
  ]);

  function isSafeThemeValue(value) {
    const v = String(value || '').trim();
    if (isHex(v)) return true;
    const byte = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
    const alpha = '(?:0|1|0?\\.\\d+)';
    return new RegExp(`^rgba\\(${byte},${byte},${byte},${alpha}\\)$`).test(v);
  }

  function sanitizeModeVars(vars) {
    const safe = {};
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return safe;
    for (const [key, value] of Object.entries(vars)) {
      if (!ALLOWED_CUSTOM_TOKENS.has(key)) continue;
      const v = String(value || '').trim();
      if (!isSafeThemeValue(v)) continue;
      safe[key] = v;
    }
    return safe;
  }

  function sanitizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      preset: PRESETS[source.preset] ? source.preset : 'default',
      dark: sanitizeModeVars(source.dark),
      light: sanitizeModeVars(source.light),
    };
  }

  function loadState() {
    return sanitizeState(api.storage.get(STORAGE_KEY, {
      preset: 'default',
      dark: {},
      light: {},
    }));
  }

  function saveState(state) {
    api.storage.set(STORAGE_KEY, state);
  }

  function varsToCss(obj) {
    return Object.entries(obj)
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
  }

  function mergeDeep(base, extra) {
    const out = { ...base };
    for (const k of Object.keys(extra || {})) {
      out[k] = extra[k];
    }
    return out;
  }

  function effectiveVars(mode) {
    const st = loadState();
    const preset = PRESETS[st.preset] || PRESETS.default;
    const base = preset[mode] || {};
    return mergeDeep(base, st[mode] || {});
  }

  /** Full token set for preview UI and color pickers (includes built-in defaults). */
  function resolvedVars(mode) {
    const merged = effectiveVars(mode);
    const st = loadState();
    if (st.preset === 'default') {
      return mergeDeep(BUILTIN[mode], merged);
    }
    return merged;
  }

  function presetSwatchColors(key) {
    const preset = PRESETS[key] || PRESETS.default;
    const dark = mergeDeep(BUILTIN.dark, preset.dark);
    const light = mergeDeep(BUILTIN.light, preset.light);
    return {
      darkBg: dark['--bg-0'],
      darkAccent: dark['--accent'],
      lightBg: light['--bg-0'],
      lightAccent: light['--accent'],
    };
  }

  function syncStyle() {
    const st = loadState();
    let el = document.getElementById(STYLE_ID);
    const dark = effectiveVars('dark');
    const light = effectiveVars('light');
    const rules = [];
    if (Object.keys(dark).length) {
      rules.push(`html[data-theme="dark"]{${varsToCss(dark)}}`);
    }
    if (Object.keys(light).length) {
      rules.push(`html[data-theme="light"]{${varsToCss(light)}}`);
    }
    if (!rules.length) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = rules.join('\n');
  }

  function setPreset(id) {
    const st = loadState();
    st.preset = PRESETS[id] ? id : 'default';
    st.dark = {};
    st.light = {};
    saveState(st);
    syncStyle();
  }

  function setTokenOverride(mode, varName, value, { accent = false } = {}) {
    if (!isHex(value)) return;
    const st = loadState();
    const patch = accent ? accentBundle(value, mode === 'dark') : { [varName]: value };
    st[mode] = mergeDeep(st[mode] || {}, patch);
    saveState(st);
    syncStyle();
  }

  function resetAll() {
    api.storage.delete(STORAGE_KEY);
    syncStyle();
  }

  function applyVarsToEl(el, vars) {
    for (const [k, v] of Object.entries(vars)) {
      el.style.setProperty(k, v);
    }
  }

  syncStyle();

  api.onDeactivate(() => {
    document.getElementById(STYLE_ID)?.remove();
  });

  api.ui.registerTab({
    id: 'studio',
    label: 'Themes',
    icon: 'Palette',
    order: 15,
    render(container) {
      let previewMode = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';

      container.innerHTML = `
        <div class="ts-wrap">
          <header class="ts-head">
            <h2>Theme Studio</h2>
            <p>Pick a preset, fine-tune colors per mode, and preview changes live. Overrides apply across the whole app.</p>
          </header>

          <section class="ts-section">
            <div class="ts-section-head">
              <h3>Live preview</h3>
              <div class="ts-preview-modes" data-preview-modes>
                <button type="button" class="ts-mode-btn" data-preview-mode="light">Light</button>
                <button type="button" class="ts-mode-btn" data-preview-mode="dark">Dark</button>
              </div>
            </div>
            <div class="ts-preview" data-preview>
              <div class="ts-preview-app">
                <aside class="ts-preview-side">
                  <div class="ts-preview-nav is-active"></div>
                  <div class="ts-preview-nav"></div>
                  <div class="ts-preview-nav"></div>
                </aside>
                <div class="ts-preview-main">
                  <div class="ts-preview-bar">
                    <span class="ts-preview-title">Chats</span>
                    <span class="ts-preview-pill">Online</span>
                  </div>
                  <div class="ts-preview-chat">
                    <div class="ts-preview-msg ts-preview-msg--them">
                      <span>Hey, are we still on for tonight?</span>
                    </div>
                    <div class="ts-preview-msg ts-preview-msg--me">
                      <span>Absolutely — see you at 8.</span>
                    </div>
                  </div>
                  <div class="ts-preview-footer">
                    <div class="ts-preview-input">Type a message…</div>
                    <button type="button" class="ts-preview-send">Send</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section class="ts-section">
            <h3>Presets</h3>
            <div class="ts-preset-grid" data-presets></div>
          </section>

          <section class="ts-section ts-split">
            <div class="ts-mode" data-mode-panel="dark">
              <h3>Dark mode</h3>
              <div class="ts-fields" data-fields="dark"></div>
            </div>
            <div class="ts-mode" data-mode-panel="light">
              <h3>Light mode</h3>
              <div class="ts-fields" data-fields="light"></div>
            </div>
          </section>

          <section class="ts-section ts-actions">
            <div class="ts-action-row">
              <button type="button" class="ts-btn" data-action="export">Export</button>
              <button type="button" class="ts-btn" data-action="import">Import</button>
              <input type="file" accept="application/json,.json" hidden data-import-file />
            </div>
            <button type="button" class="ts-btn ts-btn-danger" data-action="reset">Reset to app default</button>
            <span class="ts-hint">Appearance mode (light/dark) is still controlled in Settings. Export copies JSON to your clipboard.</span>
          </section>
        </div>
        <style>
          .ts-wrap {
            max-width: 760px;
            margin: 0 auto;
            padding: 20px 24px 48px;
            color: var(--fg-0);
          }
          .ts-head h2 {
            margin: 0 0 8px;
            font-size: 20px;
            letter-spacing: -0.02em;
          }
          .ts-head p {
            margin: 0;
            color: var(--fg-2);
            font-size: 13px;
            line-height: 1.5;
            max-width: 600px;
          }
          .ts-section {
            margin-top: 28px;
          }
          .ts-section-head {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 12px;
          }
          .ts-section h3 {
            margin: 0 0 12px;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            color: var(--fg-3);
            font-weight: 600;
          }
          .ts-section-head h3 { margin-bottom: 0; }
          .ts-preview-modes {
            display: flex;
            gap: 4px;
            padding: 3px;
            border-radius: 8px;
            background: var(--bg-2);
            border: 1px solid var(--border);
          }
          .ts-mode-btn {
            border: 0;
            background: transparent;
            color: var(--fg-2);
            font-size: 12px;
            font-weight: 500;
            padding: 5px 10px;
            border-radius: 6px;
            cursor: pointer;
          }
          .ts-mode-btn.is-active {
            background: var(--bg-0);
            color: var(--fg-0);
            box-shadow: var(--shadow-sm);
          }
          .ts-preview {
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            background: var(--bg-1);
          }
          .ts-preview-app {
            display: flex;
            min-height: 200px;
          }
          .ts-preview-side {
            width: 52px;
            padding: 12px 8px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            background: var(--bg-1);
            border-right: 1px solid var(--border);
          }
          .ts-preview-nav {
            height: 28px;
            border-radius: 8px;
            background: var(--bg-2);
          }
          .ts-preview-nav.is-active {
            background: var(--accent-soft);
            box-shadow: inset 2px 0 0 var(--accent);
          }
          .ts-preview-main {
            flex: 1;
            display: flex;
            flex-direction: column;
            background: var(--bg-0);
            min-width: 0;
          }
          .ts-preview-bar {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px 14px;
            border-bottom: 1px solid var(--border);
            background: var(--bg-1);
          }
          .ts-preview-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--fg-0);
          }
          .ts-preview-pill {
            font-size: 11px;
            padding: 2px 8px;
            border-radius: 999px;
            background: var(--accent-soft);
            color: var(--fg-1);
          }
          .ts-preview-chat {
            flex: 1;
            padding: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .ts-preview-msg {
            max-width: 78%;
            font-size: 12px;
            line-height: 1.45;
            padding: 8px 11px;
            border-radius: 12px;
            border: 1px solid var(--border);
            color: var(--fg-0);
            background: var(--bg-1);
          }
          .ts-preview-msg--me {
            align-self: flex-end;
            background: var(--accent);
            color: var(--accent-fg);
            border-color: transparent;
          }
          .ts-preview-footer {
            display: flex;
            gap: 8px;
            padding: 10px 12px;
            border-top: 1px solid var(--border);
            background: var(--bg-1);
          }
          .ts-preview-input {
            flex: 1;
            font-size: 12px;
            color: var(--fg-3);
            padding: 8px 10px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--bg-input, var(--bg-0));
          }
          .ts-preview-send {
            border: 0;
            border-radius: 8px;
            padding: 8px 14px;
            font-size: 12px;
            font-weight: 600;
            cursor: default;
            background: var(--accent);
            color: var(--accent-fg);
          }
          .ts-preset-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
            gap: 10px;
          }
          .ts-preset {
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 10px 12px 12px;
            background: var(--bg-1);
            color: var(--fg-0);
            cursor: pointer;
            text-align: left;
            font-size: 13px;
            font-weight: 500;
            transition: background 0.15s, border-color 0.15s;
          }
          .ts-preset:hover {
            background: var(--bg-hover);
            border-color: var(--border-strong);
          }
          .ts-preset.is-active {
            border-color: var(--accent);
            box-shadow: 0 0 0 1px var(--accent-soft);
          }
          .ts-preset-swatches {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            margin-bottom: 10px;
          }
          .ts-preset-swatch {
            height: 28px;
            border-radius: 6px;
            border: 1px solid rgba(0,0,0,0.08);
            position: relative;
            overflow: hidden;
          }
          .ts-preset-swatch::after {
            content: none;
          }
          .ts-preset-swatch span {
            position: absolute;
            right: 6px;
            top: 6px;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            border: 1px solid rgba(0,0,0,0.12);
          }
          .ts-preset small {
            display: block;
            margin-top: 2px;
            font-weight: 400;
            font-size: 11px;
            color: var(--fg-3);
          }
          .ts-split {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
          }
          @media (max-width: 640px) {
            .ts-split { grid-template-columns: 1fr; }
          }
          .ts-mode {
            border: 1px solid var(--border);
            border-radius: 10px;
            padding: 16px;
            background: var(--bg-1);
          }
          .ts-mode h3 { margin-bottom: 14px; }
          .ts-field {
            display: grid;
            grid-template-columns: auto 1fr;
            gap: 10px 12px;
            align-items: center;
            margin-bottom: 12px;
          }
          .ts-field:last-child { margin-bottom: 0; }
          .ts-field label {
            font-size: 12px;
            color: var(--fg-2);
            grid-column: 1 / -1;
          }
          .ts-field input[type="color"] {
            width: 40px;
            height: 32px;
            padding: 0;
            border: 1px solid var(--border);
            border-radius: 8px;
            background: var(--bg-0);
            cursor: pointer;
          }
          .ts-field input[type="text"] {
            font-family: ui-monospace, monospace;
            font-size: 12px;
            padding: 6px 8px;
            border-radius: 8px;
            border: 1px solid var(--border);
            background: var(--bg-0);
            color: var(--fg-0);
            width: 100%;
          }
          .ts-actions {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 10px;
          }
          .ts-action-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
          }
          .ts-btn {
            border-radius: 8px;
            padding: 8px 14px;
            font-size: 13px;
            font-weight: 500;
            cursor: pointer;
            border: 1px solid var(--border);
            background: var(--bg-2);
            color: var(--fg-0);
          }
          .ts-btn:hover {
            background: var(--bg-hover);
          }
          .ts-btn-danger {
            border-color: color-mix(in srgb, var(--red) 35%, var(--border));
            color: var(--red);
            background: var(--bg-1);
          }
          .ts-btn-danger:hover {
            background: var(--red-soft);
          }
          .ts-hint {
            font-size: 12px;
            color: var(--fg-3);
            line-height: 1.45;
            max-width: 520px;
          }
        </style>
      `;

      const presetLabels = {
        default: { title: 'Default', desc: 'Built-in BlueTalk' },
        ocean: { title: 'Ocean', desc: 'Cool blues' },
        ember: { title: 'Ember', desc: 'Warm orange' },
        amethyst: { title: 'Amethyst', desc: 'Soft purple' },
        forest: { title: 'Forest', desc: 'Mint & green' },
        midnight: { title: 'Midnight', desc: 'Indigo night' },
        rose: { title: 'Rose', desc: 'Pink blush' },
      };

      const previewEl = container.querySelector('[data-preview]');
      const previewModeBtns = container.querySelectorAll('[data-preview-mode]');

      function refreshPreview() {
        const vars = resolvedVars(previewMode);
        applyVarsToEl(previewEl, vars);
        previewModeBtns.forEach((btn) => {
          btn.classList.toggle('is-active', btn.dataset.previewMode === previewMode);
        });
      }

      previewModeBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          previewMode = btn.dataset.previewMode;
          refreshPreview();
        });
      });

      const grid = container.querySelector('[data-presets]');
      for (const key of Object.keys(PRESETS)) {
        const meta = presetLabels[key] || { title: key, desc: '' };
        const sw = presetSwatchColors(key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ts-preset${loadState().preset === key ? ' is-active' : ''}`;
        btn.dataset.preset = key;
        btn.innerHTML = `
          <div class="ts-preset-swatches">
            <div class="ts-preset-swatch" style="background:${sw.lightBg}">
              <span style="background:${sw.lightAccent}"></span>
            </div>
            <div class="ts-preset-swatch" style="background:${sw.darkBg}">
              <span style="background:${sw.darkAccent}"></span>
            </div>
          </div>
          ${meta.title}<small>${meta.desc}</small>
        `;
        grid.appendChild(btn);
      }

      function pickInitialVar(mode, varName, fallback) {
        const v = resolvedVars(mode)[varName];
        if (isHex(v)) return v;
        return fallback;
      }

      function refreshFields() {
        container.querySelectorAll('[data-fields]').forEach((panel) => {
          const mode = panel.dataset.fields;
          const isDark = mode === 'dark';
          panel.innerHTML = CUSTOM_TOKENS.map((token) => {
            const fallback = BUILTIN[mode][token.key];
            const value = pickInitialVar(mode, token.key, fallback);
            const id = `ts-${mode}-${token.key.replace('--', '')}`;
            return `
              <div class="ts-field" data-token="${token.key}" data-accent="${token.accent ? '1' : '0'}">
                <label for="${id}">${token.label}</label>
                <input type="color" id="${id}" data-mode="${mode}" data-var="${token.key}" value="${value}" />
                <input type="text" data-mode="${mode}" data-var="${token.key}" data-hex value="${value}" maxlength="7" />
              </div>
            `;
          }).join('');
        });

        container.querySelectorAll('[data-hex]').forEach((hexInput) => {
          const colorInput = panelFor(hexInput);
          hexInput.addEventListener('input', () => {
            let v = hexInput.value.trim();
            if (!v.startsWith('#')) v = `#${v}`;
            if (isHex(v)) {
              colorInput.value = v;
              applyToken(
                hexInput.dataset.mode,
                hexInput.dataset.var,
                v,
                hexInput.closest('[data-token]')?.dataset.accent === '1',
              );
            }
          });
          hexInput.addEventListener('blur', () => {
            const v = pickInitialVar(hexInput.dataset.mode, hexInput.dataset.var, BUILTIN[hexInput.dataset.mode][hexInput.dataset.var]);
            hexInput.value = v;
          });
        });

        container.querySelectorAll('input[type="color"][data-var]').forEach((colorInput) => {
          colorInput.addEventListener('input', () => {
            const hexInput = hexFor(colorInput);
            hexInput.value = colorInput.value;
            applyToken(
              colorInput.dataset.mode,
              colorInput.dataset.var,
              colorInput.value,
              colorInput.closest('[data-token]')?.dataset.accent === '1',
            );
          });
        });
      }

      function panelFor(el) {
        return el.parentElement.querySelector('input[type="color"]');
      }

      function hexFor(el) {
        return el.parentElement.querySelector('[data-hex]');
      }

      function applyToken(mode, varName, value, accent) {
        setTokenOverride(mode, varName, value, { accent });
        refreshPreview();
      }

      function refreshPresetActive() {
        const cur = loadState().preset;
        grid.querySelectorAll('.ts-preset').forEach((b) => {
          b.classList.toggle('is-active', b.dataset.preset === cur);
        });
      }

      function refreshAll() {
        refreshPresetActive();
        refreshFields();
        refreshPreview();
      }

      grid.addEventListener('click', (e) => {
        const btn = e.target.closest('.ts-preset');
        if (!btn) return;
        setPreset(btn.dataset.preset);
        refreshAll();
        api.notify.toast?.({ variant: 'success', title: 'Preset applied' });
      });

      container.querySelector('[data-action="reset"]').addEventListener('click', () => {
        resetAll();
        refreshAll();
        api.notify.toast?.({ variant: 'success', title: 'Theme reset' });
      });

      container.querySelector('[data-action="export"]').addEventListener('click', async () => {
        const json = JSON.stringify(loadState(), null, 2);
        try {
          await navigator.clipboard.writeText(json);
          api.notify.toast?.({ variant: 'success', title: 'Theme copied to clipboard' });
        } catch {
          api.notify.toast?.({ variant: 'error', title: 'Could not copy — check clipboard permissions' });
        }
      });

      const importFile = container.querySelector('[data-import-file]');
      container.querySelector('[data-action="import"]').addEventListener('click', () => {
        importFile.click();
      });
      importFile.addEventListener('change', async () => {
        const file = importFile.files?.[0];
        importFile.value = '';
        if (!file) return;
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data || typeof data !== 'object') throw new Error('invalid');
          const next = sanitizeState(data);
          saveState(next);
          syncStyle();
          refreshAll();
          api.notify.toast?.({ variant: 'success', title: 'Theme imported' });
        } catch {
          api.notify.toast?.({ variant: 'error', title: 'Invalid theme file' });
        }
      });

      refreshAll();

      return undefined;
    },
  });

  api.log.info('Theme Studio UI registered');
})();
