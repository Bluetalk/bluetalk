const { exec } = require('child_process');
const { randomUUID } = require('crypto');
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
  isAiChatPeerId,
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

function extractTextFromFile(text, { start_line, end_line, max_lines, pattern } = {}) {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;

  if (pattern != null && String(pattern).trim()) {
    let re;
    try {
      re = new RegExp(String(pattern), '');
    } catch (e) {
      return { ok: false, error: `invalid_regex: ${e?.message || e}` };
    }
    const matched = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (re.test(lines[i])) {
        matched.push({ line: i + 1, text: lines[i] });
      }
    }
    const limit = max_lines != null
      ? Math.max(1, Math.min(Number(max_lines), matched.length))
      : matched.length;
    const slice = matched.slice(0, limit);
    return {
      ok: true,
      content: slice.map((entry) => entry.text).join('\n'),
      total_lines: totalLines,
      matched_lines: slice.length,
      line_range: slice.length
        ? { start_line: slice[0].line, end_line: slice[slice.length - 1].line }
        : null,
    };
  }

  const start = Math.max(1, Number(start_line) || 1);
  let end = end_line != null ? Math.min(totalLines, Number(end_line)) : totalLines;
  if (end < start) end = start;
  if (max_lines != null) {
    end = Math.min(end, start + Math.max(1, Number(max_lines)) - 1);
  }
  const slice = lines.slice(start - 1, end);
  return {
    ok: true,
    content: slice.join('\n'),
    total_lines: totalLines,
    line_range: { start_line: start, end_line: start + slice.length - 1 },
  };
}

async function readFileContent(target, extraction = {}) {
  const buf = await fsPromises.readFile(target);
  const text = buf.toString('utf8');
  const hasExtraction = extraction.start_line != null
    || extraction.end_line != null
    || extraction.max_lines != null
    || (extraction.pattern != null && String(extraction.pattern).trim());
  if (!hasExtraction) {
    return { ok: true, path: target, content: truncate(text), bytes: buf.length };
  }
  const extracted = extractTextFromFile(text, extraction);
  if (!extracted.ok) return extracted;
  return {
    ok: true,
    path: target,
    content: truncate(extracted.content),
    bytes: buf.length,
    total_lines: extracted.total_lines,
    line_range: extracted.line_range,
    matched_lines: extracted.matched_lines,
  };
}

async function read_file({ path: rawPath, start_line, end_line, max_lines }, ctx) {
  const target = resolvePath(ctx.workDir, rawPath);
  assertInsideWorkDir(ctx.workDir, target);
  return readFileContent(target, { start_line, end_line, max_lines });
}

