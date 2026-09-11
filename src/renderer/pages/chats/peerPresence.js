import { formatGamePresenceLabel } from '../../../shared/game-presence.js';
import {
  formatUserPresenceLabel,
  isPeerAppearingOffline,
  isPeerDoNotDisturb,
} from '../../../shared/user-presence.js';

export function peerPresenceKind(peer, isAiChat, isGroup) {
  if (isGroup) return 'group';
  if (isAiChat) return 'online';
  if (peer.contact?.blocked || peer.contact?.blockedByPeer) return 'blocked';
  if (peer.contact?.chatDeletedByPeer) return 'muted';
  if (peer.offline || isPeerAppearingOffline(peer.userPresence)) return 'offline';
  if (peer.gamePresence) return 'game';
  if (isPeerDoNotDisturb(peer.userPresence)) return 'dnd';
  return 'online';
}

export function peerPresenceLabel(peer, isAiChat, isGroup) {
  if (isGroup) {
    const online = Math.max(0, peer.onlineMemberCount - 1);
    return `${peer.activeMemberCount} Mitglieder · ${online} online`;
  }
  if (isAiChat) return 'Bot';
  if (peer.offline || isPeerAppearingOffline(peer.userPresence)) return 'Offline';
  if (peer.gamePresence) return formatGamePresenceLabel(peer.gamePresence);
  if (isPeerDoNotDisturb(peer.userPresence)) {
    return formatUserPresenceLabel(peer.userPresence);
  }
  if (peer.contact?.blocked) return 'Blockiert';
  if (peer.contact?.blockedByPeer) return 'Du wurdest blockiert';
  if (peer.contact?.chatDeletedByPeer) return 'Chat gelöscht';
  return 'Online';
}
