# BlueTalk Cloud Relay — Protokoll v1

Der Relay ist ein **dummer, zugangsgeschützter Vermittler**. Er sieht nie
Klartext:

- **Live-Tunnel**: Zwei BlueTalk-Clients tunneln ihr normales Peer-Protokoll v2
  (signierter X25519-Handshake + ChaCha20-Poly1305-Records, siehe
  `src-tauri/network-core`) durch den Relay. Der Relay leitet nur Bytes weiter.
  Chats, Spiele, Dateien funktionieren damit über das Internet genau wie im LAN.
- **Postfach** (Store-and-Forward): Ist der Empfänger offline, kann ein Client
  bereits Ende-zu-Ende-verschlüsselte Chat-Nachrichten (Renderer-E2EE,
  ECDH-P256 → AES-GCM) ablegen. Der Relay speichert sie opak bis zur Abholung.

Metadaten, die der Relay zwangsläufig sieht: Peer-IDs von Absender/Empfänger,
Zeitpunkte, Größen, IP-Adressen.

## Transport

- WebSocket, Standard-Endpunkt: `wss://bt.henny.dev/v1/ws`
- **Textframes** = JSON-Steuernachrichten (`{"t": "<typ>", ...}`), max. 128 KiB.
- **Binärframes** = Tunnel-Daten: `[u32 big-endian tunnelId][payload]`,
  Payload max. 64 KiB.
- Unbekannte Felder werden ignoriert, unbekannte `t` mit
  `{"t":"error","code":"unknown_type"}` beantwortet (Verbindung bleibt offen).
- Keepalive: WebSocket-Ping alle 25 s (beide Seiten). Ohne Lebenszeichen
  60 s → Verbindung wird geschlossen.

## Peer-ID

`peerId = "bt2_" + hex(sha256(ed25519PublicKey))` — identisch zu
`NetworkIdentity::peer_id()` in `network-core`.

## 1. Anmeldung (Challenge-Response)

```
S→C {"t":"hello","v":1,"nonce":"<base64 32 Byte>","server":"bluetalk-relay/<version>"}
C→S {"t":"auth","publicKey":"<base64 32 Byte>","signature":"<base64 64 Byte>",
     "name":"<Anzeigename, optional, ≤64 Zeichen>","client":"BlueTalk/2.2.0"}
S→C {"t":"ready","peerId":"bt2_…","time":<unix ms>,
     "limits":{"maxFrame":65536,"maxMailBody":65536,"maxTunnels":64}}
```

Signiert (Ed25519) werden die UTF-8-Bytes von

```
"bluetalk-relay-auth-v1\n" + nonce + "\n" + host
```

`nonce` ist der Base64-String exakt wie empfangen; `host` ist der Host (klein,
mit `:port` falls nicht Standardport) aus der URL, die der Client geöffnet hat,
z. B. `bt.henny.dev`. Der Server prüft gegen `PUBLIC_HOST` (falls gesetzt),
sonst gegen den `Host`-Header.

- Kein gültiges `auth` innerhalb von 10 s → `{"t":"error","code":"auth_timeout"}` + Close.
- Ungültig → `{"t":"error","code":"auth_failed"}` + Close.
- Vor `ready` sind nur `auth` und Pings erlaubt.
- Meldet sich dieselbe Peer-ID erneut an, ersetzt die neue Verbindung die alte;
  die alte erhält `{"t":"error","code":"replaced"}` und wird geschlossen.

## 2. Präsenz (nur gegenseitig)

```
C→S {"t":"watch","peers":["bt2_…", …]}        // ersetzt die Watch-Liste, max. 2000
S→C {"t":"presence","peerId":"bt2_…","online":true|false}
```

Der Server meldet Peer P an Client C **nur**, wenn P in C's Watch-Liste steht
**und** C in P's Watch-Liste steht (gegenseitige Kontakte). Nach jedem `watch`
sendet der Server den aktuellen Stand aller gegenseitigen Peers, danach
Änderungen (Verbinden/Trennen/Watch-Änderung der Gegenseite).

## 3. Live-Tunnel

Tunnel-IDs sind pro Verbindung eindeutige `u32 > 0`. Der Öffnende wählt seine
ID selbst; der Server vergibt die ID für die Gegenseite.

