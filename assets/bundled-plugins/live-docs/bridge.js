/**
 * Live Dokumente — Brücke zum Editor-Fenster und Kontakt-/Teilnehmer-Helfer.
 *
 * Kapselt die window.bluetalk.docs-Transportschicht (pushState / pushPresence /
 * onFromChild / Fenster öffnen) sowie die reinen Namensauflöser. Kein Zustand.
 */

/** Dünne, fehlertolerante Hülle um window.bluetalk.docs. */
export function createDocsBridge() {
  return {
    canPush: () => Boolean(window.bluetalk?.docs?.pushState),
    pushState(payload) {
      try {
        window.bluetalk?.docs?.pushState?.(payload);
      } catch {
        /* ignore */
      }
    },
    pushPresence(payload) {
      try {
        window.bluetalk?.docs?.pushPresence?.(payload);
      } catch {
        /* ignore */
      }
    },
    async openWindow() {
      try {
        await window.bluetalk?.docs?.openGameWindow?.();
      } catch {
        /* ignore */
      }
    },
    onFromChild(handler) {
      return window.bluetalk?.docs?.onFromChild
        ? window.bluetalk.docs.onFromChild(handler)
        : null;
    },
  };
}

export function contactName(api, peerId) {
  const contact = api.contacts().find((c) => c.id === peerId);
  return contact?.nickname || contact?.name || peerId?.slice(0, 10) || 'Gast';
}

export function listContacts(api) {
  try {
    return api.contacts()
      .filter((c) => c?.id && c.blocked !== true)
      .map((c) => ({ id: c.id, name: c.nickname || c.name || c.id }))
      .slice(0, 100);
  } catch {
    return [];
  }
}

export function listParticipants({ room, selfPeerId, selfName, resolveName }) {
  if (!room) return [];
  return room.allMemberPeerIds().map((peerId) => {
    const member = room.members.get(peerId);
    const name = peerId === selfPeerId
      ? (selfName || 'Ich')
      : (member?.name && member.name !== 'host' ? member.name : resolveName(peerId));
    return {
      peerId,
      name,
      isSelf: peerId === selfPeerId,
      isHost: peerId === room.hostPeerId,
    };
  });
}
