const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  executeToolCall,
  normalizeToolCallsForOllama,
  sanitizeMessagesForOllama,
  extractToolCallsFromText,
  formatToolResultMessageContent,
  normalizeAskUserReply,
} = require('../src/main/agent-tools.js');

test('normalizeToolCallsForOllama converts string arguments to objects', () => {
  const calls = normalizeToolCallsForOllama([
    {
      type: 'function',
      function: {
        name: 'read_file',
        arguments: '{"path":"src/main.js"}',
      },
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(calls[0].function.arguments, { path: 'src/main.js' });
  assert.equal(typeof calls[0].function.arguments, 'object');
});

test('normalizeAskUserReply extracts string answers from ask_user callback results', () => {
  assert.equal(normalizeAskUserReply('  hallo.txt  '), 'hallo.txt');
  assert.equal(normalizeAskUserReply({ answer: 'index.html' }), 'index.html');
  assert.equal(normalizeAskUserReply({ ok: true, answered: true }), '');
  assert.equal(normalizeAskUserReply(null), '');
  assert.equal(normalizeAskUserReply({ answer: 42 }), '');
});

test('formatToolResultMessageContent formats ask_user answers readably', () => {
  const content = formatToolResultMessageContent('ask_user', {
    ok: true,
    answered: true,
    question: 'Welche Datei?',
    answer: 'notes.txt',
  });
  assert.ok(content.includes('Nutzer-Antwort (via Rückfrage-Dialog): notes.txt'));
  assert.ok(!content.includes('[object Object]'));
});

test('formatToolResultMessageContent marks results as system output', () => {
  const content = formatToolResultMessageContent('read_file', { ok: true, content: 'hello' });
  assert.ok(content.includes('[SYSTEM-TOOL-ERGEBNIS'));
  assert.ok(content.includes('Tool: read_file'));
  assert.ok(content.includes('nicht vom Nutzer'));
  assert.ok(content.includes('"ok":true'));
});

test('sanitizeMessagesForOllama normalizes assistant tool_calls in history', () => {
  const messages = sanitizeMessagesForOllama([
    { role: 'user', content: 'Lies die Datei' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        function: { name: 'read_file', arguments: '{"path":"README.md"}' },
      }],
    },
    { role: 'tool', name: 'read_file', content: '{"ok":true}' },
  ]);
  assert.deepEqual(messages[1].tool_calls[0].function.arguments, { path: 'README.md' });
  assert.equal(messages[0].role, 'user');
});

test('extractToolCallsFromText returns object arguments for Ollama replay', () => {
  const text = '```json\n{"name":"grep_files","arguments":{"pattern":"foo"}}\n```';
  const { calls } = extractToolCallsFromText(text, ['grep_files']);
  assert.equal(calls.length, 1);
  assert.equal(typeof calls[0].function.arguments, 'object');
  assert.deepEqual(calls[0].function.arguments, { pattern: 'foo' });
});

test('file tools keep absolute paths inside the agent workdir', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bt-agent-workdir-'));
  const inside = path.join(workDir, 'inside.txt');
  const outside = path.join(os.tmpdir(), `bt-agent-outside-${Date.now()}.txt`);

  try {
    await fs.writeFile(inside, 'inside', 'utf8');
    await fs.writeFile(outside, 'outside', 'utf8');

    const allowed = await executeToolCall(
      { function: { name: 'read_file', arguments: { path: inside } } },
      { workDir }
    );
    assert.equal(allowed.ok, true);
    assert.equal(allowed.content, 'inside');

    const blocked = await executeToolCall(
      { function: { name: 'read_file', arguments: { path: outside } } },
      { workDir }
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'outside_workdir');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(outside, { force: true });
  }
});

test('web_fetch blocks local and private network targets', async () => {
  const loopback = await executeToolCall(
    { function: { name: 'web_fetch', arguments: { url: 'http://127.0.0.1:11434/api/tags' } } },
    { workDir: os.tmpdir() }
  );
  assert.equal(loopback.ok, false);
  assert.equal(loopback.error, 'blocked_private_url');

  const localhost = await executeToolCall(
    { function: { name: 'web_fetch', arguments: { url: 'http://localhost:5173' } } },
    { workDir: os.tmpdir() }
  );
  assert.equal(localhost.ok, false);
  assert.equal(localhost.error, 'blocked_private_url');
});
