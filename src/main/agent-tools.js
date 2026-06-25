const { exec } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const net = require('net');
const {
  AI_AGENT_TOOL_NAMES,
  AI_AGENT_TOOLS,
  getToolsForTier,
  getSystemPromptForTier,
  AI_CHAT_DEFAULT_TIER_ID,
} = require(path.join(__dirname, '..', 'shared', 'ai-chat-constants.js'));

/**
 * Glob-Matching (minimale Implementierung, ausreichend für typische
 * Dateisuche im Agent-Kontext). Unterstützt *, ** und ?.
 */
function globToRegex(pattern) {
  let i = 0;
  let regex = '';
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        regex += '.*';
        i += 2;
        if (pattern[i] === '/' || pattern[i] === '\\') i += 1;
        continue;
      }
      regex += '[^/\\\\]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      regex += '[^/\\\\]';
      i += 1;
      continue;
    }
    if ('.+^$(){}|[]\\'.includes(c)) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`, 'i');
}

function matchesGlob(filePath, pattern) {
  return globToRegex(pattern).test(filePath.replace(/\\/g, '/'));
}

function defaultWorkDir() {
  const home = os.homedir();
  const desktop = path.join(home, 'Desktop');
  try {
    if (fs.existsSync(desktop)) return desktop;
  } catch {
    /* ignore */
  }
  return home;
}

/** Löst einen (relativen) Pfad gegen das Arbeitsverzeichnis auf. */
function resolvePath(workDir, rawPath) {
  const root = path.resolve(String(workDir || defaultWorkDir()));
  const p = String(rawPath || '').trim();
  if (!p) return root;
  if (path.isAbsolute(p)) return path.resolve(p);
  return path.resolve(root, p);
}

function assertInsideWorkDir(workDir, resolved) {
  const root = path.resolve(String(workDir || defaultWorkDir()));
  const target = path.resolve(String(resolved || root));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error(`Pfad liegt außerhalb des Arbeitsverzeichnisses: ${resolved}`);
    err.code = 'outside_workdir';
    throw err;
  }
}

function truncate(value, max = 20000) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[gekürzt, ${s.length - max} Zeichen entfernt]`;
}

function relOfWorkDir(workDir, absPath) {
  if (!absPath) return absPath;
  const rel = path.relative(path.resolve(String(workDir || defaultWorkDir())), path.resolve(absPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absPath;
  return rel;
}

async function read_file({ path: rawPath }, ctx) {
  const target = resolvePath(ctx.workDir, rawPath);
  assertInsideWorkDir(ctx.workDir, target);
  const buf = await fsPromises.readFile(target);
  const text = buf.toString('utf8');
  return { ok: true, path: target, content: truncate(text), bytes: buf.length };
}

async function write_file({ path: rawPath, content }, ctx) {
  const target = resolvePath(ctx.workDir, rawPath);
  assertInsideWorkDir(ctx.workDir, target);
  await fsPromises.mkdir(path.dirname(target), { recursive: true });
  await fsPromises.writeFile(target, String(content ?? ''), 'utf8');
  return { ok: true, path: target, bytes: Buffer.byteLength(String(content ?? ''), 'utf8') };
}

async function edit_file({ path: rawPath, old_string, new_string, replace_all }, ctx) {
  const target = resolvePath(ctx.workDir, rawPath);
  assertInsideWorkDir(ctx.workDir, target);
  const oldStr = String(old_string ?? '');
  const newStr = String(new_string ?? '');
  if (!oldStr) {
    return {
      ok: false,
      error: 'empty_old_string',
      hint: 'old_string darf nicht leer sein. Lies die Datei zuerst mit read_file, kopiere den exakten Textausschnitt (inkl. Einrückung), den du ersetzen willst, und übergebe ihn als old_string.',
    };
  }
  const original = await fsPromises.readFile(target, 'utf8');
  if (!original.includes(oldStr)) {
    return {
      ok: false,
      error: 'old_string_not_found',
      path: target,
      hint: 'Der übergebene old_string stimmt nicht exakt mit dem Dateiinhalt überein (Einrückung, Zeilenumbrüche, Tippfehler?). Lies die Datei mit read_file neu und kopiere den exakten Ausschnitt.',
    };
  }
  if (!replace_all) {
    const firstIdx = original.indexOf(oldStr);
    const secondIdx = original.indexOf(oldStr, firstIdx + 1);
    if (secondIdx !== -1) {
      return {
        ok: false,
        error: 'old_string_not_unique',
        path: target,
        hint: 'old_string kommt mehrfach vor. Erweitere old_string um mehr Kontext (z. B. die umgebenden Zeilen), damit es eindeutig wird, oder setze replace_all=true.',
      };
    }
  }
  const updated = replace_all
    ? original.split(oldStr).join(newStr)
    : original.replace(oldStr, newStr);
  await fsPromises.writeFile(target, updated, 'utf8');
  return {
    ok: true,
    path: target,
    replacements: replace_all
      ? original.split(oldStr).length - 1
      : 1,
  };
}

async function list_files({ path: rawPath } = {}, ctx) {
  const target = rawPath ? resolvePath(ctx.workDir, rawPath) : ctx.workDir;
  assertInsideWorkDir(ctx.workDir, target);
  const entries = await fsPromises.readdir(target, { withFileTypes: true });
  const items = entries.map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'dir' : 'file',
  }));
  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { ok: true, path: target, entries: items };
}

