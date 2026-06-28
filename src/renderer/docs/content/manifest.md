# Manifest Reference

Every plugin requires a `manifest.json` in its root folder.

## Required fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique slug; must match folder name (`a-z0-9_.-`, max 64 chars) |
| `name` | string | Display name |
| `version` | string | Semver string used for bundled plugin updates |
| `description` | string | Short description |
| `author` | string | Author name |

## Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `main` | string | `"main.js"` | Main-process entry file |
| `ui` | string | `"ui.js"` | Renderer entry file |
| `permissions` | string[] | `[]` | Informational only (not enforced) |
| `autoEnable` | boolean | `true` | Enable on first install |
| `debugOnly` | boolean | `false` | Only visible when debug mode is on |
| `game` | boolean \| object | — | Mark as game plugin (see [Game Plugins](/docs/game-plugins)) |

## Game object fields

When `game` is an object:

| Field | Type | Description |
|-------|------|-------------|
| `mark` | string | Emoji or icon mark shown in Spiele tab |
| `title` | string | Game title override |
| `description` | string | Game description override |
| `alphaNotice` | string | Optional alpha warning text |
| `labels` | object | `{ launchNew, launchResume, openWindow }` button labels |
| `tag` | string | Optional badge tag |

## Example

```json
{
  "id": "my-notes",
  "name": "Shared Notes",
  "version": "1.0.0",
  "description": "Collaborative notes over P2P",
  "author": "Developer",
  "permissions": ["realtime"],
  "main": "main.js",
  "ui": "ui.js"
}
```

## Bundled plugins

BlueTalk ships reference plugins in `assets/bundled-plugins/`. On startup, newer bundled versions are copied to the user plugins folder unless the user removed them.