async function extract_file({ path: rawPath, start_line, end_line, max_lines, pattern }, ctx) {
  const target = resolvePath(ctx.workDir, rawPath);
  assertInsideWorkDir(ctx.workDir, target);
  return readFileContent(target, { start_line, end_line, max_lines, pattern });
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

function run_command({ command, cmd, cwd, timeout_ms } = {}, ctx) {
  return new Promise((resolve) => {
    const shellCmd = String(command ?? cmd ?? '');
    if (!shellCmd.trim()) {
      resolve({ ok: false, error: 'empty_command', exitCode: -1 });
      return;
    }
    let workDir = ctx.workDir;
    if (cwd != null && String(cwd).trim()) {
      try {
        workDir = resolvePath(ctx.workDir, cwd);
        assertInsideWorkDir(ctx.workDir, workDir);
      } catch (e) {
        resolve({ ok: false, error: e?.message || 'invalid_cwd', exitCode: -1, code: e?.code });
        return;
      }
    }
    const timeout = Math.min(120_000, Math.max(1000, Number(timeout_ms) || 60_000));
    exec(
      shellCmd,
      {
        cwd: workDir,
        shell: true,
        timeout,
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
  const subagentId = randomUUID();
  const tier = ctx.subagentTier || AI_CHAT_DEFAULT_TIER_ID;
  const allowedTools = Array.isArray(tools) && tools.length
    ? tools.filter((n) => AI_AGENT_TOOL_NAMES.includes(n))
    : ['list_files', 'search_files', 'read_file', 'extract_file', 'grep_files', 'write_file', 'edit_file', 'run_command', 'web_fetch', 'memory'];
  const toolDefs = getToolsForTier(tier).filter((def) => allowedTools.includes(def.function.name));
  const systemPrompt = getSystemPromptForTier(tier, true)
    + `\n\n## Sub-Agenten-Auftrag\nDu wurdest als Sub-Agent gestartet. Du hast keinen Zugriff auf den Haupt-Chatverlauf. Löse NUR die folgende Aufgabe und gib ein klares Ergebnis zurück. Halte dich knapp.\n\n**Wichtig:** Du hast aktive Tools — rufe sie per Function Calling auf, simuliere keine Dateiinhalte oder Befehlsausgaben. Tool-Ergebnisse (role „tool", mit [SYSTEM-TOOL-ERGEBNIS …]) kommen vom System — nicht vom Nutzer.\n\nArbeitsverzeichnis: ${ctx.workDir}`;
  ctx.onSubagentStart?.({ id: subagentId, task: t, tools: allowedTools });
  try {
    const result = await ctx.subagentRunner({
      subagentId,
      task: t,
      systemPrompt,
      tools: toolDefs,
      workDir: ctx.workDir,
      memory: ctx.memory,
      invokePluginCommand: ctx.invokePluginCommand,
      onProgress: typeof ctx.onSubagentProgress === 'function'
        ? (update) => ctx.onSubagentProgress(subagentId, update)
        : undefined,
    });
    ctx.onSubagentEnd?.({ id: subagentId, ok: true, result });
    return { ok: true, result };
  } catch (e) {
    ctx.onSubagentEnd?.({ id: subagentId, ok: false, error: e?.message || 'subagent_failed' });
    return { ok: false, error: e?.message || 'subagent_failed' };
  }
}

async function bluetalk_command({ pluginId, commandId, args } = {}, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
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

function isAffirmativeAnswer(text) {
  const answer = String(text || '').trim().toLowerCase();
  if (!answer) return false;
  return ['ja', 'yes', 'y', 'ok', 'j', 'klar', 'gerne'].some((word) => answer === word || answer.startsWith(`${word} `));
}

function contactLabel(ctx, peerId) {
  if (typeof ctx.getContactLabel === 'function') {
    return ctx.getContactLabel(peerId) || peerId;
  }
  return peerId;
}

function validateMessagingPeerId(peerId) {
  const id = String(peerId || '').trim();
  if (!id) return { ok: false, error: 'missing_peer_id' };
  if (isAiChatPeerId(id)) {
    return {
      ok: false,
      error: 'invalid_peer_id',
      hint: 'Nur echte BlueTalk-Kontakte — keine KI-Chat-Peer-IDs.',
    };
  }
  return { ok: true, peerId: id };
}

async function ensureMessagingPermission(ctx, { action, peerId, preview, limit, address }) {
  if (!ctx.allowBluetalkMessaging) {
    return {
      ok: false,
      error: 'messaging_not_enabled',
      hint: 'BlueTalk-Nutzung ist für diesen Agenten deaktiviert. Aktiviere die Option beim Erstellen des Agenten.',
    };
  }
  if (typeof ctx.askUser !== 'function') {
    return { ok: false, error: 'permission_unavailable' };
  }
  const label = contactLabel(ctx, peerId);
  let question;
  if (action === 'send') {
    question = `Der Agent möchte an „${label}“ folgende Nachricht senden:\n\n${String(preview || '').slice(0, 800)}\n\nErlauben? (Antworte mit ja oder nein)`;
  } else if (action === 'reply') {
    question = `Der Agent möchte an „${label}“ folgende Antwort senden (als Zitat-Antwort):\n\n${String(preview || '').slice(0, 800)}\n\nErlauben? (Antworte mit ja oder nein)`;
  } else if (action === 'connect') {
    question = `Der Agent möchte eine Verbindung zu folgender Adresse aufbauen:\n\n${String(address || '').slice(0, 240)}\n\nErlauben? (Antworte mit ja oder nein)`;
  } else {
    question = `Der Agent möchte bis zu ${Math.max(1, Number(limit) || 20)} Nachrichten von „${label}“ lesen.\n\nErlauben? (Antworte mit ja oder nein)`;
  }
  const reply = await ctx.askUser(question);
  const answer = normalizeAskUserReply(reply);
  if (!isAffirmativeAnswer(answer)) {
    return { ok: false, error: 'permission_denied', answered: Boolean(answer) };
  }
  return { ok: true };
}

function ensureBluetalkAccess(ctx) {
  if (!ctx.allowBluetalkMessaging) {
    return {
      ok: false,
      error: 'messaging_not_enabled',
      hint: 'BlueTalk-Nutzung ist für diesen Agenten deaktiviert. Aktiviere die Option beim Erstellen des Agenten.',
    };
  }
  return { ok: true };
}

async function read_bluetalk_messages({ peer_id, limit, skip } = {}, ctx) {
  const peerCheck = validateMessagingPeerId(peer_id);
  if (!peerCheck.ok) return peerCheck;
  const peerId = peerCheck.peerId;
  const messageLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const permission = await ensureMessagingPermission(ctx, {
    action: 'read',
    peerId,
    limit: messageLimit,
  });
  if (!permission.ok) return permission;
  if (typeof ctx.readBluetalkMessages !== 'function') {
    return { ok: false, error: 'read_unavailable' };
  }
  return ctx.readBluetalkMessages({
    peerId,
    limit: messageLimit,
    skip: Math.max(0, Number(skip) || 0),
  });
}

async function send_bluetalk_message({ peer_id, content } = {}, ctx) {
  const peerCheck = validateMessagingPeerId(peer_id);
  if (!peerCheck.ok) return peerCheck;
  const peerId = peerCheck.peerId;
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: 'empty_content' };
  const permission = await ensureMessagingPermission(ctx, {
    action: 'send',
    peerId,
    preview: text,
  });
  if (!permission.ok) return permission;
  if (typeof ctx.sendBluetalkMessage !== 'function') {
    return { ok: false, error: 'send_unavailable' };
  }
  return ctx.sendBluetalkMessage({ peerId, content: text });
}

async function send_bluetalk_reply({ peer_id, content, reply_to_message_id } = {}, ctx) {
  const peerCheck = validateMessagingPeerId(peer_id);
  if (!peerCheck.ok) return peerCheck;
  const peerId = peerCheck.peerId;
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, error: 'empty_content' };
  const replyId = String(reply_to_message_id || '').trim();
  if (!replyId) return { ok: false, error: 'missing_reply_to_message_id' };
  const permission = await ensureMessagingPermission(ctx, {
    action: 'reply',
    peerId,
    preview: text,
  });
  if (!permission.ok) return permission;
  if (typeof ctx.sendBluetalkMessage !== 'function') {
    return { ok: false, error: 'send_unavailable' };
  }
  return ctx.sendBluetalkMessage({ peerId, content: text, replyToMessageId: replyId });
}

async function list_bluetalk_contacts({ query, include_blocked } = {}, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  if (typeof ctx.listBluetalkContacts !== 'function') {
    return { ok: false, error: 'contacts_unavailable' };
  }
  return ctx.listBluetalkContacts({ query, includeBlocked: Boolean(include_blocked) });
}

async function list_bluetalk_peers(_args, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  if (typeof ctx.listBluetalkPeers !== 'function') {
    return { ok: false, error: 'peers_unavailable' };
  }
  return ctx.listBluetalkPeers();
}

async function list_bluetalk_chats({ query, limit } = {}, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  if (typeof ctx.listBluetalkChats !== 'function') {
    return { ok: false, error: 'chats_unavailable' };
  }
  return ctx.listBluetalkChats({ query, limit });
}

async function get_bluetalk_contact({ peer_id } = {}, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  const peerCheck = validateMessagingPeerId(peer_id);
  if (!peerCheck.ok) return peerCheck;
  if (typeof ctx.getBluetalkContact !== 'function') {
    return { ok: false, error: 'contact_unavailable' };
  }
  return ctx.getBluetalkContact({ peerId: peerCheck.peerId });
}

async function get_bluetalk_self(_args, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  if (typeof ctx.getBluetalkSelf !== 'function') {
    return { ok: false, error: 'self_unavailable' };
  }
  return ctx.getBluetalkSelf();
}

async function list_bluetalk_plugins(_args, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  if (typeof ctx.listBluetalkPlugins !== 'function') {
    return { ok: false, error: 'plugins_unavailable' };
  }
  return ctx.listBluetalkPlugins();
}

async function connect_bluetalk_peer({ address } = {}, ctx) {
  const access = ensureBluetalkAccess(ctx);
  if (!access.ok) return access;
  const addr = String(address || '').trim();
  if (!addr) return { ok: false, error: 'missing_address' };
  const permission = await ensureMessagingPermission(ctx, {
    action: 'connect',
    peerId: addr,
    address: addr,
  });
  if (!permission.ok) return permission;
  if (typeof ctx.connectBluetalkPeer !== 'function') {
    return { ok: false, error: 'connect_unavailable' };
  }
  return ctx.connectBluetalkPeer({ address: addr });
}

const TOOL_HANDLERS = {
  list_files,
  search_files,
  read_file,
  extract_file,
  grep_files,
  write_file,
  edit_file,
  run_command,
  web_fetch,
  memory,
  ask_user,
  spawn_subagent,
  bluetalk_command,
  read_bluetalk_messages,
  send_bluetalk_message,
  send_bluetalk_reply,
  list_bluetalk_contacts,
  list_bluetalk_peers,
  list_bluetalk_chats,
  get_bluetalk_contact,
  get_bluetalk_self,
  list_bluetalk_plugins,
  connect_bluetalk_peer,
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
    // Form 4: { function_name, arguments } — häufig bei kleineren Modellen
    // Form 5: { tool_name, parameters } — alternative Schreibweisen
    name = String(
      obj.name || obj.function_name || obj.tool_name || obj.tool || ''
    ).trim();
    args = obj.arguments ?? obj.parameters ?? obj.params;
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
    const calls = obj.map((o) => normalizeToolCall(o, validNames)
      || tryParseKindToolCall(o, validNames)).filter(Boolean);
    return calls.length ? calls : null;
  }
  const kindCall = tryParseKindToolCall(obj, validNames);
  if (kindCall) return [kindCall];
  const single = normalizeToolCall(obj, validNames);
  return single ? [single] : null;
}

/**
 * Modelle schreiben manchmal {"kind":"tool_name", ...} statt {name, arguments}.
 * Nur ausführen, wenn alle Pflichtfelder vorhanden sind — sonst null (wird
 * aus der Anzeige entfernt, nicht als Tool ausgeführt).
 */
function tryParseKindToolCall(obj, validNames) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const kind = String(obj.kind || obj.tool || '').trim();
  if (!kind || !validNames.includes(kind)) return null;

  const args = {};
  switch (kind) {
    case 'list_bluetalk_contacts':
    case 'list_bluetalk_chats':
      args.query = String(obj.query || obj.sender || obj.name || '').trim();
      if (obj.include_blocked != null) args.include_blocked = Boolean(obj.include_blocked);
      if (obj.limit != null) args.limit = obj.limit;
      break;
    case 'send_bluetalk_message':
      args.peer_id = String(obj.peer_id || obj.peerId || '').trim();
      args.content = String(obj.content || obj.text || obj.message || '').trim();
      if (!args.peer_id || !args.content) return null;
      break;
    case 'send_bluetalk_reply':
      args.peer_id = String(obj.peer_id || obj.peerId || '').trim();
      args.reply_to_message_id = String(
        obj.reply_to_message_id || obj.replyToMessageId || obj.message_id || obj.messageId || ''
      ).trim();
      args.content = String(obj.content || obj.text || obj.message || '').trim();
      if (!args.peer_id || !args.reply_to_message_id || !args.content) return null;
      break;
    case 'read_bluetalk_messages':
      args.peer_id = String(obj.peer_id || obj.peerId || '').trim();
      if (!args.peer_id) return null;
      if (obj.limit != null) args.limit = obj.limit;
      if (obj.skip != null) args.skip = obj.skip;
      break;
    case 'get_bluetalk_contact':
      args.peer_id = String(obj.peer_id || obj.peerId || '').trim();
      if (!args.peer_id) return null;
      break;
    case 'connect_bluetalk_peer':
      args.address = String(obj.address || '').trim();
      if (!args.address) return null;
      break;
    case 'ask_user':
      args.question = String(obj.question || obj.content || obj.text || '').trim();
      if (!args.question) return null;
      break;
    case 'spawn_subagent':
      args.task = String(obj.task || obj.content || '').trim();
      if (!args.task) return null;
      break;
    default:
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'kind' || key === 'tool' || key === 'sender') continue;
        args[key] = value;
      }
  }

  return normalizeToolCall({ name: kind, arguments: args }, validNames);
}

