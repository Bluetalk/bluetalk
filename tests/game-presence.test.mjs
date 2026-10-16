import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canJoinGameViaPresence,
  gameInviteKey,
  presenceFromInvite,
} from '../src/shared/game-presence.js';

test('Poker-Einladung wird zur beitretbaren Lobby', () => {
  const presence = presenceFromInvite({
    kind: 'poker-invite',
    tableId: 'T1',
    tableName: 'Runde',
    hostPeerId: 'HOST',
    pokerSettings: { maxPlayers: 6 },
    lobbyAccess: 'invite',
  }, 'HOST', 1000);
  assert.equal(presence.game, 'poker');
  assert.equal(presence.sessionId, 'T1');
  assert.equal(presence.maxPlayers, 6);
  assert.equal(presence.updatedAt, 1000);
  const invites = new Set([gameInviteKey('poker', 'HOST', 'T1')]);
  assert.equal(canJoinGameViaPresence({ presence, gameInvites: invites, hostPeerId: 'HOST' }), true);
  assert.equal(canJoinGameViaPresence({ presence, gameInvites: new Set(), hostPeerId: 'HOST' }), false);
});

test('Andere Spiele nutzen gameId; unvollständige Einladungen werden ignoriert', () => {
  const chess = presenceFromInvite({ kind: 'chess-invite', gameId: 'G1', tableName: 'x', lobbyAccess: 'public' }, 'H');
  assert.equal(chess.game, 'chess');
  assert.equal(chess.hostPeerId, 'H');
  assert.equal(chess.lobbyAccess, 'public');
  assert.equal(presenceFromInvite({ kind: 'chess-invite' }, 'H'), null);
  assert.equal(presenceFromInvite({ kind: 'chat' }, 'H'), null);
});
