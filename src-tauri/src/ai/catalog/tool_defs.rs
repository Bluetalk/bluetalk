//! Agent-Tool-Schemas (Function-Calling), Tool-Sätze je Stufe und
//! die Prompt-Hinweise/-Abschnitte zu den Tools.

use super::*;

// ---------------------------------------------------------------------------
// Agent-Tools (OpenAI/Ollama Function-Calling-Schema)
// ---------------------------------------------------------------------------

fn tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        }
    })
}

/// Alle Tool-Definitionen (wie v1 `AI_AGENT_TOOLS`).
pub fn agent_tools() -> Vec<Value> {
    vec![
        tool(
            "list_files",
            "Listet die Einträge eines Verzeichnisses auf (Dateien und Ordner, alphabetisch sortiert). NUTZE: um herauszufinden, was in einem Ordner liegt, bevor du Dateien liest oder änderst. NICHT NUTZEN: um den Inhalt von Dateien zu sehen — dafür read_file verwenden.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Verzeichnispfad (relativ zum Arbeitsverzeichnis oder absolut). Standard: Arbeitsverzeichnis."}
                }
            }),
        ),
        tool(
            "search_files",
            "Findet Dateien anhand eines Namensmusters (Glob, z. B. \"*.js\", \"src/**/*.tsx\"). NUTZE: um Dateien nach Namen zu finden, ohne Verzeichnisse manuell durchsuchen zu müssen. Der Musterplatzhalter ** matched beliebige Verzeichnistiefe, * matched ein Namenssegment.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob-Muster, z. B. \"*.txt\", \"src/**/*.js\", \"**/manifest.json\"."},
                    "path": {"type": "string", "description": "Wurzelverzeichnis für die Suche (relativ oder absolut). Standard: Arbeitsverzeichnis."}
                },
                "required": ["pattern"]
            }),
        ),
        tool(
            "read_file",
            "Liest den Inhalt einer Datei als UTF-8-Text-String zurück. NUTZE: um Quelltext, Konfiguration oder Dokumente zu inspizieren. Optional können Zeilenbereiche extrahiert werden (start_line/end_line/max_lines). Für Regex-basierte Extraktion nutze extract_file. NICHT NUTZEN: um zu prüfen, ob eine Datei existiert — dafür list_files oder search_files.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Dateipfad (relativ zum Arbeitsverzeichnis oder absolut)."},
                    "start_line": {"type": "integer", "description": "Optional: erste Zeile (1-basiert), ab der gelesen wird."},
                    "end_line": {"type": "integer", "description": "Optional: letzte Zeile (1-basiert, inklusive), bis zu der gelesen wird."},
                    "max_lines": {"type": "integer", "description": "Optional: maximale Anzahl Zeilen ab start_line."}
                },
                "required": ["path"]
            }),
        ),
        tool(
            "extract_file",
            "Extrahiert Text aus einer Datei als String — entweder per Zeilenbereich oder per Regex-Muster. NUTZE: bei großen Dateien, wenn nur ein Ausschnitt relevant ist, oder um passende Zeilen zu finden. Für den vollständigen Dateiinhalt ohne Filter reicht read_file.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Dateipfad (relativ zum Arbeitsverzeichnis oder absolut)."},
                    "start_line": {"type": "integer", "description": "Optional: erste Zeile (1-basiert). Standard: 1."},
                    "end_line": {"type": "integer", "description": "Optional: letzte Zeile (1-basiert, inklusive)."},
                    "max_lines": {"type": "integer", "description": "Optional: maximale Anzahl zurückgegebener Zeilen."},
                    "pattern": {"type": "string", "description": "Optional: Regex — liefert nur Zeilen, die dem Muster entsprechen."}
                },
                "required": ["path"]
            }),
        ),
        tool(
            "grep_files",
            "Durchsucht Dateiinhalte nach einem regulären Ausdruck und liefert Treffer mit Datei + Zeilennummer. NUTZE: um Code-Symbole, Textstellen oder Muster über viele Dateien hinweg zu finden. Effizienter als viele read_file-Aufrufe, wenn du nur wissen willst, WO etwas steht.",
            json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regulärer Ausdruck (case-sensitive), z. B. \"function\\\\s+foo\" oder \"TODO:\"."},
                    "path": {"type": "string", "description": "Datei oder Verzeichnis, das durchsucht wird. Standard: Arbeitsverzeichnis."},
                    "glob": {"type": "string", "description": "Optional: Dateinamen-Filter (Glob), z. B. \"*.js\". Nur passenden Dateien werden durchsucht."}
                },
                "required": ["pattern"]
            }),
        ),
        tool(
            "write_file",
            "Schreibt Text vollständig in eine Datei (überschreibt vorhandenen Inhalt). Legt fehlende Elternverzeichnisse an. NUTZE: um neue Dateien zu erstellen oder eine Datei komplett neu zu schreiben. NICHT NUTZEN für kleine Änderungen an einer großen Datei — dann edit_file verwenden.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Dateipfad (relativ zum Arbeitsverzeichnis oder absolut)."},
                    "content": {"type": "string", "description": "Neuer Dateiinhalt."}
                },
                "required": ["path", "content"]
            }),
        ),
        tool(
            "edit_file",
            "Ersetzt genau ein Vorkommen von `old_string` durch `new_string` in einer Datei. NUTZE: für gezielte Änderungen an bestehenden Dateien (weniger fehleranfällig als die ganze Datei neu zu schreiben). VORAUSSETZUNG: Rufe ZUERST read_file auf, um den aktuellen Inhalt zu kennen, und übernimm den exakten Textausschnitt als old_string (inkl. Einrückung und Zeilenumbrüchen). old_string darf NICHT leer sein und muss EINDEUTIG in der Datei vorkommen. Schlägt fehl mit empty_old_string / old_string_not_found / old_string_not_unique — lies die Datei dann neu und korrigiere.",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Dateipfad (relativ zum Arbeitsverzeichnis oder absolut)."},
                    "old_string": {"type": "string", "description": "Der exakte Text, der ersetzt werden soll (inkl. Einrückung)."},
                    "new_string": {"type": "string", "description": "Der Text, der anstelle von old_string eingefügt wird."},
                    "replace_all": {"type": "boolean", "description": "Wenn true, werden alle Vorkommen ersetzt. Standard: false (genau ein Vorkommen)."}
                },
                "required": ["path", "old_string", "new_string"]
            }),
        ),
        tool(
            "run_command",
            "Führt einen Shell-/CMD-Befehl im Arbeitsverzeichnis aus und gibt stdout/stderr sowie den Exit-Code als String zurück. NUTZE: für Builds, Tests, git, npm, Windows-CMD, PowerShell, Bash-Skripte und Befehle mit echten Seiteneffekten. VORSICHT: Bestätige destruktive Befehle (rm, Formatierungen, Systemänderungen) vorher mit dem Nutzer. Standard-Timeout: 60 s (max. 120 s). Große Ausgaben werden gekürzt.",
            json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Der auszuführende Shell-/CMD-Befehl."},
                    "cmd": {"type": "string", "description": "Alias für command — derselbe Befehl (nur eines von command/cmd nötig)."},
                    "cwd": {"type": "string", "description": "Optional: Unterverzeichnis im Arbeitsverzeichnis, in dem der Befehl ausgeführt wird."},
                    "timeout_ms": {"type": "integer", "description": "Optional: Timeout in Millisekunden (1000–120000). Standard: 60000."}
                }
            }),
        ),
        tool(
            "web_fetch",
            "Lädt den Inhalt einer öffentlichen HTTP/HTTPS-URL als Text herunter (max. ~200 KB, gekürzt). NUTZE: um Dokumentation, JSON-APIs oder öffentliche Seiten abzurufen, wenn du Live-Informationen brauchst. Beachte: KEINE Authentifizierung, kein Posten, keine interaktiven Seiten. Nur Lesezugriff.",
            json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Vollständige HTTP- oder HTTPS-URL."}
                },
                "required": ["url"]
            }),
        ),
        tool(
            "memory",
            "Persistenter Schlüssel-Wert-Speicher für diesen Agenten (über Chat-Sitzungen hinweg). NUTZE: um dir Notizen, Projektkontext, Entscheidungen oder Teilergebnisse zu merken, die in späteren Anfragen wieder relevant sind. Aktionen: \"get\" (Wert lesen), \"set\" (Wert speichern), \"delete\" (löschen), \"list\" (alle Schlüssel).",
            json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["get", "set", "delete", "list"], "description": "Aktion auf dem Speicher."},
                    "key": {"type": "string", "description": "Schlüssel (für get/set/delete)."},
                    "value": {"type": "string", "description": "Wert (für set)."}
                },
                "required": ["action"]
            }),
        ),
        tool(
            "ask_user",
            "Stellt dem Nutzer eine Rückfrage im Chat und wartet auf die Antwort. NUTZE: wenn eine Entscheidung des Nutzers nötig ist (z. B. welche Variante, ob ein Riskanter Befehl erlaubt ist) oder eine Anforderung mehrdeutig ist. NICHT NUTZEN: für Dinge, die du selbst verantwortlich lösen kannst. Eine Frage pro Schritt.",
            json!({
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Klare, konkrete Frage an den Nutzer."}
                },
                "required": ["question"]
            }),
        ),
        tool(
            "spawn_subagent",
            "Startet einen isolierten Sub-Agenten mit eigenem System-Prompt und eigener Tool-Ausführung, der eine Teilaufgabe selbstständig löst und ein Ergebnis zurückliefert. Der Sub-Agent hat keine Sicht auf diesen Chatverlauf, sondern nur die übergebene Aufgabe. NUTZE: für klar abgegrenzte Teilaufgaben (z. B. \"analysiere Modul X\", \"schreibe Test für Funktion Y\", \"recherchiere API-Endpunkte\"), damit der Haupt-Agent übersichtlich bleibt. Begrenzt auf eine Teilaufgabe pro Aufruf — gib dem Sub-Agenten ein klares Ziel.",
            json!({
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "Klare, eigenständige Aufgabenbeschreibung für den Sub-Agenten."},
                    "tools": {"type": "array", "items": {"type": "string"}, "description": "Optional: Liste der Tool-Namen, die der Sub-Agent nutzen darf. Standard: die sicheren Read-/Schreib-Tools."}
                },
                "required": ["task"]
            }),
        ),
        tool(
            "bluetalk_command",
            "Führt einen registrierten BlueTalk-Plugin-Befehl aus (plugin id + command id) und gibt das Ergebnis zurück. NUTZE: um Aktionen innerhalb von BlueTalk selbst auszulösen (Spiele, Theme-Studio, Kontakte etc.). Wenn du unsicher bist, welche Commands existieren, frage den Nutzer statt zu raten.",
            json!({
                "type": "object",
                "properties": {
                    "pluginId": {"type": "string", "description": "Plugin-ID (z. B. \"poker\", \"uno\", \"theme-studio\")."},
                    "commandId": {"type": "string", "description": "Command-ID des Plugins."},
                    "args": {"type": "object", "description": "Optionale Argumente für den Befehl.", "additionalProperties": true}
                },
                "required": ["pluginId", "commandId"]
            }),
        ),
        tool(
            "read_bluetalk_messages",
            "Liest den Nachrichtenverlauf eines BlueTalk-Kontakts aus dem lokalen Chat (bereits entschlüsselt). NUTZE: um Konversationen nachzulesen oder Kontext aus Chats zu holen. VORAUSSETZUNG: Messaging muss für diesen Agenten erlaubt sein; der Nutzer bestätigt jeden Lesezugriff. Nur echte Kontakt-Peer-IDs — keine KI-Chats.",
            json!({
                "type": "object",
                "properties": {
                    "peer_id": {"type": "string", "description": "Peer-ID des BlueTalk-Kontakts."},
                    "limit": {"type": "integer", "description": "Maximale Anzahl Nachrichten (1–100). Standard: 20."},
                    "skip": {"type": "integer", "description": "Optional: Anzahl neuester Nachrichten überspringen (Pagination)."}
                },
                "required": ["peer_id"]
            }),
        ),
        tool(
            "send_bluetalk_message",
            "Sendet eine Textnachricht an einen BlueTalk-Kontakt (E2EE wird im Client angewendet, wenn aktiv). NUTZE: wenn der Nutzer möchte, dass der Agent jemandem schreibt. DER TOOL-AUFRUF öffnet selbst den verpflichtenden Bestätigungsdialog; nicht vorher separat mit ask_user nachfragen. Die Nachricht gilt erst bei einem Tool-Ergebnis mit ok=true als gesendet. Nur peer_id aus einem aktuellen list_bluetalk_contacts-Ergebnis verwenden — nie raten oder erfinden; keine KI-Chats.",
            json!({
                "type": "object",
                "properties": {
                    "peer_id": {"type": "string", "description": "Peer-ID des BlueTalk-Kontakts."},
                    "content": {"type": "string", "description": "Text der Nachricht."}
                },
                "required": ["peer_id", "content"]
            }),
        ),
        tool(
            "list_bluetalk_contacts",
            "Listet gespeicherte BlueTalk-Kontakte mit Anzeigename, Online-Status und letzter Nachricht. NUTZE ZUERST mit query=<Empfängername>, um eine echte peer_id zu finden, bevor du Chats liest oder Nachrichten sendest. Warte das Ergebnis ab und übernimm nur eine tatsächlich zurückgegebene peer_id; erfinde keine Treffer oder IDs. Optional filterbar per query (Name, Nickname oder ID).",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Optional: Suchbegriff für Name/Nickname/ID."},
                    "include_blocked": {"type": "boolean", "description": "Optional: auch blockierte Kontakte anzeigen (Standard: false)."}
                }
            }),
        ),
        tool(
            "list_bluetalk_peers",
            "Listet aktuell verbundene/online BlueTalk-Peers (nicht nur gespeicherte Kontakte). NUTZE: um zu sehen, wer gerade erreichbar ist.",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "list_bluetalk_chats",
            "Listet Chats mit Metadaten (letzte Nachricht, Anzahl, Kontaktname, Online). NUTZE: für einen Überblick über aktive Unterhaltungen — sortiert nach Aktivität.",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Optional: Filter nach Kontaktname oder peer_id."},
                    "limit": {"type": "integer", "description": "Max. Anzahl (1–50, Standard: 20)."}
                }
            }),
        ),
        tool(
            "get_bluetalk_contact",
            "Liefert Details zu einem BlueTalk-Kontakt (Name, Nickname, Adresse, E2EE, blockiert, letzte Nachricht). NUTZE: wenn du die peer_id kennst und mehr Kontext brauchst.",
            json!({
                "type": "object",
                "properties": {
                    "peer_id": {"type": "string", "description": "Peer-ID des Kontakts."}
                },
                "required": ["peer_id"]
            }),
        ),
        tool(
            "get_bluetalk_self",
            "Liefert Informationen über den eigenen BlueTalk-Account (peer_id, Anzeigename, Endpunkte, verbundene Peers). NUTZE: wenn du wissen musst, wer „du\" in BlueTalk bist oder wie du erreichbar bist.",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "list_bluetalk_plugins",
            "Listet installierte BlueTalk-Plugins mit Status und verfügbaren Command-IDs. NUTZE: bevor du bluetalk_command aufrufst — so siehst du pluginId und commandId.",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "connect_bluetalk_peer",
            "Verbindet zu einem BlueTalk-Peer über Adresse (host:port oder Endpunkt-URL). NUTZE: wenn der Nutzer einen neuen Kontakt hinzufügen oder eine bekannte Adresse erreichen will. VORAUSSETZUNG: Nutzer bestätigt die Verbindung.",
            json!({
                "type": "object",
                "properties": {
                    "address": {"type": "string", "description": "Peer-Adresse, z. B. host:19876 oder ws://…"}
                },
                "required": ["address"]
            }),
        ),
        tool(
            "send_bluetalk_reply",
            "Sendet eine Antwort auf eine bestimmte Nachricht in einem BlueTalk-Chat (Zitat-Antwort). NUTZE: wenn der Nutzer gezielt auf eine Nachricht antworten möchte. reply_to_message_id MUSS die echte messageId der ursprünglichen Nachricht aus einem aktuellen read_bluetalk_messages-Ergebnis sein — niemals conversationId/chatId oder eine erfundene ID. DER TOOL-AUFRUF öffnet selbst den verpflichtenden Bestätigungsdialog; nicht separat mit ask_user nachfragen. Erfolg erst nach dem echten Tool-Ergebnis mit ok=true melden; niemals Ergebnis-JSON selbst schreiben.",
            json!({
                "type": "object",
                "properties": {
                    "peer_id": {"type": "string", "description": "Peer-ID des Kontakts."},
                    "content": {"type": "string", "description": "Text der Antwort."},
                    "reply_to_message_id": {"type": "string", "description": "Exakte messageId der ursprünglichen Nachricht aus read_bluetalk_messages; keine conversationId oder chatId."}
                },
                "required": ["peer_id", "content", "reply_to_message_id"]
            }),
        ),
    ]
}

