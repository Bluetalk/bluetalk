// Spiel-Präsenz: Ablauf-Intervall für stale Presence und Lobby-Beitritt,
// 1:1 aus App.jsx ausgelagert.
import { useEffect, useCallback } from 'react';
import {
  canJoinGameViaPresence,
  isPresenceStale,
} from '../../../shared/game-presence.js';
import { pluginRuntime } from '../../plugins/pluginRuntime';

export function useGamePresence({ setPeerGamePresence, gameInviteKeys }) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      setPeerGamePresence((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [peerId, presence] of Object.entries(prev)) {
          if (isPresenceStale(presence)) {
            delete next[peerId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const joinGameFromPresence = useCallback(async (presence, hostPeerId) => {
    if (!presence || !hostPeerId) {
      return { ok: false, message: 'Spieldaten fehlen.' };
    }
    if (!canJoinGameViaPresence({ presence, gameInvites: gameInviteKeys, hostPeerId })) {
      return { ok: false, message: 'Diese Lobby kann derzeit nicht betreten werden.' };
    }
    const game = presence.game;
    const sessionId = presence.sessionId;
    if (!game || !sessionId) {
      return { ok: false, message: 'Die Spiel-ID fehlt.' };
    }

    const pending = game === 'poker'
      ? {
        hostPeerId,
        tableId: sessionId,
        tableName: presence.tableName || 'Poker-Tisch',
        pokerSettings: {},
      }
      : game === 'uno'
        ? {
          hostPeerId,
          gameId: sessionId,
          tableName: presence.tableName || 'UNO-Tisch',
          unoSettings: {},
        }
        : game === 'connect-four'
          ? {
            hostPeerId,
            gameId: sessionId,
            tableName: presence.tableName || 'Vier-gewinnt-Tisch',
            connectFourSettings: {},
          }
          : game === 'chess'
            ? {
              hostPeerId,
              gameId: sessionId,
              tableName: presence.tableName || 'Schach-Partie',
              chessSettings: {},
            }
            : game === 'tic-tac-toe'
              ? {
                hostPeerId,
                gameId: sessionId,
                tableName: presence.tableName || 'Tic-Tac-Toe',
                ticTacToeSettings: {},
              }
              : null;
    if (!pending) {
      return { ok: false, message: 'Dieses Spiel wird nicht unterstützt.' };
    }

    window.location.hash = '#/games';
    const response = await pluginRuntime.invokePluginCommand(game, 'join', pending);
    if (!response?.ok) {
      return {
        ok: false,
        message: response?.error === 'not_active'
          ? 'Aktiviere dieses Spiel zuerst unter Erweiterungen.'
          : response?.error === 'unknown_command'
            ? 'Das Spiele-Plugin ist veraltet. Bitte stelle es unter Erweiterungen auf Standard zurück.'
            : response?.error || 'Beitritt fehlgeschlagen.',
      };
    }
    return response.result?.ok === false ? response.result : { ok: true };
  }, [gameInviteKeys]);

  return { joinGameFromPresence };
}
