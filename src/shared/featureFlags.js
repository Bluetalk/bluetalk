/**
 * Experimentelle und Leistungs-Schalter. Werte in settings.featureFlags; fehlende Keys nutzen defaultEnabled.
 * Gemeinsam für Main- und Renderer-Prozess.
 */
const FEATURE_FLAG_DEFINITIONS = [
  {
    id: 'chatUnreadListBadges',
    label: 'Ungelesen in der Chat-Liste',
    description:
      'Zeigt in der Chat-Liste einen Hinweis und eine Zahl (1–9, ab 10 als „9+“), wenn seit dem letzten Öffnen des Chats neue Nachrichten vom Peer eingegangen sind.',
    defaultEnabled: false,
  },
  {
    id: 'resizableUi',
    label: 'Größenanpassbare Bereiche',
    description:
      'Zeigt Ziehgriffe zwischen linker Navigationsleiste und Inhalt sowie zwischen Chat-Liste und Gespräch. Ab ausreichender Breite: Icon links, Beschriftung rechts daneben, beides wird mit weiterem Aufziehen größer. Schmal bleibt die kompakte Darstellung. Breiten werden gespeichert; Doppelklick auf einen Griff setzt die Standardbreite.',
    defaultEnabled: false,
  },
  {
    id: 'contactNotificationMute',
    label: 'Kontakt stummschalten (Mitteilungen)',
    description:
      'Erlaubt pro Kontakt Windows-Mitteilungen stummzuschalten: für eine feste Dauer (z. B. 1 h) oder bis du die Stummschaltung wieder aufhebst. Betrifft nur Benachrichtigungen, nicht den Nachrichteneingang.',
    defaultEnabled: true,
  },
  {
    id: 'settingsHub',
    label: 'Settings-Hub',
    description:
      'Zeigt die Einstellungen als Übersicht mit Unterseiten (Account, Verbindung) statt alles auf einer Seite.',
    defaultEnabled: false,
  },
];

const DEFAULT_FLAG_MAP = Object.fromEntries(
  FEATURE_FLAG_DEFINITIONS.map((d) => [d.id, d.defaultEnabled])
);

function mergeFeatureFlagDefaults(stored) {
  return {
    ...DEFAULT_FLAG_MAP,
    ...(stored && typeof stored === 'object' ? stored : {}),
  };
}

function getEffectiveFlag(settings, flagId) {
  const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.id === flagId);
  const v = settings?.featureFlags?.[flagId];
  if (typeof v === 'boolean') return v;
  return def ? def.defaultEnabled : false;
}

module.exports = {
  FEATURE_FLAG_DEFINITIONS,
  mergeFeatureFlagDefaults,
  getEffectiveFlag,
};