/// Namen aller Agent-Tools.
pub fn agent_tool_names() -> Vec<String> {
    agent_tools()
        .iter()
        .filter_map(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

pub const BLUETALK_AGENT_TOOL_NAMES: &[&str] = &[
    "list_bluetalk_contacts",
    "list_bluetalk_peers",
    "list_bluetalk_chats",
    "get_bluetalk_contact",
    "get_bluetalk_self",
    "list_bluetalk_plugins",
    "connect_bluetalk_peer",
    "read_bluetalk_messages",
    "send_bluetalk_message",
    "send_bluetalk_reply",
    "bluetalk_command",
];

pub fn is_bluetalk_agent_tool(name: &str) -> bool {
    BLUETALK_AGENT_TOOL_NAMES.contains(&name)
}

/// Werkzeug-Sätze pro Modell-Stufe (wie v1 `AI_AGENT_TOOL_SETS`).
pub fn tool_set_for_tier(tier_id: &str) -> Vec<&'static str> {
    match tier_id {
        "fast" => vec![
            "list_files",
            "read_file",
            "extract_file",
            "write_file",
            "run_command",
            "memory",
        ],
        "normal" => vec![
            "list_files",
            "search_files",
            "read_file",
            "extract_file",
            "grep_files",
            "write_file",
            "edit_file",
            "run_command",
            "memory",
            "ask_user",
            "list_bluetalk_contacts",
            "list_bluetalk_peers",
            "list_bluetalk_chats",
            "get_bluetalk_contact",
            "get_bluetalk_self",
            "read_bluetalk_messages",
            "send_bluetalk_message",
            "send_bluetalk_reply",
        ],
        "normal+" => vec![
            "list_files",
            "search_files",
            "read_file",
            "extract_file",
            "grep_files",
            "write_file",
            "edit_file",
            "run_command",
            "web_fetch",
            "memory",
            "ask_user",
            "bluetalk_command",
            "list_bluetalk_contacts",
            "list_bluetalk_peers",
            "list_bluetalk_chats",
            "get_bluetalk_contact",
            "get_bluetalk_self",
            "list_bluetalk_plugins",
            "connect_bluetalk_peer",
            "read_bluetalk_messages",
            "send_bluetalk_message",
            "send_bluetalk_reply",
        ],
        "ornith" | "smart" | "cloud" => agent_tool_names_static(),
        _ => tool_set_for_tier(AI_CHAT_DEFAULT_TIER_ID),
    }
}

fn agent_tool_names_static() -> Vec<&'static str> {
    vec![
        "list_files",
        "search_files",
        "read_file",
        "extract_file",
        "grep_files",
        "write_file",
        "edit_file",
        "run_command",
        "web_fetch",
        "memory",
        "ask_user",
        "spawn_subagent",
        "bluetalk_command",
        "read_bluetalk_messages",
        "send_bluetalk_message",
        "list_bluetalk_contacts",
        "list_bluetalk_peers",
        "list_bluetalk_chats",
        "get_bluetalk_contact",
        "get_bluetalk_self",
        "list_bluetalk_plugins",
        "connect_bluetalk_peer",
        "send_bluetalk_reply",
    ]
}

