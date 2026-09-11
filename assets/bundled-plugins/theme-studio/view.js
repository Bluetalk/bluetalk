/**
 * Theme Studio — static markup and styles for the Design tab.
 * DOM-string only; all interactivity is wired up in ui.js.
 */

export function tabMarkup() {
  return `
    <div class="ts-wrap">
      <header class="ts-head">
        <p>Farben für hell und dunkel. Änderungen gelten sofort in der ganzen App.</p>
      </header>

      <section class="ts-section">
        <div class="ts-section-head">
          <h3>Vorschau</h3>
          <div class="ts-preview-modes" data-preview-modes>
            <button type="button" class="ts-mode-btn" data-preview-mode="light" aria-pressed="false">Hell</button>
            <button type="button" class="ts-mode-btn" data-preview-mode="dark" aria-pressed="false">Dunkel</button>
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
                <div class="ts-preview-msg ts-preview-msg--them"><span>Nachricht</span></div>
                <div class="ts-preview-msg ts-preview-msg--me"><span>Antwort</span></div>
              </div>
              <div class="ts-preview-footer">
                <div class="ts-preview-input">Nachricht schreiben…</div>
                <button type="button" class="ts-preview-send">Senden</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="ts-section">
        <h3>Vorlagen</h3>
        <div class="ts-preset-grid" data-presets></div>
      </section>

      <section class="ts-section ts-split">
        <div class="ts-mode" data-mode-panel="dark">
          <h3>Dunkel</h3>
          <div class="ts-fields" data-fields="dark"></div>
        </div>
        <div class="ts-mode" data-mode-panel="light">
          <h3>Hell</h3>
          <div class="ts-fields" data-fields="light"></div>
        </div>
      </section>

      <section class="ts-section ts-actions">
        <div class="ts-action-row">
          <button type="button" class="ts-btn" data-action="export">Exportieren</button>
          <button type="button" class="ts-btn" data-action="import">Importieren</button>
          <input type="file" accept="application/json,.json" hidden data-import-file />
        </div>
        <button type="button" class="ts-btn ts-btn-danger" data-action="reset">Zurücksetzen</button>
        <span class="ts-hint">Die Vorschau folgt dem Farbschema, das du gerade bearbeitest. Hell/Dunkel der App stellst du unter Einstellungen → App um.</span>
      </section>
    </div>
    <style>
      .ts-wrap {
        max-width: 720px;
        margin: 0 auto;
        padding: 4px 4px 24px;
        color: var(--fg-0);
      }
      .ts-head p {
        margin: 0;
        color: var(--fg-2);
        font-size: 13px;
        line-height: 1.5;
        max-width: 520px;
      }
      .ts-section { margin-top: 28px; }
      .ts-section-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 12px;
      }
      .ts-section h3 {
        margin: 0 0 12px;
        font-size: 13px;
        letter-spacing: -0.1px;
        color: var(--fg-2);
        font-weight: 600;
        text-transform: none;
      }
      .ts-section-head h3 { margin-bottom: 0; }
      .ts-preview-modes {
        display: flex;
        gap: 3px;
        padding: 3px;
        border-radius: 999px;
        background: var(--bg-2);
        border: 1px solid var(--border);
      }
      .ts-mode-btn {
        border: 0;
        background: transparent;
        color: var(--fg-2);
        font-size: 12px;
        font-weight: 500;
        padding: 5px 12px;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, transform 0.12s;
      }
      .ts-mode-btn:hover { color: var(--fg-0); }
      .ts-mode-btn:active { transform: scale(0.97); }
      .ts-mode-btn.is-active {
        background: var(--bg-0);
        color: var(--fg-0);
        box-shadow: var(--shadow-sm);
      }
      .ts-preview {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        overflow: hidden;
        background: var(--bg-1);
      }
      .ts-preview-app {
        display: flex;
        min-height: 188px;
        background: var(--bg-1);
      }
      .ts-preview-side {
        width: 44px;
        padding: 10px 6px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        background: var(--bg-1);
      }
      .ts-preview-nav {
        height: 28px;
        border-radius: var(--radius-md);
        background: var(--bg-2);
      }
      .ts-preview-nav.is-active { background: var(--accent-soft); }
      .ts-preview-main {
        flex: 1;
        display: flex;
        flex-direction: column;
        background: var(--bg-0);
        min-width: 0;
        margin: 8px 8px 8px 0;
        border-radius: var(--radius-md);
        overflow: hidden;
      }
      .ts-preview-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: var(--bg-0);
      }
      .ts-preview-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--fg-0);
      }
      .ts-preview-pill {
        font-size: 11px;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--fg-1);
      }
      .ts-preview-chat {
        flex: 1;
        padding: 12px 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ts-preview-msg {
        max-width: 70%;
        font-size: 12px;
        line-height: 1.4;
        padding: 7px 12px;
        border-radius: var(--radius-lg);
        color: var(--fg-0);
        background: var(--bg-2);
      }
      .ts-preview-msg--me {
        align-self: flex-end;
        background: var(--accent);
        color: var(--accent-fg);
      }
      .ts-preview-footer {
        display: flex;
        gap: 8px;
        padding: 10px 12px 12px;
      }
      .ts-preview-input {
        flex: 1;
        font-size: 12px;
        color: var(--fg-3);
        padding: 8px 12px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border);
        background: var(--bg-input, var(--bg-0));
      }
      .ts-preview-send {
        border: 0;
        border-radius: var(--radius-md);
        padding: 8px 14px;
        font-size: 12px;
        font-weight: 500;
        cursor: default;
        background: var(--accent);
        color: var(--accent-fg);
      }
      .ts-preset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 10px;
      }
      .ts-preset {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 10px 12px 12px;
        background: var(--bg-1);
        color: var(--fg-0);
        cursor: pointer;
        text-align: left;
        font-size: 13px;
        font-weight: 500;
        transition: background 0.15s, border-color 0.15s, transform 0.12s;
      }
      .ts-preset:hover {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }
      .ts-preset:active { transform: scale(0.98); }
      .ts-preset.is-active {
        border-color: var(--fg-0);
        background: var(--bg-2);
        box-shadow: 0 0 0 1px var(--fg-0);
      }
      .ts-preset-swatches {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        margin-bottom: 10px;
      }
      .ts-preset-swatch {
        height: 26px;
        border-radius: var(--radius-sm);
        position: relative;
        overflow: hidden;
      }
      .ts-preset-swatch span {
        position: absolute;
        right: 6px;
        top: 6px;
        width: 9px;
        height: 9px;
        border-radius: 50%;
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
        gap: 12px;
      }
      @media (max-width: 640px) {
        .ts-split { grid-template-columns: 1fr; }
      }
      .ts-mode {
        border: 1px solid var(--border);
        border-radius: var(--radius-lg);
        padding: 16px;
        background: var(--bg-1);
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .ts-mode.is-preview {
        border-color: var(--fg-3);
        box-shadow: 0 0 0 1px var(--fg-3);
      }
      .ts-mode h3 { margin-bottom: 14px; }
      .ts-mode.is-preview h3::after {
        content: 'Vorschau';
        margin-left: 8px;
        font-size: 10px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--fg-3);
        vertical-align: middle;
      }
      .ts-field {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 8px 10px;
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
        width: 36px;
        height: 32px;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: var(--radius-md);
        background: var(--bg-0);
        cursor: pointer;
      }
      .ts-field input[type="text"] {
        font-family: var(--font-mono);
        font-size: 12px;
        padding: 6px 10px;
        border-radius: var(--radius-md);
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
        border-radius: var(--radius-md);
        padding: 8px 14px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid var(--border);
        background: var(--bg-2);
        color: var(--fg-0);
        transition: background 0.15s, transform 0.12s;
      }
      .ts-btn:hover { background: var(--bg-hover); }
      .ts-btn:active { transform: scale(0.98); }
      .ts-btn-danger {
        border-color: color-mix(in srgb, var(--red) 35%, var(--border));
        color: var(--red);
        background: var(--bg-1);
      }
      .ts-btn-danger:hover { background: var(--red-soft); }
      .ts-hint {
        font-size: 12px;
        color: var(--fg-3);
        line-height: 1.45;
        max-width: 480px;
      }
    </style>
  `;
}
