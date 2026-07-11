# BlueTalk v2

Peer-to-peer Messenger, komplett neu aufgebaut: modulares **Rust**-Backend mit
**Tauri 2**, React-Frontend, verschlüsselte Persistenz und ein authentifiziertes,
transportverschlüsseltes Peer-Protokoll.

## Architektur

```
BlueTalkv2/
├── src/                      # React-Frontend (Vite)
│   ├── bridge/bluetalkBridge.js   # window.bluetalk → Tauri-Commands/-Events
│   └── renderer/                  # Seiten, Komponenten, Plugin-Runtime
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                 # App-Aufbau, Command-Registrierung
│   │   ├── state.rs               # AppState (DB, Pfade, Updater)
│   │   ├── database.rs            # AES-256-GCM-verschlüsselte SQLite-KV/Messages
│   │   ├── crypto.rs              # Schlüssel im OS-Keyring
│   │   ├── peer_service.rs        # Event-Mapping, Dateitransfer, Auto-Reconnect
│   │   ├── plugin_manager.rs      # Plugin-Lifecycle (mehrdateifähig, Permissions)
│   │   ├── plugin_service.rs      # Seeding, Events, Command-Anbindung
│   │   ├── ai/                    # Ollama-Runtime, Modelle, Agent-Tools
│   │   ├── tray.rs                # Tray + Minimize-to-Tray
│   │   ├── updater.rs             # Autoupdate (signierte Artefakte)
│   │   └── commands/              # Tauri-Command-Schicht (require_main-gated)
│   ├── network-core/              # Eigenständiges Crate: Peer-Protokoll v2
│   └── capabilities/              # Fenster-Berechtigungen (main / game-windows)
└── assets/bundled-plugins/        # Mitgelieferte Plugins (Spiele, Docs, …)
```

### Peer-Protokoll v2 (`network-core`)

- Identität: Ed25519; Peer-ID = `bt2_<sha256(pubkey)>`
- Handshake: signierter ephemerer X25519-Austausch, transcript-gebunden
- Transport: ChaCha20-Poly1305-Records mit Sequenznummern (Replay-sicher)
- Discovery: signierte UDP-Broadcasts (Port 41235), Replay-Cache
- Chat-Inhalte sind zusätzlich Ende-zu-Ende-verschlüsselt (ECDH-P256 → AES-GCM,
  im Renderer wie in v1) — Transport- und E2E-Schicht sind unabhängig.
- v1-Kompatibilität: bewusst **nicht** verbindbar (unauthentifiziertes
  Klartext-Protokoll); v1-Discovery kann nur angezeigt werden (`legacy.rs`).

### Sicherheit

- Alle Commands prüfen das aufrufende Fenster (`require_main` u. ä.)
- Capabilities pro Fenster: Spiel-/Docs-Fenster sind event-only plus minimale
  Command-Liste; strikte CSP ohne `unsafe-eval`/Remote-Quellen
- Datenbank verschlüsselt (AES-256-GCM, Schlüssel im Windows-Keyring)
- Drittanbieter-Plugin-Code wird nie im privilegierten Webview ausgeführt
- Kein lokaler REST-API-Server mehr (v1-Feature, Angriffsfläche entfernt)

## Entwicklung

```powershell
npm install
npm run desktop:dev    # Vite + Tauri (Debug)
npm run check          # JS-Tests + Frontend-Build + Rust-Tests
```

## Release (mit Autoupdate)

Signierte Updater-Artefakte; der Updater-Endpoint zeigt auf
`https://github.com/Bluetalk/bluetalk/releases/latest/download/latest.json`.

Lokal:

```powershell
./scripts/release.ps1   # nutzt %USERPROFILE%\.tauri\bluetalk-v2.key (+ DPAPI-Passwort)
```

CI: Tag `v*` pushen — `.github/workflows/release-build.yml` baut, signiert und
veröffentlicht Installer, `.sig` und `latest.json` am GitHub-Release.
Benötigte Secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
