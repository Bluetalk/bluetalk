export const USER_PRESENCE_KIND = 'user-presence';
export const USER_PRESENCE_STATUS_ONLINE = 'online';
export const USER_PRESENCE_STATUS_DND = 'dnd';
export const USER_PRESENCE_STATUS_OFFLINE = 'offline';

export const USER_PRESENCE_OPTIONS = [
  { id: USER_PRESENCE_STATUS_ONLINE, label: 'Online', hint: 'Sichtbar und erreichbar.' },
  { id: USER_PRESENCE_STATUS_DND, label: 'Nicht stören', hint: 'Verbunden, ohne Mitteilungen.' },
  { id: USER_PRESENCE_STATUS_OFFLINE, label: 'Offline', hint: 'Wirkt offline, ohne Mitteilungen.' },
];

/** @param {unknown} value */
export function normalizeUserPresenceStatus(value) {
  if (value === USER_PRESENCE_STATUS_DND || value === USER_PRESENCE_STATUS_OFFLINE) return value;
  return USER_PRESENCE_STATUS_ONLINE;
}

/** @param {{ presenceStatus?: string, doNotDisturb?: boolean } | null | undefined} settings */
export function resolveUserPresenceStatus(settings) {
  if (settings?.presenceStatus) return normalizeUserPresenceStatus(settings.presenceStatus);
  return settings?.doNotDisturb === true
    ? USER_PRESENCE_STATUS_DND
    : USER_PRESENCE_STATUS_ONLINE;
}

/** @param {string} status */
export function presenceSettingsPatch(status) {
  const resolved = normalizeUserPresenceStatus(status);
  return {
    presenceStatus: resolved,
    doNotDisturb: resolved === USER_PRESENCE_STATUS_DND,
  };
}

/** @param {{ presenceStatus?: string, doNotDisturb?: boolean } | null | undefined} settings */
export function shouldSuppressNotifications(settings) {
  const status = resolveUserPresenceStatus(settings);
  return status === USER_PRESENCE_STATUS_DND || status === USER_PRESENCE_STATUS_OFFLINE;
}

/** @param {{ presenceStatus?: string, doNotDisturb?: boolean, displayName?: string }} settings */
export function buildUserPresencePayload(settings) {
  return {
    kind: USER_PRESENCE_KIND,
    status: resolveUserPresenceStatus(settings),
    sender: settings?.displayName || '',
    timestamp: Date.now(),
  };
}

/** @param {unknown} status */
export function parseIncomingUserPresenceStatus(status) {
  return normalizeUserPresenceStatus(status);
}

/** @param {{ status?: string } | null | undefined} presence */
export function isPeerDoNotDisturb(presence) {
  return presence?.status === USER_PRESENCE_STATUS_DND;
}

/** @param {{ status?: string } | null | undefined} presence */
export function isPeerAppearingOffline(presence) {
  return presence?.status === USER_PRESENCE_STATUS_OFFLINE;
}

/** @param {{ status?: string } | null | undefined} presence */
export function formatUserPresenceLabel(presence) {
  if (isPeerAppearingOffline(presence)) return 'Offline';
  if (isPeerDoNotDisturb(presence)) return 'Nicht stören';
  return 'Online';
}

/** @param {{ presenceStatus?: string, doNotDisturb?: boolean } | null | undefined} settings */
export function formatOwnPresenceLabel(settings) {
  return formatUserPresenceLabel({ status: resolveUserPresenceStatus(settings) });
}
