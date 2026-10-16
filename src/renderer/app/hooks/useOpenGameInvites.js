// Offene Spiel-Einladungen / beitretbare Lobbys anderer Peers.
// Quelle ist die Live-Präsenz (nicht der Chatverlauf): abgelaufene oder volle
// Sitzungen verschwinden automatisch. Gemeinsam genutzt von der Seitenleiste
// (Zähler-Badge) und der Spiele-Seite (Liste).
import { useMemo } from 'react';
import { useApp } from '../appContext';
import {
  canJoinGameViaPresence,
  isPresenceStale,
} from '../../../shared/game-presence.js';

export const GAME_LABELS = {
  poker: 'Poker',
  uno: 'UNO',
  'connect-four': 'Vier gewinnt',
  chess: 'Schach',
  'tic-tac-toe': 'Tic-Tac-Toe',
  kart: 'BlueKart',
};

export function useOpenGameInvites() {
  const { peers, contacts, peerGamePresence, gameInviteKeys } = useApp();

  return useMemo(() => {
    const rows = [];
    for (const [hostPeerId, presence] of Object.entries(peerGamePresence || {})) {
      if (!presence || isPresenceStale(presence)) continue;
      if (!canJoinGameViaPresence({ presence, gameInvites: gameInviteKeys, hostPeerId })) continue;
      const contact = contacts.find((c) => c?.id === hostPeerId);
      const peer = peers.find((p) => p?.id === hostPeerId);
      const hostName = contact?.nickname || contact?.name || peer?.name || hostPeerId;
      rows.push({
        hostPeerId,
        presence,
        hostName,
        gameLabel: GAME_LABELS[presence.game] || presence.game,
        profilePicture: contact?.profilePicture || peer?.profilePicture || '',
        isPublic: presence.lobbyAccess === 'public',
      });
    }
    return rows.sort((a, b) => a.hostName.localeCompare(b.hostName, undefined, { sensitivity: 'base' }));
  }, [peerGamePresence, gameInviteKeys, contacts, peers]);
}