/// Liefert die für eine Modell-Stufe erlaubten Tool-Definitionen.
pub fn get_tools_for_tier(tier_id: &str) -> Vec<Value> {
    let id = if is_valid_model_tier(tier_id) {
        tier_id
    } else {
        AI_CHAT_DEFAULT_TIER_ID
    };
    let allowed = tool_set_for_tier(id);
    agent_tools()
        .into_iter()
        .filter(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .map(|name| allowed.contains(&name))
                .unwrap_or(false)
        })
        .collect()
}

/// Kurze Prompt-Hinweise pro Tool.
pub fn tool_prompt_hint(name: &str) -> &'static str {
    match name {
        "list_files" => "Verzeichnisinhalt auflisten — Orientierung vor dem Lesen",
        "search_files" => "Dateien per Glob-Muster finden (z. B. \"**/*.js\")",
        "read_file" => "Dateiinhalt als String lesen — Pflicht vor edit_file",
        "extract_file" => "Textausschnitt aus Datei extrahieren (Zeilenbereich oder Regex)",
        "grep_files" => "Text/Regex in Dateien suchen — schneller als alles blind lesen",
        "write_file" => "Neue Datei erstellen oder Datei komplett überschreiben",
        "edit_file" => "Gezielte Änderung in bestehender Datei (exakter old_string)",
        "run_command" => "Shell-/CMD-Befehl ausführen (Build, Test, git, npm, …)",
        "web_fetch" => "HTTP/HTTPS-URL abrufen — Live-Doku, APIs, öffentliche Seiten",
        "memory" => "Persistente Notizen lesen/schreiben (über Chats hinweg)",
        "ask_user" => "Nutzer im Chat eine Rückfrage stellen und auf Antwort warten",
        "spawn_subagent" => "Teilaufgabe an isolierten Sub-Agenten delegieren",
        "bluetalk_command" => "BlueTalk-Plugin-Befehl ausführen (Spiele, Theme, …)",
        "list_bluetalk_contacts" => "BlueTalk-Kontakte auflisten (peer_id finden)",
        "list_bluetalk_peers" => "Aktuell verbundene BlueTalk-Peers anzeigen",
        "list_bluetalk_chats" => "Chat-Übersicht mit letzter Nachricht",
        "get_bluetalk_contact" => "Details zu einem BlueTalk-Kontakt",
        "get_bluetalk_self" => "Eigene BlueTalk-Identität und Endpunkte",
        "list_bluetalk_plugins" => "Installierte Plugins und Commands auflisten",
        "connect_bluetalk_peer" => "Neuen Peer verbinden (mit Nutzer-Bestätigung)",
        "read_bluetalk_messages" => "BlueTalk-Chatverlauf lesen (mit Nutzer-Erlaubnis)",
        "send_bluetalk_message" => "BlueTalk-Nachricht senden (mit Nutzer-Erlaubnis)",
        "send_bluetalk_reply" => "Antwort auf eine Nachricht senden (mit Nutzer-Erlaubnis)",
        _ => "",
    }
}

