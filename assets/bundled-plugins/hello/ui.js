/**
 * Hello plugin — renderer side.
 *
 * Registers a sidebar tab with a live event log and a "ping all peers" button.
 */
export default function activateHelloPlugin(BlueTalkPlugin) {
  const api = BlueTalkPlugin;

  api.ui.registerTab({
    id: 'feed',
    label: 'Hello Feed',
    icon: 'Sparkles',
    order: 50,
    render(container) {
      container.innerHTML = `
        <div class="hello-plugin-card">
          <p>
            Diese Ansicht zeigt die Plugin-API. <strong>Ping peers</strong> sendet eine Nachricht an alle verbundenen Geräte. Ereignisse erscheinen unten.
          </p>
          <div class="hello-plugin-row">
            <button type="button" data-action="ping">Ping peers</button>
            <button type="button" data-action="dialog">Beispiel-Dialog</button>
            <span class="hello-plugin-count"></span>
          </div>
          <ul class="hello-plugin-log"></ul>
        </div>
        <style>
          .hello-plugin-card { max-width: 720px; }
          .hello-plugin-row {
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 12px 0 16px;
            flex-wrap: wrap;
          }
          .hello-plugin-count {
            font-size: 12px;
            color: var(--fg-3);
          }
          .hello-plugin-log {
            list-style: none;
            padding: 0;
            margin: 0;
            max-height: 360px;
            overflow: auto;
            border: 1px solid var(--border);
            border-radius: var(--radius-md);
            background: var(--bg-1);
          }
          .hello-plugin-log li {
            font-family: var(--mono, monospace);
            font-size: 12px;
            padding: 8px 12px;
            border-bottom: 1px solid var(--border);
            color: var(--fg-1);
          }
          .hello-plugin-log li:last-child { border-bottom: none; }
        </style>
      `;

      const logEl = container.querySelector('.hello-plugin-log');
      const countEl = container.querySelector('.hello-plugin-count');

      function refreshCount() {
        const peers = api.peers() || [];
        countEl.textContent = `${peers.length} peer(s) online`;
      }

      function log(line) {
        const li = document.createElement('li');
        const ts = new Date().toLocaleTimeString();
        li.textContent = `[${ts}] ${line}`;
        logEl.insertBefore(li, logEl.firstChild);
        while (logEl.childElementCount > 80) {
          logEl.removeChild(logEl.lastChild);
        }
      }

      refreshCount();

      const offs = [];
      offs.push(api.on('peer:connected', (peer) => {
        log(`connected: ${peer?.name || peer?.id}`);
        refreshCount();
      }));
      offs.push(api.on('peer:disconnected', (peerId) => {
        log(`disconnected: ${peerId}`);
        refreshCount();
      }));
      offs.push(api.on('peer:message', (msg) => {
        if (msg?.kind === 'plugin-hello-ping') {
          log(`ping from ${msg.from}: ${msg.text}`);
        } else if (msg?.kind === 'chat') {
          log(`${msg.sender || msg.from} said: ${(msg.content || '').slice(0, 80)}`);
        }
      }));

      container.querySelector('[data-action="ping"]').addEventListener('click', () => {
        // v2 has no main-process runtime, so broadcast straight from the UI side.
        const sent = (api.peers() || []).length;
        api.peer.broadcast({
          kind: 'plugin-hello-ping',
          text: 'Hello from the hello plugin!',
          timestamp: Date.now(),
        });
        log(`broadcast sent to ${sent} peer(s)`);
      });

      container.querySelector('[data-action="dialog"]').addEventListener('click', () => {
        api.ui.openScreen('sample');
      });

      return () => {
        offs.forEach((off) => off?.());
      };
    },
  });

  api.ui.registerScreen({
    id: 'sample',
    title: 'Hello plugin: sample screen',
    render(container, ctx) {
      container.innerHTML = `
        <p>This dialog is registered by the hello plugin. Plugins can open screens from anywhere.</p>
        <ul style="margin-top: 10px;">
          <li>Peers online: ${(api.peers() || []).length}</li>
          <li>Contacts saved: ${(api.contacts() || []).length}</li>
        </ul>
        <button type="button" data-close>Schließen</button>
      `;
      container.querySelector('[data-close]').addEventListener('click', () => ctx.close?.());
    },
  });

  api.log.info('Hello plugin UI registered');
}