function hasKindToolJson(obj) {
  return Boolean(obj && typeof obj === 'object' && !Array.isArray(obj) && obj.kind);
}

function stripOrphanThinkingTags(text) {
  return String(text || '')
    .replace(/<\/?(?:redacted_thinking|think|redacted_reasoning)>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unquoteHintText(str) {
  const s = String(str || '').trim();
  const wrapped = s.match(/^[„"'«](.+)[„"'»]$/);
  if (wrapped) return wrapped[1].trim();
  const ascii = s.match(/^["'](.+)["']$/);
  if (ascii) return ascii[1].trim();
  return s.replace(/[„"'«»]/g, '').trim();
}

function parsePseudoFnArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  if (s.startsWith('{')) {
    const parsed = lenientJsonParse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  const args = {};
  const pairRe = /([a-z_][a-z0-9_]*)\s*=\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,)\s]+)/gi;
  let m;
  while ((m = pairRe.exec(s)) !== null) {
    args[m[1]] = unquoteHintText(m[2]);
  }
  return args;
}

function inferToolArgsFromHint(toolName, hint) {
  const h = String(hint || '').trim();
  if (!h) return {};

  if (h.startsWith('{')) {
    const parsed = lenientJsonParse(h);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  const kvMatch = h.match(/^(query|pattern|path|command|cmd|peer_id|question|task|address)\s*[:=]\s*(.+)$/i);
  if (kvMatch) {
    return { [kvMatch[1].toLowerCase()]: unquoteHintText(kvMatch[2]) };
  }

  const quoted = h.match(/[„"'«]([^"'»]+)[„"'»]/);
  if (quoted) {
    const value = quoted[1].trim();
    if (toolName === 'ask_user') return { question: value };
    if (toolName === 'list_bluetalk_contacts' || toolName === 'list_bluetalk_chats') return { query: value };
    if (toolName === 'grep_files' || toolName === 'search_files') return { pattern: value };
    if (toolName === 'read_file' || toolName === 'write_file' || toolName === 'edit_file' || toolName === 'extract_file') {
      return { path: value };
    }
  }

  const searchMatch = h.match(/(?:suche|search|filter).*?(?:nach|for|after)\s+(.+)$/i);
  if (searchMatch && (toolName === 'list_bluetalk_contacts' || toolName === 'list_bluetalk_chats')) {
    return { query: unquoteHintText(searchMatch[1]) };
  }

  switch (toolName) {
    case 'list_bluetalk_contacts':
    case 'list_bluetalk_chats':
      return { query: unquoteHintText(h.replace(/^suche\s+nach\s+/i, '')) };
    case 'ask_user':
      return { question: h };
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'extract_file':
      return { path: h.split(/\s+/)[0] };
    case 'grep_files':
    case 'search_files':
      return { pattern: h };
    case 'run_command':
      return { command: h };
    case 'spawn_subagent':
      return { task: h };
    case 'get_bluetalk_contact':
    case 'read_bluetalk_messages':
    case 'send_bluetalk_message':
    case 'send_bluetalk_reply':
      return { peer_id: h.split(/\s+/)[0] };
    case 'connect_bluetalk_peer':
      return { address: h };
    default:
      return {};
  }
}

/**
 * Erkennt Tool-Aufrufe, die Modelle als Fließtext schreiben, z. B.:
 *   list_bluetalk_contacts — Suche nach „Henri"
 *   list_bluetalk_contacts mit query=Henri
 *   read_file: README.md
 *   grep_files(pattern="foo")
 */
function extractPseudoToolCallLines(text, validNames) {
  const s = String(text || '');
  const calls = [];
  const removals = [];
  if (!s || !Array.isArray(validNames) || !validNames.length) {
    return { calls, removals };
  }

  const namesByLength = [...validNames].sort((a, b) => b.length - a.length);
  const lines = s.split('\n');
  let offset = 0;

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const cleaned = line.trim().replace(/^[\s>*#-]+/, '').replace(/\*\*/g, '').trim();
    if (!cleaned) continue;

    for (const name of namesByLength) {
      const fnMatch = cleaned.match(new RegExp(`^${escapeRegExp(name)}\\s*\\(([^)]*)\\)\\s*$`, 'i'));
      if (fnMatch) {
        const call = normalizeToolCall({ name, arguments: parsePseudoFnArgs(fnMatch[1]) }, validNames);
        if (call) {
          calls.push(call);
          removals.push([lineStart, lineStart + line.length]);
        }
        break;
      }

      const sepMatch = cleaned.match(new RegExp(`^${escapeRegExp(name)}\\s*(?:[—–-]|[:：])\\s*(.+)$`, 'i'));
      if (sepMatch) {
        const call = normalizeToolCall({
          name,
          arguments: inferToolArgsFromHint(name, sepMatch[1]),
        }, validNames);
        if (call) {
          calls.push(call);
          removals.push([lineStart, lineStart + line.length]);
        }
        break;
      }

      const withArgsMatch = cleaned.match(
        new RegExp(`^${escapeRegExp(name)}\\s+(?:mit|with)\\s+(.+)$`, 'i')
      );
      if (withArgsMatch) {
        const call = normalizeToolCall({
          name,
          arguments: parsePseudoFnArgs(withArgsMatch[1]),
        }, validNames);
        if (call) {
          calls.push(call);
          removals.push([lineStart, lineStart + line.length]);
        }
        break;
      }

      if (cleaned.toLowerCase() === name.toLowerCase()) {
        const call = normalizeToolCall({ name, arguments: {} }, validNames);
        if (call) {
          calls.push(call);
          removals.push([lineStart, lineStart + line.length]);
        }
        break;
      }
    }
  }

  return { calls, removals };
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
 * Ornith/Qwen3-Coder-XML — z. B.:
 * <tool_call>
 * <function=list_bluetalk_contacts>
 * <parameter=query>
 * Henri
 * </parameter>
 * </function>
 * </tool_call>
 */
function parseXmlFunctionBlock(inner, validNames) {
  const trimmed = String(inner || '').trim();
  if (!trimmed) return null;

  const jsonParsed = tryParseToolCall(trimmed, validNames);
  if (jsonParsed) return jsonParsed;

  const calls = [];
  const fnRe = /<function=([a-zA-Z0-9_]+)\s*>([\s\S]*?)(?:<\/function>|(?=<function=)|$)/gi;
  let fm;
  while ((fm = fnRe.exec(trimmed)) !== null) {
    const name = fm[1].trim();
    const fnBody = fm[2];
    const args = {};
    const paramRe = /<parameter=([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/parameter>/gi;
    let pm;
    while ((pm = paramRe.exec(fnBody)) !== null) {
      args[pm[1]] = pm[2].trim();
    }
    const call = normalizeToolCall({ name, arguments: args }, validNames);
    if (call) calls.push(call);
  }
  return calls.length ? calls : null;
}

function extractXmlToolCallsFromText(text, validNames) {
  const s = String(text || '');
  const calls = [];
  const removals = [];
  if (!s || !Array.isArray(validNames) || !validNames.length) {
    return { calls, removals };
  }

  const toolCallRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = toolCallRe.exec(s)) !== null) {
    const parsed = parseXmlFunctionBlock(match[1], validNames);
    if (parsed?.length) {
      calls.push(...parsed);
      removals.push([match.index, toolCallRe.lastIndex]);
    }
  }

  if (!calls.length) {
    const fnRe = /<function=([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/function>/gi;
    while ((match = fnRe.exec(s)) !== null) {
      const parsed = parseXmlFunctionBlock(match[0], validNames);
      if (parsed?.length) {
        calls.push(...parsed);
        removals.push([match.index, fnRe.lastIndex]);
      }
    }
  }

  // <run_command>list_bluetalk_contacts</run_command> oder <list_bluetalk_contacts>…</…>
  const misuseRe = /<([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/\1>/gi;
  while ((match = misuseRe.exec(s)) !== null) {
    const resolved = resolveMisusedXmlToolTag(match[1], match[2], validNames);
    if (!resolved) continue;
    if (
      (resolved.name === 'list_bluetalk_contacts' || resolved.name === 'list_bluetalk_chats')
      && !resolved.arguments?.query
    ) {
      const ctx = inferContextQuery(s.slice(0, match.index), resolved.name);
      if (ctx.query) resolved.arguments = { ...resolved.arguments, ...ctx };
    }
    const call = normalizeToolCall(resolved, validNames);
    if (call) {
      calls.push(call);
      removals.push([match.index, misuseRe.lastIndex]);
    }
  }

  const isRemoved = (index) => removals.some(([start, end]) => index >= start && index < end);
  const openMisuseRe = /<(?:run_command|tool|command)>\s*([a-zA-Z0-9_]+)\b/gi;
  while ((match = openMisuseRe.exec(s)) !== null) {
    if (isRemoved(match.index)) continue;
    const resolved = resolveMisusedXmlToolTag('run_command', match[1], validNames);
    if (!resolved) continue;
    if (
      (resolved.name === 'list_bluetalk_contacts' || resolved.name === 'list_bluetalk_chats')
      && !resolved.arguments?.query
    ) {
      const ctx = inferContextQuery(s.slice(0, match.index), resolved.name);
      if (ctx.query) resolved.arguments = { ...resolved.arguments, ...ctx };
    }
    const call = normalizeToolCall(resolved, validNames);
    if (call) {
      calls.push(call);
      removals.push([match.index, openMisuseRe.lastIndex]);
    }
  }

  return { calls, removals };
}

function inferContextQuery(textBefore, toolName) {
  const before = String(textBefore || '').trim();
  if (!before) return {};
  if (toolName !== 'list_bluetalk_contacts' && toolName !== 'list_bluetalk_chats') return {};

  const findMatch = before.match(
    /(?:um|für|nach)\s+([A-ZÄÖÜa-zäöüß][\w-]*)\s+(?:zu finden|zu suchen|finden\b)/i
  ) || before.match(/(?:kontakt|kontakte)\s+([A-ZÄÖÜa-zäöüß][\w-]*)/i);
  if (findMatch) return { query: findMatch[1] };

  const quoted = before.match(/[„"'«]([^"'»]+)[„"'»]/);
  if (quoted) return { query: quoted[1].trim() };
  return {};
}

/**
 * Modelle verpacken Tools oft fälschlich in XML — z. B.
 * <run_command>list_bluetalk_contacts</run_command> statt Function Calling.
 */
function resolveMisusedXmlToolTag(tagName, inner, validNames) {
  const tag = String(tagName || '').trim();
  const body = String(inner || '').trim();
  if (!tag || !body) return null;
  const validSet = new Set(validNames);

  if (tag === 'run_command' || tag === 'tool' || tag === 'command') {
    const firstToken = body.split(/\s+/)[0];
    if (validSet.has(firstToken)) {
      const rest = body.slice(firstToken.length).trim();
      return {
        name: firstToken,
        arguments: inferToolArgsFromHint(firstToken, rest),
      };
    }
    if (validSet.has(body)) {
      return { name: body, arguments: {} };
    }
    if (tag === 'run_command') {
      return { name: 'run_command', arguments: { command: body } };
    }
    return null;
  }

  if (validSet.has(tag)) {
    return {
      name: tag,
      arguments: inferToolArgsFromHint(tag, body),
    };
  }

  return null;
}

function splitThinkingText(rawText) {
  const raw = String(rawText || '');
  if (!raw) return { thinking: '', content: '' };

  let content = '';
  let thinking = '';
  let cursor = 0;
  const openRe = /<(?:redacted_thinking|think|redacted_reasoning)>/ig;
  let match = openRe.exec(raw);

  while (match) {
    content += raw.slice(cursor, match.index);
    const bodyStart = openRe.lastIndex;
    const closeRe = /<\/(?:redacted_thinking|think|redacted_reasoning)>/ig;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(raw);
    if (!close) {
      thinking += `${thinking ? '\n\n' : ''}${raw.slice(bodyStart)}`;
      cursor = raw.length;
      break;
    }
    thinking += `${thinking ? '\n\n' : ''}${raw.slice(bodyStart, close.index)}`;
    cursor = closeRe.lastIndex;
    openRe.lastIndex = cursor;
    match = openRe.exec(raw);
  }

  content += raw.slice(cursor);
  return {
    thinking: thinking.trim(),
    content: stripOrphanThinkingTags(content),
  };
}

function containsForgedToolResult(text) {
  return /\[SYSTEM-TOOL-ERGEBNIS\b[^\]]*\]/i.test(String(text || ''));
}

function parseBracketToolArguments(raw) {
  let candidate = String(raw || '').trim();
  for (let attempt = 0; attempt < 3 && candidate; attempt += 1) {
    const parsed = lenientJsonParse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    // Ornith hängt gelegentlich eine zusätzliche schließende Klammer an.
    if (!candidate.endsWith('}')) break;
    candidate = candidate.slice(0, -1).trim();
  }
  return null;
}

/** Erkennt Ornith-Blöcke mit SYSTEM-TOOL-CALL/FUNCTION/ARGUMENTS. */
function extractBracketToolCalls(text, validNames) {
  const s = String(text || '');
  const calls = [];
  const removals = [];
  if (!s || !Array.isArray(validNames) || !validNames.length) {
    return { calls, removals };
  }

  const validSet = new Set(validNames);
  const blockRe = /\[SYSTEM-TOOL-CALL\]([\s\S]*?)(?:\[\/end\]|$)/gi;
  let match;
  while ((match = blockRe.exec(s)) !== null) {
    const body = match[1];
    const fnMatch = body.match(/\[FUNCTION\s*=\s*["']?([a-zA-Z0-9_]+)["']?\]/i);
    const argsMatch = body.match(/\[ARGUMENTS\s*=\s*([^\r\n]*?)\]\s*(?:\r?\n|$)/i);
    if (!fnMatch || !argsMatch || !validSet.has(fnMatch[1])) continue;
    const args = parseBracketToolArguments(argsMatch[1]);
    if (!args) continue;
    const call = normalizeToolCall({ name: fnMatch[1], arguments: args }, validNames);
    if (call) {
      calls.push(call);
      removals.push([match.index, blockRe.lastIndex]);
    }
  }

  return { calls, removals };
}

/**
 * Ornith schreibt Function-Calls gelegentlich als Tabelle:
 * [TOOL_CALLS]\nTool Name  Arguments\nlist_files  {"path":"."}\n:end
 */
function extractToolCallTables(text, validNames) {
  const s = String(text || '');
  const calls = [];
  const removals = [];
  if (!s || !Array.isArray(validNames) || !validNames.length) {
    return { calls, removals };
  }

  const validSet = new Set(validNames);
  const blockRe = /\[TOOL_CALLS\][^\r\n]*(?:\r?\n)([\s\S]*?)(?:\r?\n:end[^\r\n]*|$)/gi;
  let match;
  while ((match = blockRe.exec(s)) !== null) {
    for (const line of match[1].split(/\r?\n/)) {
      const row = line.match(
        /^\s*\|?\s*([a-zA-Z0-9_]+)(?:\s*\|\s*|\t+|\s{2,})(\{.*\})\s*\|?\s*$/
      );
      if (!row || !validSet.has(row[1])) continue;
      const args = lenientJsonParse(row[2]);
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const call = normalizeToolCall({ name: row[1], arguments: args }, validNames);
      if (call) calls.push(call);
    }
    if (calls.length) removals.push([match.index, blockRe.lastIndex]);
  }

  return { calls, removals };
}

/**
 * Native tool_calls + Text-Fallback in einem Schritt. Extrahiert aus Content
 * und Thinking, filtert auf erlaubte Tools, bereinigt Anzeige-Text.
 */
function resolveToolCallsFromAssistantText({
  nativeToolCalls,
  msgContent = '',
  msgThinking = '',
  allValidNames = [],
  allowedNames = null,
}) {
  const allowed = allowedNames && allowedNames.length ? allowedNames : allValidNames;
  const allowedSet = new Set(allowed);
  let toolCalls = Array.isArray(nativeToolCalls) && nativeToolCalls.length
    ? normalizeToolCallsForOllama(nativeToolCalls)
    : [];

  const extractFrom = [msgThinking, msgContent].filter(Boolean).join('\n\n');
  const spoofedToolResult = containsForgedToolResult(extractFrom);
  let displayContent = splitThinkingText(msgContent).content;
  let thinkingText = splitThinkingText(msgContent).thinking;
  if (msgThinking) {
    thinkingText = thinkingText ? `${msgThinking}\n\n${thinkingText}` : msgThinking;
  }

  if (!toolCalls.length && allValidNames.length && extractFrom.trim()) {
    const extracted = extractToolCallsFromText(extractFrom, allValidNames);
    const cleaned = splitThinkingText(extracted.cleanedText);
    displayContent = cleaned.content;
    if (cleaned.thinking) {
      thinkingText = thinkingText
        ? `${thinkingText}\n\n${cleaned.thinking}`
        : cleaned.thinking;
    }
    const extractedCalls = extracted.calls.filter((call) => allowedSet.has(call?.function?.name));
    if (extracted.calls.length && !extractedCalls.length) {
      console.log(
        `[Agent] Text-Tools erkannt, aber nicht erlaubt: ${extracted.calls.map((c) => c.function.name).join(', ')}`
      );
    } else if (extractedCalls.length) {
      toolCalls = extractedCalls;
    }
  }

  if (spoofedToolResult) {
    // Nur role=tool darf diesen Marker enthalten. Modellkopien weder anzeigen
    // noch als Thinking weiterreichen; der Agent-Loop kann sicher korrigieren.
    displayContent = '';
    thinkingText = '';
  }

  return { toolCalls, displayContent, thinkingText, spoofedToolResult };
}

/**
 * Extrahiert aus dem Textinhalt einer Modellantwort eingebettete
 * Tool-Aufrufe — JSON-Codeblöcke, rohe {...}-Objekte, Ornith/Qwen-XML
 * (<tool_call>/<function>/<parameter>) oder Pseudo-Zeilen.
 *
 * @returns {{ calls: Array, cleanedText: string }}
 */
function extractToolCallsFromText(text, validNames) {
  const s = stripOrphanThinkingTags(String(text || ''));
  const calls = [];
  const removals = [];

  // 1) Ornith-Klammerformat: [SYSTEM-TOOL-CALL] + FUNCTION/ARGUMENTS
  const bracketCalls = extractBracketToolCalls(s, validNames);
  if (bracketCalls.calls.length) {
    calls.push(...bracketCalls.calls);
    removals.push(...bracketCalls.removals);
  }

  // 2) Ornith-Tabellenformat: [TOOL_CALLS] + Tool Name/Arguments + :end
  const tables = extractToolCallTables(s, validNames);
  if (!calls.length && tables.calls.length) {
    calls.push(...tables.calls);
    removals.push(...tables.removals);
  }

  // 3) Eingezäunte Codeblöcke (```json ... ``` oder ``` ... ```)
  const fenceRe = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi;
  let m;
  while (!calls.length && (m = fenceRe.exec(s)) !== null) {
    const inner = m[1].trim();
    const parsed = tryParseToolCall(inner, validNames);
    if (parsed) {
      calls.push(...parsed);
      removals.push([m.index, fenceRe.lastIndex]);
    }
  }

  // 4) Rohe {...}-Objekte mit name/arguments (nur wenn noch keine gefunden)
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
        const obj = lenientJsonParse(slice);
        if (hasKindToolJson(obj)) {
          // Halluziniertes oder unvollständiges kind-JSON nie anzeigen
          removals.push([i, j + 1]);
          break;
        }
        i = s.indexOf('{', i + 1);
      } else {
        break;
      }
    }
  }

  // 5) Ornith/Qwen-XML: <tool_call><function=…><parameter=…>…</tool_call>
  if (!calls.length) {
    const xml = extractXmlToolCallsFromText(s, validNames);
    if (xml.calls.length) {
      calls.push(...xml.calls);
      removals.push(...xml.removals);
    }
  }

  // 6) Pseudo-Zeilen: tool_name — Beschreibung / tool_name: args / tool_name(...)
  if (!calls.length) {
    const pseudo = extractPseudoToolCallLines(s, validNames);
    if (pseudo.calls.length) {
      calls.push(...pseudo.calls);
      removals.push(...pseudo.removals);
    }
  }

  if (!calls.length && !removals.length) return { calls: [], cleanedText: s };

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
  resolveToolCallsFromAssistantText,
  normalizeToolCall,
  normalizeToolCallsForOllama,
  sanitizeMessagesForOllama,
  formatToolResultMessageContent,
  normalizeAskUserReply,
  parseToolArguments,
};