/// Baut einen System-Prompt-Abschnitt mit der konkreten Tool-Liste der Stufe.
pub fn build_agent_tools_prompt_section(tier_id: &str) -> String {
    let tools = get_tools_for_tier(tier_id);
    if tools.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    for t in &tools {
        let name = t
            .get("function")
            .and_then(|f| f.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let hint = tool_prompt_hint(name);
        let hint = if hint.is_empty() {
            t.get("function")
                .and_then(|f| f.get("description"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .split('.')
                .next()
                .unwrap_or("")
                .to_string()
        } else {
            hint.to_string()
        };
        lines.push(format!("- **{name}** — {hint}"));
    }
    let mut section = String::from("## Verfügbare Tools (JETZT aktiv — unbedingt nutzen!)\n");
    section.push_str(&format!(
        "Du hast in diesem Chat **{} echte Werkzeuge**. Sie sind angebunden und werden vom System ausgeführt, wenn du sie per Function Calling aufrufst.\n\n",
        tools.len()
    ));
    section.push_str(
        "**Regeln:**\n- Handlungsorientierte Anfrage → zuerst passendes Tool aufrufen, dann antworten.\n- Nie behaupten, du könntest keine Dateien/Befehle/URLs nutzen — du hast die Tools oben.\n- Nie Tool-Ergebnisse erfinden oder simulieren.\n- Tools per Function Calling aufrufen — nicht als JSON-Text in der Antwort schreiben.\n\nDeine Tools für diese Modell-Stufe:\n",
    );
    section.push_str(&lines.join("\n"));
    section
}

