# BlueTalk Web & Cloud-Sync — Architektur

Siehe auch `relay/ACCOUNTS.md` (Server-API, Krypto) und `docs/VOICE.md`.

## Grundidee

Die React-App spricht ausschließlich über `window.bluetalk` (Bridge) mit der
Plattform. Darum gibt es zwei Bridges mit **identischer API**:

- `src/bridge/bluetalkBridge.js` — Desktop (Tauri `invoke`/`listen`).
- `src/bridge/webBridge/index.js` — Browser (IndexedDB, JS-Relay-Client,
  JS-Port des Peer-Protokolls v2).

Auswahl beim Build über einen Vite-Alias `@bridge`:
`vite build` → Desktop, `vite build --mode web` → Web (Ausgabe `dist-web/`,
`base: '/'`, Define `__BLUETALK_WEB__ = true`, sonst `false`).

Beide Bridges legen ihre API mit `wrapWithSync(api)` aus
`src/bridge/syncLayer.js` an, **bevor** sie sie einfrieren und als
`window.bluetalk` definieren.

## Modulgrenzen (wer schreibt was)

| Bereich | Dateien |
|---|---|
| Konto & Sync (geteilt Desktop/Web) | `src/renderer/cloudAccount/*`, `src/bridge/syncLayer.js` |
| Web-Bridge | `src/bridge/webBridge/*` |
| Web-Oberfläche (Login-Gate etc.) | `src/renderer/web/*` |
| Sprachnachrichten/Anrufe | `src/renderer/voice/*`, `src/renderer/calls/*` |
| Server | `relay/*` |

## `src/bridge/syncLayer.js`

```js
export function wrapWithSync(api)        // merkt sich die rohe API; gibt neue API zurück;
                                          // messages.append/patch/deleteMessage/deleteChat und
                                          // store.set/delete (nur synchronisierte Keys) melden
                                          // Änderungen an die Senke
export function getRawApi()               // zuletzt an wrapWithSync übergebene, ungewrappte API
export function setSyncSink(sink | null)  // sink.onLocalChange(change) — change:
                                          //  {type:'msg', peerId, messageId} | {type:'msg-del', peerId, messageId}
                                          //  {type:'chat-del', peerId} | {type:'store', key}
                                          //  (store-Änderungen werden intern in store-entry-Diffs zerlegt)
export function withoutSync(fn)           // ruft fn(rawApi) auf — entfernte Ops über die rohe API
                                          // anwenden, kein globaler Unterdrückungszähler
export const SYNCED_STORE_KEYS            // ['contacts','settings','e2eeSessions','groups','chatReadReceipts','chatLastViewedPeerTs']
```

Die Wrapper rufen immer zuerst die echte Methode auf und melden nur bei Erfolg.
`withoutSync` schluckt keine gleichzeitigen lokalen Änderungen mehr: Remote-Apply
geht ausschließlich über `getRawApi()` / `fn(rawApi)`.

## `src/renderer/cloudAccount/` (öffentliche API)

```js
// crypto.js
deriveKeys(username, password, kdf) → { authKeyB64, encKey: CryptoKey, macKey: CryptoKey, encKeyRawB64, macKeyRawB64 }
newKdf() → { alg:'pbkdf2-sha256', iterations:600000, salt }
sealVault(encKey, username, plain) / openVault(encKey, username, vault)
sealSyncItem(encKey, macKey, logicalKey, op) → { key, data }
openSyncItem(encKey, item) → op

// api.js — fetch-Client, Basis-URL aus Relay-URL (wss://host/v1/ws → https://host)
createCloudApi(baseUrl, getToken) → { prelogin, register, login, me, logout, changePassword, deleteAccount, lookup, push, pull, deleteKeys }

// session.js — Kontozustand, persistiert in store-Key 'cloudAccount'
//   { username, peerId, token, baseUrl, encKeyRawB64, macKeyRawB64, lastSeq, deviceName }
getAccount() / onAccountChange(cb)
registerAccount({ username, password, identity: { networkSeedB64, e2eeIdentity } })
loginAccount({ username, password }) → { account, vault, identityPending }
                           // vault: { networkSeed, e2eeIdentity }
                           // identityPending: Konto noch nicht persistiert (Peer-ID weicht ab)
commitLiveAccount()        // nach Bestätigung der Identitätsübernahme persistieren
prepareIdentityTakeover()  // e2eeSessions, Outbox, Sync-Meta leeren, lastSeq=0
logoutAccount()  changePassword(old,new)  deleteAccount(password)

// syncEngine.js
startSync() / stopSync()   // Outbox (store-Key 'cloudSyncOutbox', In-Memory-Wahrheit),
                           // Push entprellt 1,5 s, Pull beim Start, alle 60 s, bei Fokus/online;
                           // wendet entfernte Ops über die rohe API an und feuert
                           // window-Event 'bluetalk:sync-applied'
                           // detail: { peers: [...], storeKeys: [...] }
                           // verweigert, wenn account.peerId ≠ lokale Peer-ID (state:'error')
syncNow()                  // einmal Pull+Push (Button „Jetzt synchronisieren“)
fullUpload()               // nur nach Registrierung: alle lokalen Chats/Store-Einträge hochladen
getSyncState() / onSyncState(cb)  // { state:'off'|'idle'|'syncing'|'error', lastSyncAt, error, pending }
```

