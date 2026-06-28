export const USER_PRESENCE_KIND = 'user-presence';
export const USER_PRESENCE_STATUS_ONLINE = 'online';
export const USER_PRESENCE_STATUS_DND = 'dnd';

/** @param {{ doNotDisturb?: boolean, displayName?: string }} settings */
export function resolveUserPresenceStatus(settings) {
  return settings?.doNotDisturb === true
    ? USER_PRESENCE_STATUS_DND
    : USER_PRESENCE_STATUS_ONLINE;
}

/** @param {{ doNotDisturb?: boolean, displayName?: string }} settings */
export function buildUserPresencePayload(settings) {
  return {
    kind: USER_PRESENCE_KIND,
    status: resolveUserPresenceStatus(settings),
    sender: settings?.displayName || '',
    timestamp: Date.now(),
  };
}

/** @param {{ status?: string } | null | undefined} presence */
export function isPeerDoNotDisturb(presence) {
  return presence?.status === USER_PRESENCE_STATUS_DND;
}

/** @param {{ status?: string } | null | undefined} presence */
export function formatUserPresenceLabel(presence) {
  return isPeerDoNotDisturb(presence) ? 'Nicht stören' : 'Online';
}
