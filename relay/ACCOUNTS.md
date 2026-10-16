# BlueTalk Cloud — Konten & Synchronisation (API v1)

Ergänzt `PROTOCOL.md` (Relay). Gleicher Server, gleiche SQLite-DB, gleiche
Domain (`https://bt.henny.dev`). Der Server ist **Zero-Knowledge**: Passwort,
Schlüssel, Identität und Chatverlauf sieht er nie im Klartext.

## Überblick

- Ein **BlueTalk-Cloud-Konto** = Benutzername + Passwort.
- Das Konto enthält einen verschlüsselten **Tresor** (Vault) mit der
  Netzwerk-Identität (Ed25519-Seed) und der E2EE-Identität (ECDH-P256). Damit
  ist man auf jedem Gerät (Desktop oder BlueTalk Web) *dieselbe* Peer-ID.
- **Sync-Log**: verschlüsselte Einträge (Nachrichten, Kontakte, Einstellungen,
  E2EE-Sitzungen) mit Server-Sequenznummer. Geräte pushen Änderungen und
  pullen alles nach ihrer letzten bekannten Sequenz.
- **Mehrere Geräte**: Bis zu 8 Relay-Verbindungen derselben Peer-ID können
  parallel online sein (verschiedene `device`-IDs, siehe PROTOCOL.md und
  `docs/MULTIDEVICE.md`). Gleiche `(peerId, device)` oder das 9. Gerät
  führen zu `{"t":"error","code":"replaced"}`. Clients ≤ 2.3.x ohne `device`
  verhalten sich wie bisher (ein Gerät `legacy`, Doppel-Login ersetzt).
  Nach erfolgreichem `POST /v1/sync/push` schickt der Relay
  `{"t":"sync","latestSeq":n}` an alle Verbindungen dieser Peer-ID
  (max. 1×/s). Sync-REST-Aufrufe funktionieren unabhängig vom WebSocket.

## Kryptografie (Client)

```
username   = lowercase(trim(input)), Regex ^[a-z0-9_.-]{3,32}$
kdf        = { "alg": "pbkdf2-sha256", "iterations": 600000, "salt": b64(16 Zufallsbytes) }
master     = PBKDF2-HMAC-SHA256(utf8(password), base64decode(salt), iterations, 32 Byte)
authKey    = HKDF-SHA256(ikm=master, salt=leer, info="bluetalk-cloud-auth-v1", 32 Byte)
encKey     = HKDF-SHA256(ikm=master, salt=leer, info="bluetalk-cloud-enc-v1",  32 Byte)  // AES-256-GCM
macKey     = HKDF-SHA256(ikm=master, salt=leer, info="bluetalk-cloud-mac-v1",  32 Byte)  // HMAC-SHA256
```

Alles über WebCrypto (`crypto.subtle`) — funktioniert in Tauri-WebView2 und im
Browser. `authKey` wird als Base64 an den Server geschickt, `encKey`/`macKey`
verlassen das Gerät nie.

**Tresor** (`vault`):

```
plaintext = JSON {
  "v": 1,
  "networkSeed": b64(32 Byte Ed25519-Seed),
  "e2eeIdentity": { "privateJwk": {...}, "publicSpkiB64": "..." },
  "createdAt": <unix ms>
}
vault = { "v": 1, "iv": b64(12), "ct": b64(AES-256-GCM(encKey, plaintext, AAD=utf8("bluetalk-vault-v1:" + username))) }
```

**Sync-Eintrag**:

```
key   = base64url(HMAC-SHA256(macKey, utf8(logicalKey)))[0..43]   // opak für den Server
data  = b64( iv(12) || AES-256-GCM(encKey, utf8(JSON(op)), AAD=utf8("bluetalk-sync-v1:" + key)) )
```

`logicalKey` / `op` — jedes `op` trägt `origin` (stabile Geräte-ID, Store-Key
`cloudDeviceId`, nicht synchronisiert). Pull überspringt Ops mit eigener
`origin`, schreibt die Sequenz aber fort.

| logicalKey | op |
|---|---|
| `msg:<peerId>:<messageId>` | `{"t":"msg","peerId":…,"message":{…},"origin":…}` (vollständiges Nachrichtenobjekt, wie `messages.append` es bekommt; nach `patch` erneut komplett) |
| `msg:<peerId>:<messageId>` | `{"t":"msg-del","peerId":…,"messageId":…,"ts":…,"origin":…}` (Tombstone) |
| `chat:<peerId>` | `{"t":"chat-del","peerId":…,"ts":…,"origin":…}` (Chat gelöscht; Nachrichten ≤ ts ignorieren) |
| `store:<name>:<entryId>` | `{"t":"store-entry","key":<name>,"id":<entryId>,"value":…\|,"deleted":true,"ts":…,"origin":…}` |
| `store:<name>` | `{"t":"store","key":<name>,"value":…,"ts":…,"origin":…}` (Altbestand, nur noch lesend kompatibel; wird intern in Einträge zerlegt) |

Einträge: `contacts`/`groups` als Array (Schlüssel `id`, bei Gruppen Fallback
`groupId`), `e2eeSessions` / `chatReadReceipts` / `chatLastViewedPeerTs` als
Objekt-Map, `settings` als Objekt (Schlüssel = Feldname). Gerätelokale
Settings (`peerPort`, `peerPorts`, `apiPort`, `autoUpdateEnabled`,
`autoDownloadUpdates`, `minimizeToTray`, `launchAtLogin`, `debugMode`,
`windowsNotifications`, `uiResize`, `uiCollapse`, `onboardingUsernameDone`)
werden nicht synchronisiert. Store-Key `cloudDeviceId` ebenfalls nicht.