/** Rekursive Glob-Suche im Dateisystem. */
async function search_files({ pattern, path: rawPath } = {}, ctx) {
  const root = rawPath ? resolvePath(ctx.workDir, rawPath) : ctx.workDir;
  assertInsideWorkDir(ctx.workDir, root);
  const glob = String(pattern || '*');
  const matches = [];
  const stack = [root];
  const seen = new Set();
  let visited = 0;
  const MAX_FILES = 2000;
  while (stack.length) {
    if (visited > MAX_FILES) break;
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isFile() && matchesGlob(rel, glob)) {
        matches.push(relOfWorkDir(ctx.workDir, full));
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        stack.push(full);
      }
    }
  }
  matches.sort();
  return { ok: true, root, pattern: glob, matches: matches.slice(0, 500) };
}

/** Durchsucht Dateiinhalte nach einem regulären Ausdruck (case-sensitive). */
async function grep_files({ pattern, path: rawPath, glob } = {}, ctx) {
  const root = rawPath ? resolvePath(ctx.workDir, rawPath) : ctx.workDir;
  assertInsideWorkDir(ctx.workDir, root);
  let re;
  try {
    re = new RegExp(String(pattern || ''), '');
  } catch (e) {
    return { ok: false, error: `invalid_regex: ${e?.message || e}` };
  }
  const globRe = glob ? globToRegex(glob) : null;
  const results = [];
  const stack = [root];
  const seen = new Set();
  let visited = 0;
  const MAX_FILES = 500;
  const MAX_MATCHES = 100;
  while (stack.length) {
    if (visited > MAX_FILES) break;
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          stack.push(full);
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const relName = entry.name;
      if (globRe && !globRe.test(relName)) continue;
      let content;
      try {
        content = await fsPromises.readFile(full, 'utf8');
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i])) {
          results.push({
            path: relOfWorkDir(ctx.workDir, full),
            line: i + 1,
            text: truncate(lines[i], 240),
          });
          if (results.length >= MAX_MATCHES) {
            return {
              ok: true,
              root,
              pattern: String(pattern),
              matches: results,
              truncated: true,
            };
          }
          break; // nur erstes Treffer pro Datei, um Ergebnis kompakt zu halten
        }
      }
    }
  }
  return { ok: true, root, pattern: String(pattern), matches: results };
}

function isBlockedFetchHostname(hostname) {
  const raw = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!raw) return true;
  if (raw === 'localhost' || raw.endsWith('.localhost')) return true;

  const ipVersion = net.isIP(raw);
  if (ipVersion === 4) {
    const parts = raw.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224
    );
  }

  if (ipVersion === 6) {
    if (raw === '::' || raw === '::1') return true;
    if (raw.startsWith('fe80:') || raw.startsWith('fc') || raw.startsWith('fd')) return true;
    if (raw.startsWith('::ffff:')) {
      return isBlockedFetchHostname(raw.slice('::ffff:'.length));
    }
  }

  return false;
}

function run_command({ command }, ctx) {
  return new Promise((resolve) => {
    const cmd = String(command ?? '');
    if (!cmd.trim()) {
      resolve({ ok: false, error: 'empty_command', exitCode: -1 });
      return;
    }
    exec(
      cmd,
      {
        cwd: ctx.workDir,
        timeout: 60_000,
        maxBuffer: 1024 * 1024 * 2,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const exitCode = err ? (err.code ?? 1) : 0;
        resolve({
          ok: !err || exitCode === 0,
          exitCode,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          error: err && exitCode !== 0 ? String(err.message) : undefined,
        });
      }
    );
  });
}

