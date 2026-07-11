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
          <h3>Hello plugin feed</h3>
          <p>
            This tab demonstrates the plugin API. Click <strong>Ping peers</strong> to broadcast a
            realtime message to every connected peer. All peer events appear below.
          </p>
          <div class="hello-plugin-row">
            <button class="hello-plugin-btn" data-action="ping">Ping peers</button>
            <button class="hello-plugin-btn hello-plugin-btn-secondary" data-action="dialog">Open example screen</button>
            <span class="hello-plugin-count"></span>
          </div>
          <ul class="hello-plugin-log"></ul>
        </div>
        <style>
          .hello-plugin-card {
            max-width: 720px;
            margin: 0 auto;
            padding: 16px 20px;
            background: var(--bg-1);
            border: 1px solid var(--border);
            border-radius: 10px;
          }
          .hello-plugin-card h3 { margin-top: 0; }
          .hello-plugin-row {
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 12px 0;
            flex-wrap: wrap;
          }
          .hello-plugin-btn {
            background: var(--accent);
            color: #fff;
            border: 0;
            border-radius: 6px;
            padding: 6px 12px;
            font-size: 13px;
            cursor: pointer;
          }
          .hello-plugin-btn-secondary {
            background: var(--bg-2);
            color: var(--fg-0);
            border: 1px solid var(--border);
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
            border-top: 1px dashed var(--border);
          }
          .hello-plugin-log li {
            font-family: var(--mono, monospace);
            font-size: 12px;
            padding: 6px 4px;
            border-bottom: 1px solid var(--border);
            color: var(--fg-1);
          }
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
        <button class="hello-plugin-btn" data-close>Close</button>
      `;
      container.querySelector('[data-close]').addEventListener('click', () => ctx.close?.());
    },
  });

  api.log.info('Hello plugin UI registered');
}
