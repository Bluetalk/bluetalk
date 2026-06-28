# Main Process API

Available as `bluetalk` or `api` in `main.js` (Node VM sandbox).

## Storage

Namespaced under `plugins.data.<pluginId>.*` in the app store.

```javascript
api.store.get(key, defaultValue)
api.store.set(key, value)    // returns true
api.store.delete(key)        // returns true
```

## Peer networking

```javascript
api.peer.info()                        // local peer info
api.peer.list()                        // connected peers
api.peer.send(peerId, data)            // unicast JSON message
api.peer.sendMany(peerIds, data)       // multicast to specific peers
api.peer.broadcast(data)               // all connected peers
api.peer.connect(address)              // connect to host:port
api.peer.disconnect(peerId)
api.peer.refreshDiscovery()
```

Messages are plain JSON objects. Use a `kind` field to namespace your protocol.

## Contacts

Direct read/write access to the contacts store:

```javascript
api.contacts.list()
api.contacts.update({ id, ...patch })
api.contacts.remove(id)
api.contacts.block(id)
api.contacts.unblock(id)
```

## Messages

Direct access to stored chat messages (not E2EE-decrypted pipeline):

```javascript
api.messages.list(peerId)
api.messages.append(peerId, message)
api.messages.patch(peerId, messageId, patch)
api.messages.delete(peerId, messageId)
```

## Events

Subscribe to peer lifecycle events:

```javascript
const off = api.events.on('peer:message', (msg) => { ... });
// Also: peer:connected, peer:disconnected, peer:file-offered,
//       peer:file-received, peer:discovered
off(); // unsubscribe
```

## Notifications

```javascript
api.notify.show({
  title: 'Title',
  body: 'Body text',
  silent: false,
  allowInForeground: false,
});
```

## Timers

Sandbox-safe timers (cleared on plugin deactivate):

```javascript
api.timer.setTimeout(fn, ms, ...args)
api.timer.setInterval(fn, ms, ...args)
api.timer.clearTimeout(handle)
api.timer.clearInterval(handle)
```

## Commands

Register commands callable from the renderer:

```javascript
api.registerCommand('myCommand', (args) => {
  return { ok: true };
});
```

Invoke from UI: `api.invokeMainCommand('myCommand', args)`

## Main ↔ UI bridge

```javascript
api.postToUi(payload)  // sends plugins:message to renderer
```

Handle in UI via `api.on('plugin:message', handler)`.

UI sends to main via `api.sendToMain(payload)` → `onUiMessage` in main lifecycle.

## Realtime

See [Realtime API](/docs/realtime-api). Available on main process when `main.js` is present:

```javascript
const room = api.realtime.createRoom({ name: 'Session' });
api.realtime.on('room-discovered', (info) => { ... });
```

## Logging

```javascript
api.log.info(...args)
api.log.warn(...args)
api.log.error(...args)
```

## Lifecycle exports

```javascript
module.exports = (api) => {
  // setup
  return {
    deactivate() { /* cleanup */ },
    onUiMessage(payload) { /* from ui.js */ },
  };
};

// Or:
module.exports = {
  activate(api) { },
  deactivate() { },
  onUiMessage(payload) { },
};
```
