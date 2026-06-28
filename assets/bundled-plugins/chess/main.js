/**
 * Schach-Plugin — Main-Prozess: Logging, optionale Befehle.
 */
module.exports = (bluetalk) => {
  bluetalk.log.info('Schach-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('chess/ui:', args);
    return { ok: true };
  });

  return {
    deactivate() {
      bluetalk.log.info('Schach-Plugin deaktiviert');
    },
    onUiMessage(payload) {
      if (payload?.wire === 'debug') {
        bluetalk.log.info('chess debug:', payload);
      }
    },
  };
};