```
A→S {"t":"open","tunnel":7,"to":"bt2_B"}
S→B {"t":"incoming","tunnel":3,"from":"bt2_A","name":"<Name von A>"}
B→S {"t":"accept","tunnel":3}            | {"t":"reject","tunnel":3}
S→A {"t":"opened","tunnel":7}            | {"t":"open_failed","tunnel":7,"code":"…"}
```

`code` ∈ `offline` (B nicht verbunden), `rejected`, `timeout` (B antwortet
nicht in 15 s), `limit` (zu viele Tunnel), `self`, `invalid`.

Danach: Binärframes `[tunnelId][bytes]` werden 1:1 an die Gegenseite (mit deren
Tunnel-ID) weitergereicht, Reihenfolge bleibt erhalten. Daten vor `opened` bzw.
für unbekannte Tunnel werden verworfen.

```
X→S {"t":"close","tunnel":id}
S→Y {"t":"closed","tunnel":id,"code":"remote"|"overflow"|"disconnect"}
```

Trennt sich eine Seite, erhalten alle Gegenseiten `closed` mit `disconnect`.
Über den Tunnel läuft unverändert das Peer-Protokoll v2 (Initiator = A,
Responder = B) — der Handshake authentifiziert beide Seiten Ende-zu-Ende,
der Relay kann sich nicht unbemerkt dazwischenschalten.

Limits: max. 64 Tunnel pro Verbindung, max. 8 offene Anfragen; Durchsatz pro
Verbindung per Token-Bucket (Standard 4 MiB/s, Burst 16 MiB). Läuft die
Sendewarteschlange einer Seite über, wird der betroffene Tunnel mit `overflow`
geschlossen.

## 4. Postfach (offline)

```
C→S {"t":"post","id":"<uuid>","to":"bt2_…","body":<JSON>}
S→C {"t":"posted","id":"…","status":"delivered"|"stored"}
S→C {"t":"post_failed","id":"…","code":"too_large"|"quota"|"rate"|"invalid"}
S→C {"t":"mail","id":"…","from":"bt2_…","ts":<unix ms>,"body":<JSON>}
C→S {"t":"ack","ids":["…", …]}
```

- `body` ist ein beliebiger JSON-Wert (serialisiert ≤ 64 KiB), vom Client
  **bereits Ende-zu-Ende-verschlüsselt**. Der Server interpretiert ihn nicht.
- Jede Post wird gespeichert, bis der Empfänger sie per `ack` bestätigt.
  `delivered` heißt: an eine aktive Verbindung des Empfängers zugestellt.
- Nach `ready` schickt der Server alle wartenden Nachrichten (älteste zuerst).
- Doppelte `id` (gleicher Absender) werden ignoriert, aber erneut mit
  `posted` beantwortet (idempotent).
- Quoten: pro Empfänger 1000 Nachrichten / 32 MiB, pro Absender→Empfänger 300,
  Aufbewahrung 30 Tage.

## 5. Sonstiges

```
C→S {"t":"ping","n":123}  →  S→C {"t":"pong","n":123,"time":<unix ms>}
```

Fehler allgemein: `{"t":"error","code":"…","message":"…"}`, z. B. `rate`
(Steuernachrichten > 50/s), `invalid`.

HTTP:

- `GET /healthz` → `200 ok`
- `GET /v1/info` → `{"name":"BlueTalk Cloud Relay","version":"…","protocol":1,"online":<n>}`
- `GET /` → kleine Infoseite

## Server-Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket-Port |
| `DATA_DIR` | `/data` | SQLite-Postfach (`relay.db`) |
| `PUBLIC_HOST` | – | Erwarteter Host in der Auth-Signatur |
| `TRUST_PROXY` | `0` | `1` = letztes `X-Forwarded-For`-Element als Client-IP (vom nächsten Proxy angehängt) |
| `CLIENT_IP_HEADER` | – | Header mit der echten Client-IP (z. B. `cf-connecting-ip` hinter Cloudflare); hat Vorrang vor `TRUST_PROXY` |
| `MAX_CONNECTIONS_PER_IP` | `32` | Verbindungen pro IP |
| `RUST_LOG` | `info` | Log-Level |
