/**
 * Theme Studio — static markup and styles for the Themes tab.
 * DOM-string only; all interactivity is wired up in ui.js.
 */

export function tabMarkup() {
  return `
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
}
