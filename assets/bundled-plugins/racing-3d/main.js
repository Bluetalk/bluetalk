/**
 * 3D Live Autorennen — Main-Prozess: Logging.
 */
function activate(bluetalk) {
  activate.bluetalk = bluetalk;
  bluetalk.log.info('3D-Live-Autorennen-Plugin aktiv');

  bluetalk.registerCommand('log', (args) => {
    bluetalk.log.info('racing-3d/ui:', args);
    return { ok: true };
  });
}

activate.deactivate = function deactivate() {
  activate.bluetalk?.log.info('3D-Live-Autorennen-Plugin deaktiviert');
  activate.bluetalk = null;
};

module.exports = activate;
