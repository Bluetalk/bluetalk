/**
 * Experimentelle und Leistungs-Schalter. Werte in settings.featureFlags; fehlende Keys nutzen defaultEnabled.
 */
export const FEATURE_FLAG_DEFINITIONS = [
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
    defaultEnabled: false,
  },
  {
    id: 'settingsHub',
    label: 'Settings-Hub',
    description:
      'Zeigt die Einstellungen als Übersicht mit Unterseiten (Account, Verbindung) statt alles auf einer Seite.',
    defaultEnabled: false,
  },
];

/** @param {object | null | undefined} contact */
export function isContactNotificationMuted(contact, now = Date.now()) {
  if (!contact || typeof contact !== 'object') return false;
  if (contact.notifyMutedManual === true) return true;
  if (typeof contact.notifyMutedUntil === 'number' && now < contact.notifyMutedUntil) return true;
  return false;
}

const DEFAULT_FLAG_MAP = Object.fromEntries(
  FEATURE_FLAG_DEFINITIONS.map((d) => [d.id, d.defaultEnabled])
);

export function mergeFeatureFlagDefaults(stored) {
  return {
    ...DEFAULT_FLAG_MAP,
    ...(stored && typeof stored === 'object' ? stored : {}),
  };
}

export function getEffectiveFlag(settings, flagId) {
  const def = FEATURE_FLAG_DEFINITIONS.find((d) => d.id === flagId);
  const v = settings?.featureFlags?.[flagId];
  if (typeof v === 'boolean') return v;
  return def ? def.defaultEnabled : false;
}
