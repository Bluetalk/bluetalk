# Chat-Protokoll (Wire)

Kurzüberblick der relevanten inneren Payloads. 1:1-Inhalte laufen immer in `encrypted-chat-e2ee` (nach Entschlüsselung gilt `kind` des Inner-Objekts). Gruppen nutzen `group-message-v1` mit `payload`.

Unbekannte `kind`-Werte werden **nicht** im Verlauf gespeichert (Allowlist: `chat`, `file`, `sticker`, `contact-share`). Steuerframes (`message-edit`, Receipts, Reaktionen, Gruppen-Events, Einladungen, Calls, Typing, …) haben eigene Zweige und dürfen keine Geister-Zeile anlegen.

## Fähigkeiten (Presence / Profil)

Bei Verbindungsaufbau geht `user-presence` (und bei Profiländerungen `profile`) raus. Ab diesem Stand enthalten beide:

```json
{
  "kind": "user-presence",
  "status": "online",
  "sender": "Anzeigename",
  "timestamp": 1710000000000,
  "features": ["message-edit", "mentions", "pins", "video-call"]
}
```

Das Array landet am Kontakt (`contacts[].features`, zuletzt gemeldeter Stand — bei mehreren Geräten eines Kontakts zählt die neueste Meldung). Alte Clients (2.3.x) senden kein `features`; das gilt als leer.

`message-edit` wird **nur** an Kontakte/Gruppenmitglieder geschickt, deren zuletzt gemeldete Fähigkeiten den Eintrag enthalten. Sonst wird lokal gepatcht und ein Hinweis gezeigt. So speichern 2.3.x-Clients das innere Edit nicht als Geisterzeile.

## Textnachricht

```json
{
  "kind": "chat",
  "messageId": "…",
  "timestamp": 1710000000000,
  "sender": "Anzeigename",
  "content": "Hallo @Alice",
  "replyTo": {
    "messageId": "…",
    "sender": "Alice",
    "preview": "Originaltext",
    "timestamp": 1709999900000
  },
  "mentions": ["bt-alice"]
}
```

`replyTo` und `mentions` sind optional. `mentions` ist ein Array von Peer-IDs für Gruppen-@Erwähnungen (zusätzlich zum `@Name` im Text). Eine Erwähnung benachrichtigt auch bei stummgeschalteter Gruppe (nicht bei globalem Nicht-stören).

## Nachricht bearbeiten

Innerer E2EE-Typ (1:1) bzw. Gruppen-`payload`:

```json
{
  "kind": "message-edit",
  "messageId": "neue-envelope-id",
  "refMessageId": "id-der-originalnachricht",
  "content": "Korrigierter Text",
  "editedAt": 1710003600000,
  "sender": "Anzeigename",
  "timestamp": 1710003600000
}
```

Regeln:

- Nur eigene Textnachrichten (`kind: chat`), höchstens 24 Stunden nach `timestamp`.
- Empfänger **hängt nichts an**, sondern patched die gespeicherte Nachricht (`content`, `edited: true`, `editedAt`).
- Idempotent über `refMessageId` **und** `editedAt`: gleicher oder älterer `editedAt` (Postfach + Live, zwei Geräte des Absenders) wird verworfen.
- UI zeigt das Label „bearbeitet“.
- Wire-Versand nur bei ausgehandelter Fähigkeit `message-edit` (siehe oben).

Gruppen: dasselbe Objekt als `payload` in `group-message-v1` (`payload.kind = "message-edit"`). Versand als Control-Paket (kein zweiter Verlaufseintrag), nur an Mitglieder mit der Fähigkeit.

Lokaler Patch läuft über `messages.patch` und kommt damit über den Cloud-Sync auf die anderen eigenen Geräte.

## Anheften

Kein P2P-Wire-Typ. Lokal über `window.bluetalk.messages.patch(peerId, messageId, { pinned, pinnedAt })` — der Messages-Store synchronisiert Patches zwischen Geräten.

## Entwürfe

Lokal/Store-Key `chatDrafts`: `{ [peerId]: { text, updatedAt } }`. Kein Wire. Steht **nicht** in `SYNCED_STORE_KEYS` — Entwürfe bleiben gerätelokal (Tipp-Zustand soll nicht Desktop↔Handy kreisen).

## Links

Nur `http:` / `https:` werden geöffnet, über `window.bluetalk.app.openUrl`.
