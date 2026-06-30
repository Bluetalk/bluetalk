/**
 * 3D Live Autorennen — Main-Prozess: Logging.
 */
module.exports = (bluetalk) => {
  bluetalk.log.info('3D-Live-Autorennen-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('racing-3d/ui:', args);
    return { ok: true };
  });

  return {
    deactivate() {
      bluetalk.log.info('3D-Live-Autorennen-Plugin deaktiviert');
    },
  };
};
