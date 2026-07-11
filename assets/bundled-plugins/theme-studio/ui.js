/**
 * Theme Studio — entry module.
 *
 * Overrides BlueTalk design tokens via html[data-theme] rules. The work is
 * split across sibling modules:
 *   - presets.js  color math, built-in tokens, presets, token metadata
 *   - tokens.js   state sanitation, token resolution, CSS application
 *   - io.js       persistence, export/import
 *   - view.js     static markup + styles for the Themes tab
 */
import {
  BUILTIN,
  CUSTOM_TOKENS,
  PRESETS,
  PRESET_LABELS,
  isHex,
} from './presets.js';
import {
  resolvedVars,
  presetSwatchColors,
  withPreset,
  withTokenOverride,
  applyGlobalStyle,
  applyPreviewVars,
} from './tokens.js';
import { createThemeIo } from './io.js';
import { tabMarkup } from './view.js';

export default function activateThemeStudioPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;
  const STYLE_ID = 'bt-theme-studio-overrides';
  const STORAGE_KEY = 'themeOverrides';
  const styleTarget = { document, styleId: STYLE_ID };

  const io = createThemeIo({ api, storageKey: STORAGE_KEY });

  /** Persist a new state and re-render the global override stylesheet. */
  function commit(next) {
    io.saveState(next);
    applyGlobalStyle(next, styleTarget);
  }

  // Apply any stored overrides on activation.
  applyGlobalStyle(io.loadState(), styleTarget);

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

      container.innerHTML = tabMarkup();

      const previewEl = container.querySelector('[data-preview]');
      const previewModeBtns = container.querySelectorAll('[data-preview-mode]');

      function refreshPreview() {
        const vars = resolvedVars(io.loadState(), previewMode);
        applyPreviewVars(previewEl, vars);
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
        const meta = PRESET_LABELS[key] || { title: key, desc: '' };
        const sw = presetSwatchColors(key);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ts-preset${io.loadState().preset === key ? ' is-active' : ''}`;
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
        const v = resolvedVars(io.loadState(), mode)[varName];
        if (isHex(v)) return v;
        return fallback;
      }

      function panelFor(el) {
        return el.parentElement.querySelector('input[type="color"]');
      }

      function hexFor(el) {
        return el.parentElement.querySelector('[data-hex]');
      }

      function applyToken(mode, varName, value, accent) {
        commit(withTokenOverride(io.loadState(), mode, varName, value, accent));
        refreshPreview();
      }

      function refreshFields() {
        container.querySelectorAll('[data-fields]').forEach((panel) => {
          const mode = panel.dataset.fields;
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

      function refreshPresetActive() {
        const cur = io.loadState().preset;
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
        commit(withPreset(io.loadState(), btn.dataset.preset));
        refreshAll();
        api.notify.toast?.({ variant: 'success', title: 'Preset applied' });
      });

      container.querySelector('[data-action="reset"]').addEventListener('click', () => {
        io.clear();
        applyGlobalStyle(io.loadState(), styleTarget);
        refreshAll();
        api.notify.toast?.({ variant: 'success', title: 'Theme reset' });
      });

      container.querySelector('[data-action="export"]').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(io.exportJson());
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
          const next = io.parseImportText(await file.text());
          commit(next);
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
}
