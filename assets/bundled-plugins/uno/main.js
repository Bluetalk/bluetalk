/**
 * UNO-Plugin — Main-Prozess: Logging, optionale Befehle.
 */
module.exports = (bluetalk) => {
  bluetalk.log.info('UNO-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('uno/ui:', args);
    return { ok: true };
  });

  return {
    deactivate() {
      bluetalk.log.info('UNO-Plugin deaktiviert');
    },
    onUiMessage(payload) {
      if (payload?.wire === 'debug') {
        bluetalk.log.info('uno debug:', payload);
      }
    },
  };
};
