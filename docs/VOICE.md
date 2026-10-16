# Sprachnachrichten & Sprachanrufe

Beides läuft über die bestehende Peer-Verbindung (`window.bluetalk.peer.send`)
— also im LAN, direkt übers Internet, über den Cloud-Relay und in BlueTalk Web
gleich. Kein WebRTC, kein TURN-Server nötig. Die App ist Windows-only
(WebView2/Chromium) bzw. Browser für BlueTalk Web.

## Sprachnachrichten

- Aufnahme: `getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}})`
  + `MediaRecorder` (`audio/webm;codecs=opus`, Fallback `audio/mp4` / Standard),
  `audioBitsPerSecond: 32000`, max. 5 Minuten (Auto-Stopp).
- Wellenform: 64 Balken (Ganzzahlen 0–255) aus RMS-Pegeln während der Aufnahme
  (AnalyserNode) — beim Empfänger aus den Metadaten, nicht neu berechnet.
- Versand als normale **Datei-Nachricht** (bestehender `kind: 'file'`-Pfad,
  E2EE wie jede Datei), zusätzlich:
  ```
  voice: { durationMs, waveform: [64 × 0..255], mime }
  fileName: "Sprachnachricht-<yyyy-mm-dd-hhmmss>.webm"
  ```
  Alte Clients sehen eine abspielbare Audiodatei → abwärtskompatibel.
  Das `voice`-Feld muss durch alle Pfade erhalten bleiben (Senden, Empfangen,
  Speichern, Gruppen, Postfach, Sync).
- UI Composer: Ist das Textfeld leer und kein Anhang gewählt, wird der
  Senden-Knopf zum **Mikrofon**. Klick → Aufnahmeleiste (roter Punkt, Timer,
  Live-Wellenform, Papierkorb = verwerfen, Stopp = Vorschau mit Abspielen,
  Senden). Esc verwirft. Mikrofon verweigert → verständlicher Toast.
- UI Nachricht: runder Play/Pause-Knopf, Wellenform-Balken (gespielter Teil in
  Akzentfarbe), Klick/Ziehen auf Wellenform = Springen, Dauer/Restzeit,
  Geschwindigkeit 1× → 1,5× → 2×. Nur ein Player spielt gleichzeitig.
- Postfach: Sprachnachrichten passen in das neue 1-MiB-Postfachlimit
  (~3–4 Minuten). Größere werden wie bisher nur live zugestellt.

## Sprachanrufe (1:1)

### Signalisierung

Das Angebot enthält einen frischen Anrufschlüssel und wird deshalb
**Ende-zu-Ende-verschlüsselt** über `sendPairwiseEncrypted` verschickt
(innerer Payload):

```
{ kind: 'call-offer', callId, callKeyB64 (32 Zufallsbytes), codecs: ['opus','pcm16'], timestamp, sender }
```

Alle weiteren Signale sind normale Peer-Nachrichten (enthalten nichts Geheimes):

```
{ kind: 'call-signal', callId, op: 'ringing' | 'accept' | 'reject' | 'busy' | 'cancel' | 'end' | 'ping' | 'pong',
  codec?: 'opus'|'pcm16' (bei accept), t?: <ms> (ping/pong für RTT) }
```

Der Empfänger eines entschlüsselten `call-offer` darf das **nicht** als
Chatnachricht speichern — er leitet es an den Call-Manager weiter.

### Medien

```
{ kind: 'call-audio', callId, seq, data: b64( AES-256-GCM(callKey, frames, iv) ) }
iv = 4 Byte Richtung (0x00000001 Anrufer→Angerufener, 0x00000002 umgekehrt) || 8 Byte seq (BE)
```

- Codec `opus`: WebCodecs `AudioEncoder` (48 kHz, mono, 24 kbit/s, 20-ms-Frames),
  3 Frames pro Nachricht (60 ms). Inhalt `frames` = `[u16 BE len][bytes]` × n.
- Fallback `pcm16`: 16 kHz mono Int16LE, 60 ms pro Nachricht (1920 Byte).
- Aufnahme über `AudioWorklet` (Fallback ScriptProcessor). Wiedergabe über
  `AudioDecoder` → Ringpuffer-Worklet mit Jitterpuffer (Ziel 80 ms, max. 300 ms,
  ältestes verwerfen). Ausgabe-Gerät = Standard.
- Empfangene Pakete mit falscher `callId` oder doppelter/alter `seq` verwerfen.
- Keine Medien und kein `ping` seit 15 s → Anruf beendet („Verbindung
  verloren“). `ping` alle 2 s → RTT-Anzeige.

### Ablauf & Regeln

- Klingeln max. 45 s → `cancel` + „Verpasster Anruf“ beim Angerufenen.
- Schon im Anruf → automatische Antwort `busy`.
- Blockierte Kontakte → Angebot still verwerfen.
- Nur 1:1-Chats mit menschlichen Kontakten (keine Gruppen, keine KI-Bots).
- Peer offline → Anruf nicht möglich (Knopf deaktiviert, Tooltip).
- Anrufprotokoll: lokal (nicht übertragen) eine Systemnachricht per
  `messages.append` mit `kind: 'call-log'`:
  `{ direction: 'out'|'in', outcome: 'completed'|'missed'|'rejected'|'busy'|'failed', durationMs }`
  → in der Nachrichtenliste als kompakte zentrierte Zeile („Sprachanruf · 3:12“,
  „Verpasster Anruf“).

### UI

- `ChatHeader`: Telefon-Knopf.
- Eingehend: Overlay (Avatar, Name, „Sprachanruf…“, Annehmen grün / Ablehnen
  rot), Klingelton per WebAudio-Oszillator (kein Asset), Desktop-Benachrichtigung
  wenn das Fenster nicht fokussiert ist.
- Ausgehend: „Wird angerufen…“ mit Abbrechen.
- Aktiv: schwebende Anrufkarte (bleibt beim Seitenwechsel sichtbar): Name,
  Dauer, Verbindungsart (Direkt/Cloud), Qualität aus RTT, Pegelanzeige,
  Stummschalten, Auflegen.
- Kein neues Design-System — vorhandene CSS-Variablen, Lucide-Icons,
  bestehende Button-Stile.
