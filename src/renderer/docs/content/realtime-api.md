# Realtime API

The realtime API provides **rooms**, **member tracking**, and **host-authoritative shared documents** for collaborative plugin features — such as live document editing, shared whiteboards, or session sync.

Available as `api.realtime` in both `ui.js` and `main.js`.

## Quick start

```javascript
// Host creates a room
const room = api.realtime.createRoom({
  roomId: 'optional-custom-id',
  name: 'Shared Notes',
  access: 'public',   // or 'invite'
  maxPeers: 10,
});

// Listen for room messages
room.on('message', ({ from, payload }) => {
  console.log('from', from, payload);
});

// Broadcast to all room members
room.broadcast({ type: 'cursor', pos: 42 });

// Shared document (host-authoritative)
const doc = room.createDocument({ docId: 'main', initial: '' });
doc.on('change', ({ state, revision, origin }) => {
  textarea.value = state;
});

// Client joins
const joined = await api.realtime.joinRoom({
  roomId: 'room-id',
  hostPeerId: 'host-peer-id',
});
```

## Manager API

| Method | Description |
|--------|-------------|
| `createRoom(opts)` | Create and host a room |
| `joinRoom({ roomId, hostPeerId, name })` | Join remote room (returns Promise) |
| `listRooms()` | List local active rooms |
| `getRoom(roomId)` | Get room instance or null |
| `on(event, handler)` | Manager-level events |

### Manager events

| Event | Payload |
|-------|---------|
| `room-discovered` | `{ roomId, hostPeerId, name, memberCount }` |
| `room-invite` | `{ roomId, hostPeerId, name, from }` |
| `room-closed` | `{ roomId, hostPeerId }` |

## Room API

| Method | Description |
|--------|-------------|
| `broadcast(payload)` | Send to all members |
| `sendTo(peerId, payload)` | Send to one member |
| `invite(peerId)` | Send join invite |
| `createDocument(opts)` | Create shared document |
| `getDocument(docId)` | Get existing document |
| `leave()` | Leave or close room |
| `on(event, handler)` | Room events |

### Room events

| Event | Payload |
|-------|---------|
| `message` | `{ from, payload }` |
| `peer-joined` | `{ peerId, name }` |
| `peer-left` | `{ peerId }` |
| `joined` | Client: `{ roomId, members }` |
| `join-rejected` | `{ reason }` |
| `closed` | `{ roomId, reason? }` |

### Room options

| Option | Default | Description |
|--------|---------|-------------|
| `roomId` | auto UUID | Custom room identifier |
| `name` | `"Room"` | Display name |
| `access` | `"invite"` | `"public"` or `"invite"` |
| `maxPeers` | `16` | Maximum members (2–64) |

**Public rooms** broadcast presence for discovery via `room-discovered` events.

**Invite-only rooms** require `room.invite(peerId)` before the peer can join.

## Shared documents

Host-authoritative state with revision tracking:

```javascript
const doc = room.createDocument({ docId: 'main', initial: 'Hello' });

// Host: set full state
doc.setState('Hello world');

// Anyone: apply text operation (clients forward to host)
doc.applyOp({ type: 'insert', pos: 5, text: ' beautiful' });
doc.applyOp({ type: 'delete', pos: 0, len: 6 });
doc.applyOp({ type: 'replace', value: 'New content' });

// Arbitrary set
doc.applyOp({ type: 'set', value: { items: [1, 2, 3] } });

doc.getState();
doc.getRevision();

doc.on('change', ({ state, revision, origin }) => {
  // origin: 'local' | 'remote'
});
doc.on('remote-op', ({ from, payload }) => { ... });
```

Stale operations (wrong `baseRevision`) are rejected by the host. The host sends a fresh `doc-sync` to correct desynchronized clients.

## Wire protocol

All realtime traffic uses:

```javascript
{
  kind: 'plugin-realtime',
  pluginRealtime: {
    pluginId: 'my-plugin',
    roomId: 'uuid',
    wire: 'room-msg' | 'doc-op' | 'doc-sync' | ...,
    revision: 42,       // optional
    payload: { ... }
  }
}
```

These messages are **not** stored in chat history or shown as notifications.

## Collaborative text example

```javascript
const room = api.realtime.createRoom({ name: 'Editor', access: 'invite' });
const doc = room.createDocument({ docId: 'text', initial: '' });

const textarea = document.createElement('textarea');
textarea.addEventListener('input', () => {
  if (room.info.isHost) {
    doc.setState(textarea.value);
  }
});

doc.on('change', ({ state, origin }) => {
  if (origin === 'remote') textarea.value = state;
});

// Invite a contact
room.invite(contactPeerId);
```

For fine-grained collaborative editing, send incremental ops instead of full state:

```javascript
textarea.addEventListener('input', (e) => {
  const pos = textarea.selectionStart;
  doc.applyOp({ type: 'insert', pos, text: e.data || '' });
});
```

## Cleanup

Rooms are automatically closed when the plugin is disabled. Always call `room.leave()` when your UI unmounts:

```javascript
api.onDeactivate(() => {
  room.leave();
});
```

## Limitations (v1)

- **Host-authoritative** — no CRDT/Yjs; host is single source of truth
- **Full mesh required** — all peers must connect directly
- **No persistence** — documents live in memory; persist via `api.storage` if needed
- **Text ops** — built-in insert/delete/replace for strings; use `type: 'set'` for JSON
