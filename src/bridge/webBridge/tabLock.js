const CHANNEL = 'bluetalk-web-device';

const AUX_ROUTES = new Set([
  '/poker-game',
  '/uno-game',
  '/connect-four-game',
  '/chess-game',
  '/tic-tac-toe-game',
  '/kart-game',
  '/docs-editor',
]);

/** Spiel-/Editor-Popups dürfen die Relay-Geräte-ID nicht übernehmen. */
export function isAuxiliaryWindow() {
  if (typeof window === 'undefined') return false;
  const route = String(window.location.hash || '').slice(1).split(/[?#]/, 1)[0];
  if (AUX_ROUTES.has(route)) return true;
  return Boolean(window.opener);
}

/**
 * Ein Browser-Profil teilt sich eine deviceId. Der neuere Tab kündigt sich
 * per BroadcastChannel an, der alte gibt die Relay-Verbindung frei.
 */
export function createTabLock({ onForeignClaim } = {}) {
  const tabId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  if (isAuxiliaryWindow() || typeof BroadcastChannel !== 'function') {
    return {
      tabId,
      active: false,
      claim() {},
      close() {},
    };
  }

  const channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'claim' && data.tabId && data.tabId !== tabId) {
      onForeignClaim?.(data.tabId);
    }
  });

  function claim() {
    try {
      channel.postMessage({ type: 'claim', tabId });
    } catch {
      /* privater Modus */
    }
  }

  return {
    tabId,
    active: true,
    claim,
    close() {
      try {
        channel.close();
      } catch {
        /* ignore */
      }
    },
  };
}
