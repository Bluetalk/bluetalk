# Kamera & Bildschirmübertragung in Anrufen (ab 2.4.0)

Ergänzt `docs/VOICE.md`. Video läuft wie Audio über die bestehende,
transportverschlüsselte Peer-Verbindung (Direkt, Relay, Web) und ist zusätzlich
mit dem Anrufschlüssel Ende-zu-Ende verschlüsselt. Kein WebRTC-Medienpfad,
kein TURN.

## Mehrere Geräte (gilt auch für reine Sprachanrufe)

- `call-offer` geht per `peer.send` an **alle** Geräte des Angerufenen → alle klingeln.
- Annahme auf Gerät D: Der Angerufene sendet `call-signal accept` (kommt beim
  Anrufer mit `fromDevice = D` an). Der Anrufer bindet den Anruf an D
  (`remoteDevice`) und schickt an alle anderen Geräte
  `{kind:'call-signal', callId, op:'cancel', reason:'answered-elsewhere'}`.
  Ab dann gehen alle Signale und Medien per `peer.sendTo(peerId, D, …)`.
- Eingehende `call-*`-Nachrichten eines gebundenen Anrufs von anderen Geräten
  werden verworfen.
- `reject` von irgendeinem Gerät beendet den Anruf (bewusste Ablehnung).
  `busy` von einem Gerät wird ignoriert, solange andere Geräte noch klingeln
  können; erst wenn alle busy/abgelehnt haben bzw. Timeout → besetzt.
- Der Anrufer kennt nach `ringing` die Geräte, die klingeln.

## Signale

```
call-offer (E2EE, wie bisher) + media: { video: true|false }, capabilities: { video: ['vp8','avc1'], screen: true|false }
call-signal op: 'video-on' | 'video-off' | 'screen-on' | 'screen-off' | 'keyframe', stream?: 'camera'|'screen'
```

Video darf jederzeit während des aktiven Anrufs ein-/ausgeschaltet werden
(auch wenn als Sprachanruf gestartet).

## Medien

```
{ kind: 'call-video', callId, stream: 'camera'|'screen', seq, frag, frags, key: bool, ts, codec, w, h, data: b64(AES-256-GCM(callKey, bytes, iv)) }
iv = 4 Byte Richtung/Stream || 8 Byte seq (BE)
     Richtung/Stream: 0x11 Kamera Anrufer→Angerufener, 0x12 Kamera umgekehrt,
                      0x21 Bildschirm Anrufer→Angerufener, 0x22 Bildschirm umgekehrt
     (Audio bleibt 0x01/0x02 — getrennte IV-Räume, nie IV-Wiederverwendung)
```

- `seq` zählt pro (Richtung, Stream) Fragmente fortlaufend; ein kodierter Frame
  wird in Fragmente ≤ 24 KiB geteilt (`frag` 0-basiert von `frags`).
- Kodierung: WebCodecs `VideoEncoder`, bevorzugt VP8, sonst H.264 (`avc1.42E01F`).
  - Kamera: max. 640×360, 24 fps, ~600 kbit/s, Keyframe alle 3 s.
  - Bildschirm: max. 1280×720 (Seitenverhältnis halten), 8 fps, ~1,2 Mbit/s,
    `contentHint = 'detail'`, Keyframe alle 3 s.
  - Auf `keyframe`-Signal sofort Keyframe.
- Empfang: Fragmente zusammensetzen (unvollständige Frames nach 1 s verwerfen),
  entschlüsseln, `VideoDecoder` → `<canvas>`. Fehlt ein Frame → bis zum nächsten
  Keyframe Delta-Frames verwerfen und `keyframe` anfordern (max. 1×/s).
- Staukontrolle: Sendewarteschlange begrenzen (pro Stream max. ~5 Frames in
  Arbeit); bei Stau Frames auslassen und Bitrate stufenweise senken
  (Audio hat immer Vorrang).
- Ohne WebCodecs-Video: Video-Knöpfe deaktiviert mit Tooltip.
- Bildschirm: `navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 8 }, audio: false })`.
  Beendet der Nutzer die Freigabe über die Browser-/System-UI → `screen-off`.

## UI

- Aktiver Anruf ohne Video: kompakte Pill wie bisher.
- Sobald ein Video-Stream aktiv ist: Video-Bühne (Overlay über dem Inhalt,
  minimierbar zurück zur Pill): Gegenüber groß, eigene Kamera als verschiebbares
  Bild-in-Bild, Bildschirmübertragung groß mit Kamera als Kachel,
  Steuerleiste (Mikrofon, Kamera, Bildschirm, Auflegen, Vollbild, Minimieren),
  Name/Dauer/Qualität. Auf Handy: Vollbild, Steuerleiste unten, Safe-Area.
- Eingehender Videoanruf: „Videoanruf…“ + Annehmen mit/ohne Kamera.
