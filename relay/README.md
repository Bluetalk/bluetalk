# BlueTalk Cloud Relay

Offener Vermittler für **Cloud-Nachrichten** zwischen BlueTalk-Clients.
Der Relay ist absichtlich dumm: Er prüft die Anmeldung, kennt Peer-IDs und
leitet Bytes weiter. Klartext von Chats, Spielen oder Dateien sieht er nie.

Protokoll (Nachrichtentypen, Limits, Auth): [`PROTOCOL.md`](PROTOCOL.md).
Cloud-Konten, verschlüsselter Sync und BlueTalk Web: [`ACCOUNTS.md`](ACCOUNTS.md).

## Sicherheitsmodell

| Der Relay sieht | Der Relay sieht nicht |
|---|---|
| Peer-IDs von Absender und Empfänger | Chat-Klartext, Dateiinhalte, Spielzüge |
| Zeitpunkte und Größen | Private Schlüssel, Passwörter, Tresore |
| IP-Adressen der Verbindungen | Inhalt der Live-Tunnel (Peer-Protokoll v2, E2E) |
| Opake Postfach-JSON-Blobs | Den Postfach-Klartext (Renderer-E2EE) |
| Benutzernamen, Peer-IDs der Konten | Sync-Klartext (Client-seitig AES-GCM) |

- **Live-Tunnel:** Zwei angemeldete Clients tunneln ihr normales Peer-Protokoll
  v2 durch den Relay. Der Handshake authentifiziert beide Seiten Ende-zu-Ende —
  der Relay kann sich nicht unbemerkt dazwischenschalten.
- **Postfach:** Ist der Empfänger offline, legt der Absender bereits
  verschlüsselte Chat-Nachrichten ab. Der Relay speichert sie opak bis zur
  Abholung (TTL 30 Tage, Quoten siehe PROTOCOL.md).
- **Cloud-Konto:** Benutzername + `authKey` (aus dem Passwort abgeleitet). Der
  Server speichert nur `SHA-256(authKey)` und den verschlüsselten Tresor.
  Passwort und Schlüssel verlassen das Gerät nie im Klartext.

TLS macht ein Reverse-Proxy davor, nicht dieser Prozess (kein OpenSSL).

## Selbst hosten

Der Docker-Build-Kontext ist das **Repo-Root** (Relay + BlueTalk Web).

### Docker Compose (empfohlen)

```bash
# im Repo-Root
docker compose -f relay/docker-compose.yml up -d --build

# oder:
cd relay
docker compose up -d --build
```

Daten liegen im Volume `relay-data` (`/data/relay.db`). Healthcheck läuft über
`bluetalk-relay healthcheck` (HTTP `GET /healthz`). BlueTalk Web liegt unter
`/` (`WEB_DIR=/srv/web`), die Infoseite unter `/info`.

Konten abschalten (reiner Relay): `ACCOUNTS_ENABLED=0`.

### Nur Docker

```bash
# im Repo-Root
docker build -f relay/Dockerfile -t bluetalk-relay .
docker run --rm -p 8080:8080 -v bluetalk-relay-data:/data \
  -e TRUST_PROXY=1 -e CLIENT_IP_HEADER=cf-connecting-ip \
  -e PUBLIC_HOST=bt.example.com bluetalk-relay
```

### Reverse-Proxy

Vor den Relay gehört ein Proxy mit **TLS** und **WebSocket-Upgrade** für
`/v1/ws` (z. B. Caddy, nginx, Traefik). Ohne Upgrade bleiben Verbindungen nicht
stehen. Hinter Cloudflare: `CLIENT_IP_HEADER=cf-connecting-ip`. Hinter einem
einzelnen vertrauenswürdigen Proxy: `TRUST_PROXY=1` (letztes
`X-Forwarded-For`-Element).

In der BlueTalk-App kannst du unter **BlueTalk Cloud** eine eigene
Relay-URL eintragen (`wss://dein.server/v1/ws`).

Quellcode: <https://github.com/Bluetalk/bluetalk>

## Umgebung

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket-Port |
| `DATA_DIR` | `/data` | SQLite (`relay.db`) |
| `PUBLIC_HOST` | – | Erwarteter Host in der Auth-Signatur |
| `TRUST_PROXY` | `0` | `1` = letztes `X-Forwarded-For`-Element als Client-IP |
| `CLIENT_IP_HEADER` | – | Header mit der echten Client-IP (z. B. `cf-connecting-ip`); hat Vorrang |
| `MAX_CONNECTIONS_PER_IP` | `32` | Verbindungen pro IP |
| `WEB_DIR` | `/srv/web` | Gebautes BlueTalk Web; fehlt `index.html` → Infoseite unter `/` |
| `SYNC_QUOTA_BYTES` | `268435456` | Sync-Speicher pro Konto (256 MiB) |
| `ACCOUNTS_ENABLED` | `1` | `0` = Konto-/Sync-API aus |
| `RUST_LOG` | `info` | Log-Level (`tracing`) |

Logs enthalten keine Nachrichteninhalte, Tresore oder Tokens — nur gekürzte
Peer-IDs, Benutzernamen, Größen und Codes.

## Lokal bauen

Eigenständiges Crate, nicht Teil des `src-tauri`-Workspace:

```bash
cd relay
cargo test
cargo run
```

HTTP:

- `GET /` — BlueTalk Web oder Infoseite
- `GET /info` — Infoseite
- `GET /healthz` — `ok`
- `GET /v1/info` — Name, Version, Protokoll, Online-Zahl
- `GET /v1/ws` — WebSocket
- `/v1/account/*`, `/v1/sync/*` — siehe [`ACCOUNTS.md`](ACCOUNTS.md)
