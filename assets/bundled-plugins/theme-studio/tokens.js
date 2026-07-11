/**
 * Theme Studio — state sanitation, token resolution and CSS application.
 * Pure module (takes state as input); the only side effect lives in
 * `applyGlobalStyle`, which writes the shared <style> element.
 */
import {
  BUILTIN,
  PRESETS,
  ALLOWED_CUSTOM_TOKENS,
  ALL_TOKENS,
  isHex,
  accentBundle,
} from './presets.js';

export function varsToCss(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}

export function mergeDeep(base, extra) {
  const out = { ...base };
  for (const k of Object.keys(extra || {})) {
    out[k] = extra[k];
  }
  return out;
}

export function isSafeThemeValue(value) {
  const v = String(value || '').trim();
  if (isHex(v)) return true;
  const byte = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
  const alpha = '(?:0|1|0?\\.\\d+)';
  return new RegExp(`^rgba\\(${byte},${byte},${byte},${alpha}\\)$`).test(v);
}

export function sanitizeModeVars(vars) {
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

export function sanitizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    preset: PRESETS[source.preset] ? source.preset : 'default',
    dark: sanitizeModeVars(source.dark),
    light: sanitizeModeVars(source.light),
  };
}

/** Overrides that actually get written to the global stylesheet. */
export function effectiveVars(state, mode) {
  const preset = PRESETS[state.preset] || PRESETS.default;
  const base = preset[mode] || {};
  return mergeDeep(base, state[mode] || {});
}

/** Full token set for preview UI and color pickers (includes built-in defaults). */
export function resolvedVars(state, mode) {
  const merged = effectiveVars(state, mode);
  if (state.preset === 'default') {
    return mergeDeep(BUILTIN[mode], merged);
  }
  return merged;
}

export function presetSwatchColors(key) {
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

/** Pure state transform: switch preset, dropping any per-token overrides. */
export function withPreset(state, id) {
  return { preset: PRESETS[id] ? id : 'default', dark: {}, light: {} };
}

/** Pure state transform: apply a single color override (or accent bundle). */
export function withTokenOverride(state, mode, varName, value, accent) {
  if (!isHex(value)) return state;
  const patch = accent ? accentBundle(value, mode === 'dark') : { [varName]: value };
  return { ...state, [mode]: mergeDeep(state[mode] || {}, patch) };
}

export function computeThemeCss(state) {
  const dark = effectiveVars(state, 'dark');
  const light = effectiveVars(state, 'light');
  const rules = [];
  if (Object.keys(dark).length) {
    rules.push(`html[data-theme="dark"]{${varsToCss(dark)}}`);
  }
  if (Object.keys(light).length) {
    rules.push(`html[data-theme="light"]{${varsToCss(light)}}`);
  }
  return rules.join('\n');
}

/**
 * Write (or remove) the shared override stylesheet for the whole app.
 * When there is nothing to override the <style> element is removed entirely,
 * so a reset leaves no stale variables behind.
 */
export function applyGlobalStyle(state, { document, styleId }) {
  const css = computeThemeCss(state);
  let el = document.getElementById(styleId);
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = styleId;
    document.head.appendChild(el);
  }
  el.textContent = css;
}

/**
 * Apply resolved vars to the preview element, clearing every known theme token
 * first so tokens set by a previous preset never linger on the preview.
 */
export function applyPreviewVars(el, vars) {
  for (const token of ALL_TOKENS) {
    if (Object.prototype.hasOwnProperty.call(vars, token)) {
      el.style.setProperty(token, vars[token]);
    } else {
      el.style.removeProperty(token);
    }
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!ALL_TOKENS.includes(k)) el.style.setProperty(k, v);
  }
}
