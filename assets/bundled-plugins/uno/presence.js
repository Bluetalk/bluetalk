/**
 * UNO — Presence-Signalisierung (Lobby-Sichtbarkeit für andere Peers).
 */

export const GAME_PRESENCE_KIND = 'game-presence';
export const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

/** Nur in Lobby-/Rundenende-Phasen können neue Spieler beitreten. */
export function isUnoLobbyJoinable(phase) {
  return phase === 'lobby' || phase === 'roundOver';
}

/**
 * Baut die Presence-Broadcast-Nutzlast aus dem öffentlichen Spielzustand.
 * `pub` ist der publicState (Host) bzw. clientState (Gast).
 */
export function buildPresencePayload(pub, selfPeerId, isHost) {
  const playerCount = (pub.players || []).length;
  const maxPlayers = pub.settings?.maxPlayers || 4;
  const role = isHost ? 'host' : 'player';
  const phase = pub.phase || 'lobby';
  const joinable = role === 'host' && isUnoLobbyJoinable(phase) && playerCount < maxPlayers;
  return {
    kind: GAME_PRESENCE_KIND,
    game: 'uno',
    sessionId: pub.gameId,
    tableName: pub.settings?.tableName || 'UNO-Tisch',
    phase,
    lobbyAccess: pub.settings?.lobbyAccess === 'public' ? 'public' : 'invite',
    role,
    hostPeerId: pub.hostPeerId || selfPeerId,
    playerCount,
    maxPlayers,
    joinable,
    timestamp: Date.now(),
  };
}
