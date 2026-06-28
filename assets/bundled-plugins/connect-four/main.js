/**
 * Vier gewinnt — Main-Prozess: Logging, optionale Befehle.
 */
module.exports = (bluetalk) => {
  bluetalk.log.info('Vier-gewinnt-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('connect-four/ui:', args);
    return { ok: true };
  });

  return {
    deactivate() {
      bluetalk.log.info('Vier-gewinnt-Plugin deaktiviert');
    },
    onUiMessage(payload) {
      if (payload?.wire === 'debug') {
        bluetalk.log.info('connect-four debug:', payload);
      }
    },
  };
};