Die App reagiert auf `bluetalk:sync-applied`, indem sie Kontakte/Einstellungen/
Gruppen aus dem Store neu lädt und betroffene Chats neu einliest.

## Desktop

- Bestehendes Ed25519-Seed (`network-identity.json`) wird beim Registrieren in
  den Tresor gelegt. Neue Tauri-Befehle:
  `account_export_identity` → `{ seedB64 }` und
  `account_import_identity({ seedB64 })` → schreibt die Identität und startet
  die App neu (Anmeldung mit bestehendem Konto auf einem anderen PC — vorher
  Warnung „Diese Installation übernimmt die Identität deines Kontos“).
- Relay: Bei `replaced` kein Auto-Reconnect, Status `state: 'replaced'`.
  Neuer Befehl `cloud_takeover` verbindet erneut (und verdrängt das andere Gerät).
- CSP `connect-src` erlaubt zusätzlich `https: wss:` (Konto-API, eigene Relays).
- Seite „Cloud-Nachrichten“ wird zu **„BlueTalk Cloud“** mit Kontobereich
  (Registrieren/Anmelden/Abmelden, Sync-Status, Passwort ändern, Konto
  löschen, Link zu BlueTalk Web).

## BlueTalk Web

- Erreichbar unter `https://bt.henny.dev/` (vom Relay-Server ausgeliefert).
- **Login-Gate** (`src/renderer/web/WebGate.jsx`): Ohne Sitzung → Anmelden /
  Konto erstellen (neue Identität im Browser). Nach Login: Tresor öffnen,
  Identität + E2EE-Identität in den Store, Erst-Pull, dann `<App/>`.
- **Speicher**: IndexedDB pro Konto (`bluetalk-web-<peerId>`): `kv` (store),
  `messages` (gleiche Semantik und Rückgabeformen wie
  `src-tauri/src/database/messages.rs`).
- **Netz**: JS-Relay-Client (Port von `src-tauri/src/cloud/`: Auth, Watch,
  Präsenz, Tunnel, Postfach, Auto-Open nur vom lexikografisch kleineren Peer)
  + JS-Port des Peer-Protokolls v2 (`network-core`: signierter
  X25519-Handshake, ChaCha20-Poly1305-Records) — byte-genau kompatibel, mit
  Testvektoren aus Rust abgesichert. Bibliotheken: `@noble/curves`,
  `@noble/ciphers`, `@noble/hashes`.
- `peer:*`-Events und `peer.getPeers()` liefern dieselben Formen wie Desktop
  (`transport: 'relay'`).
- Nicht verfügbar im Web (Bridge liefert saubere Fehler / leere Ergebnisse,
  UI blendet aus): LAN/Discovery, lokale KI (Ollama), Plugins, Updater,
  Fenstersteuerung, große Datei-Freigaben (`file.host/request`).
  Spiele: Spielfenster öffnen als Browser-Popup (`window.open('#/<route>')`),
  Kommunikation über `BroadcastChannel` mit gleicher Semantik wie
  `game_window_*`.
- Benachrichtigungen: Notification API.
- Nur ein aktives Gerät: Bei `replaced` Vollbild-Hinweis „BlueTalk ist auf
  einem anderen Gerät aktiv“ + „Hier verwenden“.
