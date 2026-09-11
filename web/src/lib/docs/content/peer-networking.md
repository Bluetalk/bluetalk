# Peer Networking

BlueTalk uses a **peer-to-peer WebSocket mesh** managed in the main process. Plugins send JSON messages over persistent connections discovered via UDP LAN broadcast.

## Message format

All plugin messages are JSON objects sent through `api.peer.send` or `api.peer.broadcast`. The transport wraps them as WebSocket frames with a timestamp.

Use a **`kind`** field to namespace your protocol:

```javascript
api.peer.send(peerId, {
  kind: 'my-plugin',
  myPlugin: { action: 'hello' },
});
```

Built-in kinds (filtered from chat notifications):

- `chat`, `encrypted-chat-e2ee` — chat messages
- `poker`, `uno`, `connect-four`, `chess` — game wire protocol
- `plugin-realtime` — realtime rooms (see [Realtime API](/docs/realtime-api))
- `game-presence`, `user-presence` — presence broadcasts

## Send methods

| Method | Use case |
|--------|----------|
| `peer.send(peerId, data)` | Single peer unicast |
| `peer.sendMany(peerIds, data)` | Specific peer list (e.g. room members) |
| `peer.broadcast(data)` | All connected peers |

## Receiving messages

```javascript
api.on('peer:message', (msg) => {
  const from = msg.from;
  if (msg.kind === 'my-plugin') {
    // handle
  }
});
```

## Connection lifecycle

```javascript
api.on('peer:connected', ({ peerId }) => { ... });
api.on('peer:disconnected', ({ peerId }) => { ... });
api.on('peer:discovered', (info) => { ... });
```

## Discovery & connection

```javascript
api.peer.connect('192.168.1.10:8080');
api.peer.refreshDiscovery();
api.peer.disconnect(peerId);
```

## Design recommendations

1. **Namespace by `kind`** — avoids collisions with chat and other plugins
2. **Host authority** — one peer owns state; others send actions (see game plugins)
3. **Use realtime API** — for multi-peer sessions instead of raw message routing
4. **Chat for invites** — persist invitations via `api.chat.send` with a custom kind

## Topology

BlueTalk assumes a **full mesh** — each peer connects directly to others. There is no relay server. All peers must be reachable on the LAN or via configured addresses.
