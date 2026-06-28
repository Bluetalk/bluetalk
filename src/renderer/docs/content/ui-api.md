# UI (Renderer) API

Available as `BlueTalkPlugin` or `plugin` in `ui.js`.

## Storage

Scoped to `localStorage` under `bt.plugin.<pluginId>.<key>`:

```javascript
api.storage.get(key, defaultValue)
api.storage.set(key, value)
api.storage.delete(key)
```

## Events

```javascript
api.on('peer:message', (msg) => { ... })
api.on('peer:connected', (data) => { ... })
api.on('peer:disconnected', (data) => { ... })
api.on('plugin:message', (payload) => { ... })  // from main.js
api.on('peers:list-sync', (list) => { ... })
api.on('app:data-cleared', () => { ... })
```

Returns an unsubscribe function.

## Snapshots

Read-only snapshots of host state:

```javascript
api.peers()
api.contacts()
api.messages(peerId)
```

## Peer networking

```javascript
api.peer.info()
api.peer.list()
api.peer.send(peerId, data)
api.peer.sendMany(peerIds, data)
api.peer.broadcast(data)
api.peer.connect(address)
api.peer.disconnect(peerId)
api.peer.refreshDiscovery()
```

## Chat

Send through the app's E2EE pipeline (persisted in chat history):

```javascript
api.chat.send(peerId, payload)
api.chat.delete(peerId, messageId)
api.chat.deleteChat(peerId)
```

## Contacts

```javascript
api.contactsApi.list()
api.contactsApi.update(patch)
api.contactsApi.remove(contactId)
api.contactsApi.setBlocked(contactId, blocked)
api.contactsApi.setNickname(contactId, nickname)
api.contactsApi.setPinned(contactId, pinned)
```

## Notifications

```javascript
api.notify.show({ title, body })   // native OS notification
api.notify.toast({ variant, title, message })  // in-app toast
```

## UI registration

See [UI Registration](/docs/ui-registration) for tabs, screens, commands, and composer attachments.

## Main ↔ UI bridge

```javascript
api.sendToMain(payload)
api.invokeMainCommand(commandId, args)
```

## Cross-plugin commands

```javascript
api.invokePluginCommand(otherPluginId, commandId, args)
```

Only works for currently active plugins in the renderer.

## Realtime

```javascript
const room = api.realtime.createRoom({ name: 'Notes', access: 'public' });
const joined = await api.realtime.joinRoom({ roomId, hostPeerId });
api.realtime.on('room-discovered', (info) => { ... });
```

See [Realtime API](/docs/realtime-api).

## Timers & lifecycle

```javascript
api.timer.setTimeout(fn, ms)
api.timer.setInterval(fn, ms)
api.onDeactivate(() => { /* cleanup */ })
```

## React helpers

When available:

```javascript
api.React
api.ReactDOM
```

## Metadata

```javascript
api.pluginId   // plugin id string
api.manifest   // copy of manifest.json
api.log        // { info, warn, error }
```
