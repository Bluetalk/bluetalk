const ALLOWED_EVENTS = new Set([
  'peer:connected',
  'peer:disconnected',
  'peer:devices',
  'peer:message',
  'peer:file-offered',
  'peer:file-received',
  'peer:discovered',
  'peers:list-sync',
  'updater:state',
  'ollama:state',
  'ollama:ask-user',
  'ollama:ask-user-done',
  'ollama:chat-progress',
  'bot:message',
  'bot:worklog',
  'bot:typing',
  'app:data-cleared',
  'plugins:event',
  'plugins:changed',
  'plugins:message',
  'plugins:contacts-updated',
  'agent:send-message',
  'agent:connect-peer',
  'window:maximized',
  'poker:windowMaximized',
  'poker:state',
  'poker:fromChild',
  'uno:windowMaximized',
  'uno:state',
  'uno:fromChild',
  'connect-four:windowMaximized',
  'connect-four:state',
  'connect-four:fromChild',
  'chess:windowMaximized',
  'chess:state',
  'chess:fromChild',
  'ticTacToe:windowMaximized',
  'ticTacToe:state',
  'ticTacToe:fromChild',
  'kart:windowMaximized',
  'kart:state',
  'kart:fromChild',
  'cloud:status',
  'cloud:presence',
  'cloud:mail',
  'cloud:sync',
]);

export function createEventBus() {
  const listeners = new Map();
  const channel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('bluetalk-web-events')
    : null;

  if (channel) {
    channel.addEventListener('message', (event) => {
      const { name, payload, origin } = event.data || {};
      if (!name || origin === windowName()) return;
      emitLocal(name, payload);
    });
  }

  function windowName() {
    return window.name || 'bluetalk-main';
  }

  function emitLocal(name, payload) {
    const set = listeners.get(name);
    if (!set) return;
    for (const callback of [...set]) {
      try {
        callback(payload);
      } catch {
        // listener errors must not break the bus
      }
    }
  }

  function emit(name, payload, { broadcast = false } = {}) {
    emitLocal(name, payload);
    if (broadcast && channel) {
      channel.postMessage({ name, payload, origin: windowName() });
    }
  }

  function subscribe(name, callback) {
    if (!ALLOWED_EVENTS.has(name) || typeof callback !== 'function') {
      return () => undefined;
    }
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(callback);
    return () => {
      set.delete(callback);
      if (!set.size) listeners.delete(name);
    };
  }

  return { emit, subscribe, allowed: ALLOWED_EVENTS };
}
