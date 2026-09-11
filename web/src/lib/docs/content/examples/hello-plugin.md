# Hello Plugin Walkthrough

The bundled **hello** plugin demonstrates core API features.

Location: `assets/bundled-plugins/hello/`

## What it does

- Registers a sidebar tab **Hello Feed**
- Logs peer events in the UI
- Broadcasts a `plugin-hello-ping` message to all peers
- Registers an example screen dialog
- Main process command `ping-peers`

## UI tab registration

```javascript
api.ui.registerTab({
  id: 'feed',
  label: 'Hello Feed',
  icon: 'Sparkles',
  order: 50,
  render(container) {
    // Build UI, subscribe to events
    const off = api.on('peer:message', (msg) => {
      if (msg.kind === 'plugin-hello-ping') addLog(`Ping from ${msg.from}`);
    });
    return () => off();
  },
});
```

## Ping peers button

```javascript
api.peer.broadcast({
  kind: 'plugin-hello-ping',
  message: 'Hello from plugin!',
});
```

Or invoke the main-process command:

```javascript
await api.invokeMainCommand('ping-peers');
```

## Example screen

```javascript
api.ui.registerScreen({
  id: 'example',
  title: 'Hello Screen',
  render(container) {
    container.innerHTML = '<p>Modal content</p>';
  },
});

api.ui.openScreen('example');
```

## Main process

```javascript
module.exports = (api) => {
  api.registerCommand('ping-peers', () => {
    api.peer.broadcast({ kind: 'plugin-hello-ping', from: 'main' });
    return { ok: true };
  });
};
```

## Extending with realtime

To add collaborative features, see [Realtime API](/docs/realtime-api):

```javascript
const room = api.realtime.createRoom({ name: 'Hello Room', access: 'public' });
room.on('message', ({ from, payload }) => {
  console.log('Room message', from, payload);
});
room.broadcast({ type: 'hello', text: 'Welcome!' });
```

## Try it

1. Enable the hello plugin in **Erweiterungen**
2. Open the **Hello Feed** tab in the sidebar
3. Connect to another peer and click **Ping peers**
