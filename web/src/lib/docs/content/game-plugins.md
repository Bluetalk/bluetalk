# Game Plugins

Mark a plugin as a game in `manifest.json`:

```json
{
  "id": "poker",
  "game": {
    "mark": "♠",
    "title": "Poker",
    "description": "Texas Hold'em over P2P",
    "labels": {
      "launchNew": "New table",
      "launchResume": "Resume",
      "openWindow": "Open table"
    }
  }
}
```

Or simply `"game": true` for defaults.

## Behavior

- **No sidebar tab** — appears in **Spiele** (`/games`)
- **Launcher commands** required for integration
- **P2P wire protocol** with host-authoritative state

## Launcher commands

```javascript
api.ui.registerCommand('launcherState', () => ({
  canLaunchNew: true,
  canResume: Boolean(savedSession),
  hasOpenWindow: false,
  label: savedSession ? 'Resume table' : 'New table',
}));

api.ui.registerCommand('launchNew', () => {
  // create host session, open game UI
});

api.ui.registerCommand('launchResume', () => {
  // restore from api.storage
});

api.ui.registerCommand('openWindow', () => {
  // open dedicated BrowserWindow via window.bluetalk.poker.openGameWindow etc.
});
```

## Wire protocol pattern

Games use a consistent envelope:

```javascript
api.peer.send(peerId, {
  kind: 'poker',
  poker: { wire: 'action', action: { type: 'fold' } },
});
```

| Wire | Direction | Purpose |
|------|-----------|---------|
| `join` | Client → Host | Request to join |
| `join_ok` / `join_reject` | Host → Client | Join response |
| `action` | Client → Host | Player action |
| `state` | Host → All | Public game state |
| `hole` / `hand` | Host → Client | Private cards |
| `leave` | Both | Leave session |

## Presence & invites

- **Chat invites:** `{ kind: 'poker-invite', tableId, hostPeerId, ... }`
- **Lobby presence:** `{ kind: 'game-presence', game, sessionId, joinable, ... }`

## Game windows

Dedicated game UIs open in separate Electron windows with IPC bridges (`pushState`, `fromChild`). Currently hardcoded per game (`poker`, `uno`, etc.). For new plugins, embed the game UI in a tab/screen or follow the existing game window pattern in the main process.

## Realtime alternative

For simpler multiplayer experiences, consider the [Realtime API](/docs/realtime-api) instead of implementing a full wire protocol.