/** Lädt eine öffentliche URL als Text herunter (max. ~200 KB). */
function web_fetch({ url }, _ctx, redirectsLeft = 5) {
  return new Promise((resolve) => {
    const target = String(url || '').trim();
    let parsedUrl;
    try {
      parsedUrl = new URL(target);
    } catch {
      resolve({ ok: false, error: 'invalid_url' });
      return;
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      resolve({ ok: false, error: 'invalid_url' });
      return;
    }
    if (isBlockedFetchHostname(parsedUrl.hostname)) {
      resolve({ ok: false, error: 'blocked_private_url' });
      return;
    }
    const lib = target.startsWith('https') ? https : http;
    const req = lib.get(target, { timeout: 15_000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          resolve({ ok: false, error: 'too_many_redirects' });
          return;
        }
        const next = new URL(res.headers.location, target).toString();
        resolve(web_fetch({ url: next }, _ctx, redirectsLeft - 1));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        resolve({ ok: false, error: `http_${res.statusCode}` });
        return;
      }
      const chunks = [];
      let total = 0;
      const MAX = 200 * 1024;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX) {
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: true, url: target, statusCode: res.statusCode, content: truncate(body, 200000) });
      });
      res.on('error', (e) => resolve({ ok: false, error: e?.message || 'fetch_failed' }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', (e) => resolve({ ok: false, error: e?.message || 'fetch_failed' }));
  });
}

/**
 * Persistenter Schlüssel-Wert-Speicher pro Agent (peerId). Wird im
 * Main-Kontext (`ctx.memory`) bereitgestellt und an den Handler gebunden.
 */
function memory({ action, key, value } = {}, ctx) {
  const store = ctx.memory;
  if (!store) return { ok: false, error: 'memory_unavailable' };
  const act = String(action || '').toLowerCase();
  const k = String(key || '').trim();
  if (act === 'list') {
    return { ok: true, keys: Object.keys(store) };
  }
  if (act === 'get') {
    if (!k) return { ok: false, error: 'missing_key' };
    return { ok: true, key: k, value: Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null };
  }
  if (act === 'set') {
    if (!k) return { ok: false, error: 'missing_key' };
    store[k] = String(value ?? '').slice(0, 20000);
    return { ok: true, key: k };
  }
  if (act === 'delete') {
    if (!k) return { ok: false, error: 'missing_key' };
    delete store[k];
    return { ok: true, key: k };
  }
  return { ok: false, error: `unknown_action: ${act}` };
}

/**
 * Extrahiert die Text-Antwort aus dem askUser-Callback (String oder Ergebnis-Objekt).
 */
function normalizeAskUserReply(reply) {
  if (reply == null) return '';
  if (typeof reply === 'string') return reply.trim();
  if (typeof reply === 'object') {
    if (typeof reply.answer === 'string') return reply.answer.trim();
    if (typeof reply.content === 'string') return reply.content.trim();
  }
  return '';
}

/**
 * Fragt den Nutzer asynchron über einen Renderer-Dialog nach einer Antwort.
 * Das Tool blockiert, bis der Nutzer geantwortet hat, und gibt die Antwort
 * als Tool-Ergebnis ans Modell zurück. So kann der Agent direkt mit der
 * Antwort weiterarbeiten.
 *
 * Wenn kein interaktiver Callback verfügbar ist (z. B. im Sub-Agenten),
 * wird die Frage als nicht beantwortet zurückgegeben, damit das Modell sie
 * selbst im Text stellen kann.
 */
async function ask_user({ question }, ctx) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, error: 'empty_question' };
  if (typeof ctx.askUser !== 'function') {
    return {
      ok: true,
      pending_user: true,
      answered: false,
      question: q,
      note: 'Kein interaktiver Dialog verfügbar. Stelle die Frage im Text.',
    };
  }
  try {
    const reply = await ctx.askUser(q);
    const answer = normalizeAskUserReply(reply);
    if (!answer) {
      return {
        ok: true,
        answered: false,
        question: q,
        answer: '',
        note: 'Der Nutzer hat die Frage übersprungen. Fahre ohne Antwort fort.',
      };
    }
    return {
      ok: true,
      answered: true,
      question: q,
      answer: answer.slice(0, 8000),
    };
  } catch (e) {
    return { ok: false, error: e?.message || 'ask_user_failed', question: q };
  }
}

