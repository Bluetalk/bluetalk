/**
 * Tic-Tac-Toe — Main-Prozess: Logging, optionale Befehle.
 */
module.exports = (bluetalk) => {
  bluetalk.log.info('Tic-Tac-Toe-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('tic-tac-toe/ui:', args);
    return { ok: true };
  });

  return {
    deactivate() {
      bluetalk.log.info('Tic-Tac-Toe-Plugin deaktiviert');
    },
    onUiMessage(payload) {
      if (payload?.wire === 'debug') {
        bluetalk.log.info('tic-tac-toe debug:', payload);
      }
    },
  };
};
