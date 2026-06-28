/** @typedef {'uno' | 'poker' | 'connect-four' | 'chess' | 'tic-tac-toe'} GameKind */
/** @typedef {'public' | 'invite'} LobbyAccess */

const GAME_PRESENCE_KIND = 'game-presence';
const GAME_PRESENCE_CLEAR_KIND = 'game-presence-clear';

const LOBBY_ACCESS = {
  PUBLIC: 'public',
  INVITE: 'invite',
};

/** @param {unknown} value @returns {LobbyAccess} */
function normalizeLobbyAccess(value) {
  return value === LOBBY_ACCESS.PUBLIC ? LOBBY_ACCESS.PUBLIC : LOBBY_ACCESS.INVITE;
}

/** @param {GameKind} game @param {string} hostPeerId @param {string} sessionId */
function gameInviteKey(game, hostPeerId, sessionId) {
  return `${game}:${hostPeerId}:${sessionId}`;
}

/** @param {GameKind} game @param {string | undefined} phase */
function isLobbyPhaseJoinable(game, phase) {
  if (game === 'poker') return phase === 'lobby' || phase === 'between';
  if (game === 'uno') return phase === 'lobby' || phase === 'roundOver';
  if (game === 'connect-four') return phase === 'lobby';
  if (game === 'chess') return phase === 'lobby';
  if (game === 'tic-tac-toe') return phase === 'lobby';
  return false;
}

/**
 * @param {{
 *   game: GameKind,
 *   sessionId: string,
 *   tableName?: string,
 *   phase?: string,
 *   lobbyAccess?: unknown,
 *   role: 'host' | 'player',
 *   hostPeerId: string,
 *   playerCount?: number,
 *   maxPlayers?: number,
 * }} params
 */
function buildGamePresencePayload({
  game,
  sessionId,
  tableName,
  phase,
  lobbyAccess,
  role,
  hostPeerId,
  playerCount = 0,
  maxPlayers = 4,
}) {
  const safeMax = Math.max(2, Number(maxPlayers) || 4);
  const safeCount = Math.max(0, Number(playerCount) || 0);
  const joinable = role === 'host'
    && isLobbyPhaseJoinable(game, phase)
    && safeCount < safeMax;

  return {
    kind: GAME_PRESENCE_KIND,
    game,
    sessionId,
    tableName: String(tableName || (game === 'poker' ? 'Poker-Tisch' : game === 'connect-four' ? 'Vier-gewinnt-Tisch' : game === 'chess' ? 'Schach-Partie' : game === 'tic-tac-toe' ? 'Tic-Tac-Toe' : 'UNO-Tisch')).slice(0, 48),
    phase: phase || 'lobby',
    lobbyAccess: normalizeLobbyAccess(lobbyAccess),
    role,
    hostPeerId,
    playerCount: safeCount,
    maxPlayers: safeMax,
    joinable,
  };
}

/**
 * @param {{
 *   presence?: Record<string, unknown> | null,
 *   hostPeerId: string,
 *   sessionId: string,
 *   game: GameKind,
 *   hostOnline?: boolean,
 * }} params
 */
function isInviteSessionActive({ presence, hostPeerId, sessionId, game, hostOnline = true }) {
  if (!hostOnline || !presence) return false;
  if (presence.game !== game) return false;
  if (presence.sessionId !== sessionId) return false;
  if (presence.hostPeerId !== hostPeerId) return false;
  const playerCount = Number(presence.playerCount) || 0;
  const maxPlayers = Number(presence.maxPlayers) || 0;
  return isLobbyPhaseJoinable(game, String(presence.phase || ''))
    && playerCount < maxPlayers;
}

/**
 * @param {{
 *   presence?: Record<string, unknown> | null,
 *   gameInvites?: Set<string> | ReadonlySet<string>,
 *   hostPeerId: string,
 * }} params
 */
function canJoinGameViaPresence({ presence, gameInvites, hostPeerId }) {
  if (!presence?.joinable) return false;
  if (presence.hostPeerId !== hostPeerId) return false;
  if (presence.lobbyAccess === LOBBY_ACCESS.PUBLIC) return true;
  const key = gameInviteKey(
    /** @type {GameKind} */ (presence.game),
    hostPeerId,
    String(presence.sessionId || '')
  );
  return Boolean(gameInvites?.has(key));
}

/** @param {Record<string, unknown> | null | undefined} presence */
function formatGamePresenceLabel(presence) {
  if (!presence?.game) return '';
  const gameLabel = presence.game === 'poker'
    ? 'Poker'
    : presence.game === 'connect-four'
      ? 'Vier gewinnt'
      : presence.game === 'chess'
        ? 'Schach'
        : presence.game === 'tic-tac-toe'
          ? 'Tic-Tac-Toe'
          : 'UNO';
  const name = presence.tableName || gameLabel;
  const phase = String(presence.phase || '');

  if (presence.joinable && presence.role === 'host') {
    return `Lobby: ${name}`;
  }
  if (isLobbyPhaseJoinable(/** @type {GameKind} */ (presence.game), phase)) {
    return `Wartet auf ${gameLabel}: ${name}`;
  }
  return `Spielt ${gameLabel}: ${name}`;
}

/** @param {Record<string, unknown> | null | undefined} presence @param {number} [now] */
function isPresenceStale(presence, now = Date.now()) {
  if (!presence) return true;
  const ts = Number(presence.updatedAt ?? presence.timestamp);
  if (!Number.isFinite(ts)) return false;
  return now - ts > 90_000;
}

export {
  GAME_PRESENCE_KIND,
  GAME_PRESENCE_CLEAR_KIND,
  LOBBY_ACCESS,
  normalizeLobbyAccess,
  gameInviteKey,
  isLobbyPhaseJoinable,
  buildGamePresencePayload,
  isInviteSessionActive,
  canJoinGameViaPresence,
  formatGamePresenceLabel,
  isPresenceStale,
};