/**
 * Startet einen Sub-Agenten: eigenständiger Ollama-Chat mit eigenem
 * System-Prompt, eigenem Tool-Satz und eigenem Loop. Der Sub-Agent
 * bekommt nur die übergebene Aufgabe, keinen Chatverlauf.
 */
async function spawn_subagent({ task, tools } = {}, ctx) {
  if (!ctx.subagentRunner) {
    return { ok: false, error: 'subagent_unavailable' };
  }
  const t = String(task || '').trim();
  if (!t) return { ok: false, error: 'empty_task' };
  const tier = ctx.subagentTier || AI_CHAT_DEFAULT_TIER_ID;
  const allowedTools = Array.isArray(tools) && tools.length
    ? tools.filter((n) => AI_AGENT_TOOL_NAMES.includes(n))
    : ['list_files', 'search_files', 'read_file', 'grep_files', 'write_file', 'edit_file', 'run_command', 'web_fetch', 'memory'];
  const toolDefs = getToolsForTier(tier).filter((def) => allowedTools.includes(def.function.name));
  const systemPrompt = getSystemPromptForTier(tier, true)
    + `\n\n## Sub-Agenten-Auftrag\nDu wurdest als Sub-Agent gestartet. Du hast keinen Zugriff auf den Haupt-Chatverlauf. Löse NUR die folgende Aufgabe und gib ein klares Ergebnis zurück. Halte dich knapp.\n\n**Wichtig:** Du hast aktive Tools — rufe sie per Function Calling auf, simuliere keine Dateiinhalte oder Befehlsausgaben. Tool-Ergebnisse (role „tool", mit [SYSTEM-TOOL-ERGEBNIS …]) kommen vom System — nicht vom Nutzer.\n\nArbeitsverzeichnis: ${ctx.workDir}`;
  try {
    const result = await ctx.subagentRunner({
      task: t,
      systemPrompt,
      tools: toolDefs,
      workDir: ctx.workDir,
      memory: ctx.memory,
      invokePluginCommand: ctx.invokePluginCommand,
    });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e?.message || 'subagent_failed' };
  }
}

async function bluetalk_command({ pluginId, commandId, args } = {}, ctx) {
  if (!ctx.invokePluginCommand) {
    return { ok: false, error: 'plugin_host_unavailable' };
  }
  try {
    const result = await ctx.invokePluginCommand(
      String(pluginId || ''),
      String(commandId || ''),
      args && typeof args === 'object' ? args : {}
    );
    return { ok: result?.ok !== false, result };
  } catch (e) {
    return { ok: false, error: e?.message || 'bluetalk_command_failed' };
  }
}

const TOOL_HANDLERS = {
  list_files,
  search_files,
  read_file,
  grep_files,
  write_file,
  edit_file,
  run_command,
  web_fetch,
  memory,
  ask_user,
  spawn_subagent,
  bluetalk_command,
};

/**
 * Normalisiert ein geparstes JSON-Objekt zu einem Tool-Call im
 * OpenAI/Ollama-Schema ({ type:'function', function:{ name, arguments } }).
 * Akzeptiert sowohl { name, arguments } als auch { function:{...} }.
 * Liefert null, wenn kein gültiger Tool-Name erkannt wird.
 */
/**
 * Normalisiert ein geparstes JSON-Objekt zu einem Tool-Call im
 * OpenAI/Ollama-Schema ({ type:'function', function:{ name, arguments } }).
 * Akzeptiert mehrere vom Modell erzeugte Formen:
 *   1. { name, arguments }
 *   2. { function: { name, arguments } }   (OpenAI/Ollama-Schema)
 *   3. { function: "<name>", arguments }   (häufige Abweichung kleiner Modelle)
 * Liefert null, wenn kein gültiger Tool-Name erkannt wird.
 */
function normalizeToolCall(obj, validNames) {
  if (!obj || typeof obj !== 'object') return null;
  let name = '';
  let args;
  if (obj.function && typeof obj.function === 'object') {
    // Form 2: { function: { name, arguments } }
    name = String(obj.function.name || '').trim();
    args = obj.function.arguments;
  } else if (typeof obj.function === 'string') {
    // Form 3: { function: "<name>", arguments }
    name = String(obj.function || '').trim();
    args = obj.arguments;
  } else {
    // Form 1: { name, arguments }
    name = String(obj.name || '').trim();
    args = obj.arguments;
  }
  if (!name || !validNames.includes(name)) return null;
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : {};
    } catch {
      // Wenn arguments kein gültiges JSON ist, als leeres Objekt übergeben
      args = {};
    }
  }
  if (args == null || typeof args !== 'object') args = {};
  return { type: 'function', function: { name, arguments: args } };
}

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    const parsed = lenientJsonParse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  }
  return {};
}

