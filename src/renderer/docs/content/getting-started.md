# Getting Started

BlueTalk plugins are local folders installed under your user data directory. Each plugin can run code in two places:

- **Main process** (`main.js`) — Node VM sandbox with access to persistent store, peers, and contacts.
- **Renderer** (`ui.js`) — executed in the browser context with UI registration, chat, and realtime APIs.

## Folder layout

```
my-plugin/
  manifest.json    # required
  main.js          # optional — main-process entry
  ui.js            # optional — renderer entry
```

Install plugins via **Settings → Erweiterungen → Install from folder**, or copy into `<userData>/plugins/<id>/`.

## Minimal plugin

**manifest.json**

```json
{
  "id": "hello",
  "name": "Hello Plugin",
  "version": "1.0.0",
  "description": "A minimal example",
  "author": "You"
}
```

**ui.js**

```javascript
BlueTalkPlugin.ui.registerTab({
  id: 'main',
  label: 'Hello',
  icon: 'Sparkles',
  render(container) {
    container.textContent = 'Hello from a plugin!';
  },
});
```

## Lifecycle

### Main process

Export a function or object from `main.js`:

```javascript
module.exports = (api) => {
  api.log.info('Plugin activated');

  return {
    deactivate() {
      api.log.info('Plugin deactivated');
    },
    onUiMessage(payload) {
      // Messages from ui.js via api.sendToMain()
    },
  };
};
```

### Renderer

`ui.js` runs immediately when the plugin is enabled. Register tabs, screens, or commands at top level. Use `api.onDeactivate(fn)` for cleanup.

## Limits

- Maximum **250 files** per plugin
- Maximum **25 MB** total size
- Plugin `id` must match the folder name (slug: `a-z0-9_.-`)

## Next steps

- [Manifest Reference](/docs/manifest) — all manifest fields
- [UI API](/docs/ui-api) — renderer-facing API
- [Realtime API](/docs/realtime-api) — collaborative rooms and documents
