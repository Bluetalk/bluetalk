# UI Registration

Plugins extend the BlueTalk UI by registering tabs, screens, commands, and composer attachments.

## Sidebar tabs

```javascript
api.ui.registerTab({
  id: 'dashboard',
  label: 'Dashboard',
  icon: 'Sparkles',   // Lucide icon name
  order: 50,          // lower = higher in sidebar
  render(container, ctx) {
    container.innerHTML = '<p>Hello</p>';
    return () => {
      // optional cleanup on unmount
    };
  },
});
```

Tabs appear at `/plugin/<pluginId>:<tabId>`.

> **Note:** Game plugins cannot register sidebar tabs — they appear in the built-in **Spiele** tab instead.

## Screens (modals)

```javascript
api.ui.registerScreen({
  id: 'settings',
  title: 'Plugin Settings',
  render(container, ctx) {
    container.textContent = 'Settings here';
  },
});

api.ui.openScreen('settings', { foo: 'bar' });
api.ui.closeScreen();
```

## Commands

Register imperative commands callable from other code:

```javascript
api.ui.registerCommand('refresh', () => {
  return { updated: Date.now() };
});

// From same plugin:
await api.ui.invokeCommand('refresh');
```

Cross-plugin: `api.invokePluginCommand('other-plugin', 'refresh')`

Main process commands: `api.registerCommand` in `main.js`, invoked via `api.invokeMainCommand`.

## Icons

Use any [Lucide](https://lucide.dev) icon name as a string (e.g. `'Plug'`, `'Sparkles'`, `'Gamepad2'`).

## Game launcher commands

Game plugins register these commands instead of tabs:

| Command | Purpose |
|---------|---------|
| `launcherState` | Return `{ canLaunchNew, canResume, hasOpenWindow, label }` |
| `launchNew` | Start a new game session |
| `launchResume` | Resume saved session |
| `openWindow` | Open dedicated game window |

See [Game Plugins](/docs/game-plugins).