/**
 * Ollama erwartet tool_calls[].function.arguments als Objekt, nicht als
 * JSON-String. String-Arguments führen beim Replay in der History zu:
 * "Value looks like object, but can't find closing '}' symbol".
 */
function normalizeToolCallsForOllama(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => {
    const fn = call?.function || {};
    const name = String(fn.name || call?.name || '').trim();
    const args = parseToolArguments(fn.arguments ?? call?.arguments);
    const out = {
      type: call?.type || 'function',
      function: { name, arguments: args },
    };
    if (call?.id) out.id = call.id;
    return out;
  }).filter((call) => call.function.name);
}

function sanitizeMessagesForOllama(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((msg) => {
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) {
      return msg;
    }
    return {
      ...msg,
      tool_calls: normalizeToolCallsForOllama(msg.tool_calls),
    };
  });
}

/** Formatiert Tool-Ergebnisse eindeutig als System-Output — nicht als Nutzer-Nachricht. */
function formatToolResultMessageContent(toolName, toolResult) {
  const name = String(toolName || 'unknown').trim() || 'unknown';

  if (name === 'ask_user' && toolResult && typeof toolResult === 'object') {
    const lines = [
      '[SYSTEM-TOOL-ERGEBNIS — automatisch von BlueTalk ausgeführt, nicht vom Nutzer geschrieben]',
      'Tool: ask_user',
    ];
    if (toolResult.question) lines.push(`Gestellte Frage: ${String(toolResult.question)}`);
    if (toolResult.answered && toolResult.answer) {
      lines.push(`Nutzer-Antwort (via Rückfrage-Dialog): ${String(toolResult.answer)}`);
    } else if (toolResult.note) {
      lines.push(`Status: ${String(toolResult.note)}`);
    } else {
      lines.push('Nutzer hat nicht geantwortet oder die Frage wurde übersprungen.');
    }
    if (toolResult.error) lines.push(`Fehler: ${String(toolResult.error)}`);
    return lines.join('\n');
  }

  const payload = typeof toolResult === 'string'
    ? toolResult
    : JSON.stringify(toolResult ?? {}, null, 0);
  const body = payload.slice(0, 20000);
  return [
    '[SYSTEM-TOOL-ERGEBNIS — automatisch von BlueTalk ausgeführt, nicht vom Nutzer geschrieben]',
    `Tool: ${name}`,
    'Ergebnis (JSON):',
    body,
  ].join('\n');
}

function tryParseToolCall(jsonStr, validNames) {
  const obj = lenientJsonParse(jsonStr);
  if (obj == null) return null;
  if (Array.isArray(obj)) {
    const calls = obj.map((o) => normalizeToolCall(o, validNames)).filter(Boolean);
    return calls.length ? calls : null;
  }
  const single = normalizeToolCall(obj, validNames);
  return single ? [single] : null;
}

/**
 * Fehlertolerantes JSON-Parsing für als-Text-geschriebene Tool-Aufrufe.
 * Kleine Modelle machen typische Fehler:
 *   1. Windows-Pfade mit einfachen Backslashes: "C:\Users\..."  (\U invalid)
 *   2. Unescapete Anführungszeichen in HTML-/Code-Strings:
 *      "content": "<meta charset="UTF-8">"  ← schließt den String zu früh
 *
 * Wir probieren drei Versuche: strenges JSON, Backslash-Fix und ein
 * strings-aware-Scan, der innere " erkennt und escapet.
 */
function lenientJsonParse(str) {
  const s = String(str || '').trim();
  if (!s) return null;
  // Versuch 1: streng
  try {
    return JSON.parse(s);
  } catch {
    /* fall through */
  }
  // Versuch 2: nicht-escapete Backslashes escapen
  const bsFixed = s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
  try {
    return JSON.parse(bsFixed);
  } catch {
    /* fall through */
  }
  // Versuch 3: strings-aware — innere unescapete " escapen
  const quoteFixed = escapeInnerQuotes(bsFixed);
  if (quoteFixed === bsFixed) return null; // nichts zu reparieren gewesen
  try {
    return JSON.parse(quoteFixed);
  } catch {
    return null;
  }
}