Konfliktregel: LWW **pro Eintrag** nach `ts`; ein lokaler ausstehender Eintrag
mit höherem `ts` gewinnt. Nachrichten sind idempotent per `messageId`.
Anhänge (`fileData`) größer als 1,5 MiB werden vor dem Sync entfernt und die
Nachricht mit `"syncStripped": true` markiert.

## HTTP-API

Alle Bodies JSON. Authentifizierte Endpunkte:
`Authorization: Bearer <token>`. Fehler: `{"error":"<code>","message":"…"}`.
CORS: `Access-Control-Allow-Origin: *`, Methoden `GET, POST, PUT, DELETE,
OPTIONS`, Header `authorization, content-type` (keine Cookies → sicher).

### Konto

```
POST /v1/account/prelogin   {"username"}
  → 200 {"kdf":{…}}      // unbekannter Name: deterministischer Fake-Salt
                         // (HMAC(serverSecret, "fake-salt:"+username)[0..16]) → keine Enumeration

POST /v1/account/register   {"username","kdf","authKey","vault","publicKey","signature","deviceName"}
  signature = Ed25519(networkSeed, utf8("bluetalk-account-register-v1\n" + username + "\n" + authKey))
  → 201 {"token","username","peerId"}
  → 409 username_taken | peer_taken     400 invalid     429 rate

POST /v1/account/login      {"username","authKey","deviceName"}
  → 200 {"token","username","peerId","vault","kdf"}
  → 401 invalid_credentials   429 rate (5 Versuche/Minute pro IP und pro Benutzername)

GET  /v1/account/me         → {"username","peerId","createdAt","usage":{"items","bytes"},"quota":{"bytes"}}
POST /v1/account/logout     → 204  (widerruft diesen Token)
POST /v1/account/password   {"currentAuthKey","kdf","authKey","vault"}
  → 200 {"token"}   (alle anderen Tokens widerrufen)   401 invalid_credentials
  429 rate (5/min pro Konto und IP)
DELETE /v1/account          {"authKey"}  → 204 (Konto, Tokens, Sync-Daten weg)
  429 rate (5/min pro Konto und IP)

GET  /v1/account/lookup?username=<name>   (ohne Auth, rate-limitiert 30/min/IP)
  → 200 {"username","peerId"}   404 not_found
```

- `authKey` b64 (32 Byte). Server speichert `SHA-256(authKey)`, Vergleich in
  konstanter Zeit.
- `publicKey` b64 (32 Byte Ed25519); `peerId = "bt2_" + hex(sha256(publicKey))`.
  Ein Peer kann höchstens ein Konto haben.
- `vault` max. 64 KiB serialisiert.
- Tokens: 32 Zufallsbytes base64url, gespeichert als SHA-256, gleitend 90 Tage
  gültig, max. 20 pro Konto (ältester fliegt).

### Sync

```
POST /v1/sync/push   {"items":[{"key","data"}, …]}   max. 100 Einträge, 8 MiB Body
  → 200 {"results":[{"key","seq"}, …], "latestSeq"}
  → 413 too_large (Eintrag > 3 MiB) | quota (Konto > Quota)

GET  /v1/sync/pull?after=<seq>&limit=<1..500, Std. 200>
  → 200 {"items":[{"seq","key","data","ts"}, …], "latestSeq", "more": bool}

POST /v1/sync/delete {"keys":[…]}  max. 500   → 200 {"deleted": n}
```

- `key` ≤ 64 Zeichen `[A-Za-z0-9_-]`. **Upsert pro key**: Ein neuer Eintrag mit
  vorhandenem key ersetzt den alten und bekommt eine neue, höhere `seq`.
- `seq` ist pro Konto streng monoton (nie wiederverwendet, auch nach delete).
- `pull` liefert aufsteigend nach `seq`.
- Quota: `SYNC_QUOTA_BYTES` (Std. 256 MiB) pro Konto über alle `data`-Längen.

## Relay-Erweiterungen (gleichzeitig mit diesem Release)

- `maxMailBody` 1 MiB (statt 64 KiB), Textframe-Limit 1,25 MiB,
  Postfach-Quota pro Empfänger 128 MiB. Clients lesen `limits` aus `ready`.
- Statisches Hosting von **BlueTalk Web** aus `WEB_DIR` (Std. `/srv/web`) unter
  `/` (SPA, Hash-Routing → `index.html`). Die bisherige Infoseite zieht nach
  `/info`. Header für Web-Dateien: strikte CSP
  (`default-src 'self'; connect-src 'self' wss: https:; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`),
  `Permissions-Policy: microphone=(self)`, Cache: `index.html` no-cache,
  vorhandene `/assets/*` immutable (fehlende Asset-Dateien: 404 ohne immutable).
  Unbekannte Pfade unter `/v1/` liefern JSON-404 statt `index.html`.

## Server-Konfiguration (neu)

| Variable | Standard | Bedeutung |
|---|---|---|
| `WEB_DIR` | `/srv/web` | Gebautes BlueTalk Web (fehlt → nur Infoseite) |
| `SYNC_QUOTA_BYTES` | `268435456` | Sync-Speicher pro Konto |
| `ACCOUNTS_ENABLED` | `1` | `0` = Konto-/Sync-API aus (reiner Relay) |
