/**
 * Live Dokumente — Main-Prozess: Logging.
 */
function activate(bluetalk) {
  activate.bluetalk = bluetalk;
  bluetalk.log.info('Live-Dokumente-Plugin aktiv');
}

activate.deactivate = function deactivate() {
  activate.bluetalk?.log.info('Live-Dokumente-Plugin deaktiviert');
  activate.bluetalk = null;
};

module.exports = activate;
