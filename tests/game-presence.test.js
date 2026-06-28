const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const gamePresenceUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'shared', 'game-presence.js')).href;

test('game presence helpers', async () => {
  const {
    buildGamePresencePayload,
    canJoinGameViaPresence,
    gameInviteKey,
    isInviteSessionActive,
    isLobbyPhaseJoinable,
    normalizeLobbyAccess,
  } = await import(gamePresenceUrl);

  assert.equal(normalizeLobbyAccess('public'), 'public');
  assert.equal(normalizeLobbyAccess('invite'), 'invite');
  assert.equal(normalizeLobbyAccess('other'), 'invite');

  assert.equal(isLobbyPhaseJoinable('uno', 'lobby'), true);
  assert.equal(isLobbyPhaseJoinable('uno', 'playing'), false);
  assert.equal(isLobbyPhaseJoinable('poker', 'between'), true);
  assert.equal(isLobbyPhaseJoinable('poker', 'preflop'), false);
  assert.equal(isLobbyPhaseJoinable('tic-tac-toe', 'lobby'), true);
  assert.equal(isLobbyPhaseJoinable('tic-tac-toe', 'playing'), false);
  assert.equal(isLobbyPhaseJoinable('connect-four', 'lobby'), true);
  assert.equal(isLobbyPhaseJoinable('connect-four', 'playing'), false);
  assert.equal(isLobbyPhaseJoinable('chess', 'lobby'), true);
  assert.equal(isLobbyPhaseJoinable('chess', 'playing'), false);

  const payload = buildGamePresencePayload({
    game: 'uno',
    sessionId: 'g1',
    tableName: 'Test',
    phase: 'lobby',
    lobbyAccess: 'public',
    role: 'host',
    hostPeerId: 'host',
    playerCount: 1,
    maxPlayers: 4,
  });
  assert.equal(payload.joinable, true);
  assert.equal(payload.lobbyAccess, 'public');

  const presence = buildGamePresencePayload({
    game: 'poker',
    sessionId: 't1',
    phase: 'lobby',
    lobbyAccess: 'invite',
    role: 'host',
    hostPeerId: 'host',
    playerCount: 2,
    maxPlayers: 6,
  });
  const invites = new Set();
  assert.equal(canJoinGameViaPresence({ presence, gameInvites: invites, hostPeerId: 'host' }), false);
  invites.add(gameInviteKey('poker', 'host', 't1'));
  assert.equal(canJoinGameViaPresence({ presence, gameInvites: invites, hostPeerId: 'host' }), true);

  const unoPresence = buildGamePresencePayload({
    game: 'uno',
    sessionId: 'g1',
    phase: 'lobby',
    role: 'host',
    hostPeerId: 'host',
    playerCount: 2,
    maxPlayers: 4,
  });
  assert.equal(isInviteSessionActive({
    presence: unoPresence,
    hostPeerId: 'host',
    sessionId: 'g1',
    game: 'uno',
    hostOnline: true,
  }), true);
  assert.equal(isInviteSessionActive({
    presence: { ...unoPresence, phase: 'playing' },
    hostPeerId: 'host',
    sessionId: 'g1',
    game: 'uno',
    hostOnline: true,
  }), false);

  const cfPresence = buildGamePresencePayload({
    game: 'connect-four',
    sessionId: 'cf1',
    phase: 'lobby',
    role: 'host',
    hostPeerId: 'host',
    playerCount: 1,
    maxPlayers: 2,
  });
  assert.equal(cfPresence.joinable, true);
  assert.equal(cfPresence.tableName, 'Vier-gewinnt-Tisch');
  assert.equal(isInviteSessionActive({
    presence: cfPresence,
    hostPeerId: 'host',
    sessionId: 'cf1',
    game: 'connect-four',
    hostOnline: true,
  }), true);

  const chessPresence = buildGamePresencePayload({
    game: 'chess',
    sessionId: 'ch1',
    phase: 'lobby',
    role: 'host',
    hostPeerId: 'host',
    playerCount: 1,
    maxPlayers: 2,
  });
  assert.equal(chessPresence.joinable, true);
  assert.equal(chessPresence.tableName, 'Schach-Partie');
  assert.equal(isInviteSessionActive({
    presence: chessPresence,
    hostPeerId: 'host',
    sessionId: 'ch1',
    game: 'chess',
    hostOnline: true,
  }), true);
});
