# Mehrere Geräte gleichzeitig (ab 2.4.0)

Bisher: pro Peer-ID nur eine Relay-Verbindung, die neueste verdrängt die
alte (`replaced`). Ab 2.4.0 können Desktop(s) und BlueTalk Web **gleichzeitig**
online sein. Alle Geräte eines Kontos teilen dieselbe Identität (Tresor, siehe
`relay/ACCOUNTS.md`) und denselben Verlauf (Sync).

## Begriffe

- **deviceId**: zufällige, stabile ID pro Installation (Desktop) bzw. pro
  Browser-Profil (Web), 16 Byte hex (32 Zeichen), Regex `^[A-Za-z0-9_-]{8,64}$`.
  Gespeichert im lokalen Store unter `cloudDeviceId` (gibt es schon für den
  Sync-`origin` — dieselbe ID verwenden), nicht synchronisiert.
- **deviceName**: Anzeigename („Windows“, „BlueTalk Web · Chrome“), ≤ 64 Zeichen.

## Relay-Protokoll (Erweiterung, abwärtskompatibel)

```
C→S {"t":"auth", …, "device":"<deviceId>", "deviceName":"…"}      // device optional
S→C {"t":"ready", …, "device":"<deviceId>", "devices":[{"id","name"}, …]}   // eigene ANDERE Geräte
```

- Ohne `device` (Clients ≤ 2.3.x) gilt `device = "legacy"`.
- Gleiche Peer-ID **und** gleiches device → alte Verbindung bekommt `replaced`
  (wie bisher). Verschiedene devices → parallel erlaubt, max. **8** pro Peer-ID;
  beim 9. wird die am längsten verbundene mit `replaced` getrennt.
- Eigene Geräte: Bei Änderung erhält jede Verbindung
  `{"t":"devices","devices":[{"id","name"}]}` (ihre jeweils anderen Geräte).

Präsenz:

```
S→C {"t":"presence","peerId":"bt2_…","online":true,"devices":[{"id","name"}, …]}
```

Wird bei jeder Änderung der Geräteliste eines gegenseitigen Kontakts gesendet
(`online` = mindestens ein Gerät). Alte Clients ignorieren `devices`.

Tunnel:

```
A→S {"t":"open","tunnel":7,"to":"bt2_B","device":"<deviceId von B>"}   // device optional
S→B {"t":"incoming","tunnel":3,"from":"bt2_A","fromDevice":"<deviceId von A>","name":"…"}
```

- Mit `device`: genau dieses Gerät (`open_failed` `offline`, wenn nicht verbunden).
- Ohne `device` (alte Clients): das zuletzt verbundene Gerät von B.
- Tunnel zwischen zwei Geräten **derselben** Peer-ID sind verboten (`self`).

Postfach: Live-`mail` geht an **alle** verbundenen Geräte des Empfängers; die
Nachricht wird beim **ersten** `ack` gelöscht (die anderen Geräte bekommen sie
über den Sync). Nach Login werden wartende Nachrichten an das sich anmeldende
Gerät geschickt.

Sync-Hinweis (Server kennt die Zuordnung Konto ↔ peerId):

```
S→C {"t":"sync","latestSeq":<n>}
```

Nach jedem erfolgreichen `POST /v1/sync/push` eines Kontos an alle
Relay-Verbindungen dieser Peer-ID (gebündelt max. 1×/s). Der Client pullt dann
sofort → Nachrichten, die auf Gerät 1 gesendet/empfangen werden, erscheinen
nach ~1 s auf Gerät 2.

## Client: Sitzungen pro Gerät

- Für jeden gegenseitigen Kontakt und **jedes** seiner Geräte gibt es höchstens
  einen Relay-Tunnel. Wer öffnet: das Paar mit dem lexikografisch kleineren
  `peerId + "/" + deviceId` (sonst warten auf `incoming`).
- Peer-Sitzungen werden intern nach `(peerId, deviceKey)` geführt.
  `deviceKey` = remote deviceId bei Relay, `"direct"` bei LAN/Direktverbindung.
- Gibt es eine Direktverbindung zu einem Peer, werden zu diesem Peer **keine**
  Relay-Tunnel geöffnet und eingehende abgelehnt (vermeidet Doppelsitzungen zum
  selben Gerät; bekannte Grenze: andere Geräte dieses Peers sind dann nur
  erreichbar, sobald die Direktverbindung endet).
- Nach außen (App/Bridge) bleibt der Peer die Einheit:
  - `peer.send(peerId, data)` → an **alle** Sitzungen des Peers (true, wenn mind. eine klappt).
  - **neu** `peer.sendTo(peerId, deviceKey, data)` → nur an diese Sitzung.
  - `peer:message`-Payload enthält zusätzlich `fromDevice` (deviceKey).
  - `peer:connected` beim ersten, `peer:disconnected` beim letzten Gerät.
  - `peer.getPeers()`-Einträge: zusätzlich `devices: [{ id, name, transport }]`.
  - **neu** Event `peer:devices` `{ id, devices }` bei Änderung.
- Eingehende Nachrichten können pro Gerät doppelt ankommen (z. B. Lesebestätigung
  von zwei Geräten) — die App ist idempotent per `messageId`/`refMessageId`.
  Bearbeitungen zusätzlich per `editedAt` (gleicher oder älterer Stand wird
  verworfen). Anheften/Bearbeiten laufen über `messages.patch` und damit über
  den Sync; Entwürfe (`chatDrafts`) bleiben gerätelokal.
- Fähigkeiten (`features` in Presence/Profil) werden pro Kontakt gespeichert.
  `message-edit` geht nur raus, wenn der **zuletzt** gemeldete Stand die
  Fähigkeit enthält (gemischte Geräte eines Kontakts: konservativ).
- Kein `replaced`-Vollbild/Banner mehr im Normalfall; nur noch, wenn wirklich
  `replaced` kommt (gleiches Gerät doppelt oder > 8 Geräte).

## Sync live

`{"t":"sync"}` vom Relay → Desktop: Event `cloud:sync` an die UI; Web: direkt.
Die Sync-Engine (`src/renderer/cloudAccount/syncEngine.js`) pullt dann sofort
(entprellt 300 ms). Der 60-s-Pull bleibt als Fallback.

## Anrufe mit mehreren Geräten

Siehe `docs/VOICE.md` (Abschnitt „Mehrere Geräte“) und `docs/VIDEO.md`.