/**
 * Scannt JSON-Zeichen für Zeichen, führt String-Limits korrekt mit und
 * escapet unescapete `"` innerhalb von Strings. Ein `"` gilt als
 * String-ENDE, wenn danach (whitespace-skipped) ein JSON-Strukturzeichen
 * folgt: : , } ] — sonst ist es ein inneres, unescapetes " und wird zu \".
 */
function escapeInnerQuotes(input) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (!inStr) {
      if (c === '"') {
        inStr = true;
        esc = false;
      }
      out += c;
      continue;
    }
    // inStr === true
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === '\\') {
      out += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      // Prüfe, ob danach ein Strukturzeichen folgt (whitespace-skipped).
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j += 1;
      const next = input[j];
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === undefined) {
        // echtes String-Ende
        inStr = false;
        out += c;
      } else {
        // inneres, unescapetes " -> escapen
        out += '\\"';
      }
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Extrahiert aus dem Textinhalt einer Modellantwort eingebettete
 * Tool-Aufrufe — sowohl in ```json ... ```-Codeblöcken als auch als
 * rohe {...}-Objekte. Wird genutzt, wenn kleine Modelle den Tool-Aufruf
 * als Text schreiben statt über das native tool_calls-Feld.
 *
 * @returns {{ calls: Array, cleanedText: string }}
 */
function extractToolCallsFromText(text, validNames) {
  const s = String(text || '');
  const calls = [];
  const removals = [];

  // 1) Eingezäunte Codeblöcke (```json ... ``` oder ``` ... ```)
  const fenceRe = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(s)) !== null) {
    const inner = m[1].trim();
    const parsed = tryParseToolCall(inner, validNames);
    if (parsed) {
      calls.push(...parsed);
      removals.push([m.index, fenceRe.lastIndex]);
    }
  }

  // 2) Rohe {...}-Objekte mit name/arguments (nur wenn noch keine gefunden)
  if (!calls.length) {
    let i = s.indexOf('{');
    while (i !== -1) {
      let depth = 0;
      let j = i;
      let inStr = false;
      let esc = false;
      for (; j < s.length; j += 1) {
        const c = s[j];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j < s.length) {
        const slice = s.slice(i, j + 1);
        const parsed = tryParseToolCall(slice, validNames);
        if (parsed) {
          calls.push(...parsed);
          removals.push([i, j + 1]);
          break; // ein Tool-Aufruf pro Rohtext-Scan reicht meist
        }
        i = s.indexOf('{', i + 1);
      } else {
        break;
      }
    }
  }

  if (!calls.length) return { calls: [], cleanedText: s };

  // Entferne die gefundenen spans aus dem Anzeigetext
  removals.sort((a, b) => a[0] - b[0]);
  let cleaned = '';
  let cursor = 0;
  for (const [start, end] of removals) {
    cleaned += s.slice(cursor, start);
    cursor = end;
  }
  cleaned += s.slice(cursor);
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { calls, cleanedText: cleaned };
}

/**
 * Führt einen einzelnen Tool-Aufruf aus.
 * @param {{ name: string, arguments: string|object }} toolCall
 * @param {{ workDir: string, invokePluginCommand?: Function, memory?: object, subagentRunner?: Function, subagentTier?: string }} ctx
 */
async function executeToolCall(toolCall, ctx) {
  const name = String(toolCall?.name || toolCall?.function?.name || '').trim();
  if (!AI_AGENT_TOOL_NAMES.includes(name)) {
    return { ok: false, error: `unknown_tool: ${name}` };
  }
  let parsedArgs = {};
  const rawArgs = toolCall?.arguments ?? toolCall?.function?.arguments;
  if (typeof rawArgs === 'string') {
    try {
      parsedArgs = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, error: 'invalid_tool_args_json' };
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    parsedArgs = rawArgs;
  }
  const handler = TOOL_HANDLERS[name];
  try {
    return await handler(parsedArgs, ctx);
  } catch (e) {
    return { ok: false, error: e?.message || 'tool_failed', code: e?.code };
  }
}

module.exports = {
  defaultWorkDir,
  resolvePath,
  executeToolCall,
  TOOL_HANDLERS,
  globToRegex,
  matchesGlob,
  extractToolCallsFromText,
  normalizeToolCall,
  normalizeToolCallsForOllama,
  sanitizeMessagesForOllama,
  formatToolResultMessageContent,
  normalizeAskUserReply,
  parseToolArguments,
};
