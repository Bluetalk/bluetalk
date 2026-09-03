# BlueTalk — Agent-Hinweise

## Builds und Tests nicht selbst ausführen

Nicht von allein bauen, testen oder die App starten. Der Nutzer macht das selbst.

Nicht ausführen, außer der Nutzer fordert es ausdrücklich:

- `npm run build`, `npm run check`, `npm test`, `npm run test:rust`
- `npm run desktop:dev`, `npm run desktop:build`, `tauri dev`, `tauri build`
- `cargo test`, `cargo build`

Kein Browser- oder Runtime-Verify als Pflicht nach UI-Änderungen. Code ändern, kurz erklären, fertig.
