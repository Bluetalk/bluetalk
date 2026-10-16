const SPECS = {
  poker: { route: '/poker-game', prefix: 'poker', title: 'BlueTalk Poker', width: 1280, height: 820 },
  uno: { route: '/uno-game', prefix: 'uno', title: 'BlueTalk UNO', width: 1280, height: 820 },
  'connect-four': { route: '/connect-four-game', prefix: 'connect-four', title: 'BlueTalk Vier gewinnt', width: 900, height: 780 },
  chess: { route: '/chess-game', prefix: 'chess', title: 'BlueTalk Schach', width: 960, height: 820 },
  ticTacToe: { route: '/tic-tac-toe-game', prefix: 'ticTacToe', title: 'BlueTalk Tic-Tac-Toe', width: 900, height: 780 },
  kart: { route: '/kart-game', prefix: 'kart', title: 'BlueKart', width: 1280, height: 800 },
};

const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_ACTION_BYTES = 1024 * 1024;

function payloadSize(payload) {
  return new TextEncoder().encode(JSON.stringify(payload ?? null)).length;
}

export function createGameWindows(bus) {
  const popups = new Map();
  const lastState = new Map();
  const maximized = new Map();
  const isGameWindow = Object.values(SPECS).some((spec) => window.location.hash.slice(1).split(/[?#]/, 1)[0] === spec.route);

  function specFor(game) {
    const spec = SPECS[game];
    if (!spec) throw new Error(`unsupported auxiliary window '${game}'`);
    return spec;
  }

  function features(spec) {
    return `popup=yes,width=${spec.width},height=${spec.height},resizable=yes`;
  }

  function gameBridge(game, route) {
    const spec = specFor(game);
    return {
      openGameWindow: async () => {
        if (route !== spec.route) throw new Error(`route '${route}' is not valid for '${game}'`);
        const existing = popups.get(game);
        if (existing && !existing.closed) {
          existing.focus();
          const cached = lastState.get(game);
          if (cached !== undefined) {
            bus.emit(`${spec.prefix}:state`, cached, { broadcast: true });
          }
          return false;
        }
        const popup = window.open(`${window.location.pathname}${window.location.search}#${spec.route}`, `bluetalk-${game}`, features(spec));
        if (!popup) throw new Error('Spielfenster wurde blockiert.');
        popups.set(game, popup);
        const cached = lastState.get(game);
        if (cached !== undefined) {
          setTimeout(() => bus.emit(`${spec.prefix}:state`, cached, { broadcast: true }), 400);
        }
        return true;
      },
      closeGameWindow: async () => {
        const popup = popups.get(game);
        if (!popup || popup.closed) {
          if (isGameWindow) window.close();
          return Boolean(popup);
        }
        popup.close();
        popups.delete(game);
        return true;
      },
      minimizeWindow: async () => {
        popups.get(game)?.blur();
      },
      maximizeWindow: async () => {
        const target = isGameWindow ? window : popups.get(game);
        if (!target) return false;
        try {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
            maximized.set(game, false);
          } else {
            await (target.document?.documentElement || document.documentElement).requestFullscreen();
            maximized.set(game, true);
          }
        } catch {
          maximized.set(game, !(maximized.get(game)));
        }
        const next = Boolean(maximized.get(game));
        bus.emit(`${spec.prefix}:windowMaximized`, next, { broadcast: true });
        return next;
      },
      isWindowMaximized: async () => Boolean(maximized.get(game) || document.fullscreenElement),
      onWindowMaximizedChange: (callback) => bus.subscribe(`${spec.prefix}:windowMaximized`, callback),
      pushState: async (payload) => {
        if (payloadSize(payload) > MAX_STATE_BYTES) throw new Error('game state exceeds the 16777216-byte limit');
        lastState.set(game, payload);
        bus.emit(`${spec.prefix}:state`, payload, { broadcast: true });
        return true;
      },
      sendAction: async (payload) => {
        if (payloadSize(payload) > MAX_ACTION_BYTES) throw new Error('game action exceeds the 1048576-byte limit');
        bus.emit(`${spec.prefix}:fromChild`, payload, { broadcast: true });
        return true;
      },
      onState: (callback) => bus.subscribe(`${spec.prefix}:state`, callback),
      onFromChild: (callback) => bus.subscribe(`${spec.prefix}:fromChild`, callback),
    };
  }

  return {
    poker: Object.freeze(gameBridge('poker', '/poker-game')),
    uno: Object.freeze(gameBridge('uno', '/uno-game')),
    connectFour: Object.freeze(gameBridge('connect-four', '/connect-four-game')),
    chess: Object.freeze(gameBridge('chess', '/chess-game')),
    ticTacToe: Object.freeze(gameBridge('ticTacToe', '/tic-tac-toe-game')),
    kart: Object.freeze(gameBridge('kart', '/kart-game')),
  };
}
