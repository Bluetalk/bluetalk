const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AI_CHAT_PEER_ID,
  AI_CHAT_PEER_PREFIX,
  OLLAMA_DEFAULT_RUNTIME_MODE,
  OLLAMA_DEFAULT_PORT,
  OLLAMA_RUNTIME_MODE_BLUETALK,
  OLLAMA_RUNTIME_MODE_SYSTEM,
  OLLAMA_SYSTEM_PORT,
  AI_MODEL_TIERS,
  AI_CHAT_SYSTEM_PROMPT,
  AI_AGENT_TOOLS,
  AI_AGENT_TOOL_NAMES,
  AI_AGENT_MODES,
  getSystemPromptForTier,
  getSystemPromptForAgent,
  isValidAgentMode,
  isAgentModeEnabled,
  resolveAgentWorkDir,
  isValidModelTier,
  getModelTier,
  isAiChatPeerId,
  resolveOllamaRuntimeMode,
} = require('../src/shared/ai-chat-constants.js');

test('AI_CHAT_PEER_ID is a reserved virtual id', () => {
  assert.equal(AI_CHAT_PEER_ID, '__ai_chat__');
  assert.match(AI_CHAT_PEER_ID, /^__/);
  assert.equal(AI_CHAT_PEER_PREFIX, '__ai_chat__:');
  assert.equal(isAiChatPeerId('__ai_chat__:agent-1'), true);
  assert.equal(isAiChatPeerId('real-peer'), false);
});

test('model tiers include fast, normal, normal+, smart, and cloud', () => {
  assert.ok(isValidModelTier('fast'));
  assert.ok(isValidModelTier('normal'));
  assert.ok(isValidModelTier('normal+'));
  assert.ok(isValidModelTier('smart'));
  assert.ok(isValidModelTier('cloud'));
  assert.equal(isValidModelTier('unknown'), false);
});

test('local tiers reference ollama pull names', () => {
  assert.equal(getModelTier('fast').model, 'qwen3:0.6b');
  assert.equal(getModelTier('normal').model, 'qwen3:1.7b');
  assert.equal(getModelTier('normal+').model, 'qwen3:4b');
  assert.equal(getModelTier('smart').model, 'gemma4:latest');
  for (const id of ['fast', 'normal', 'normal+', 'smart']) {
    assert.ok(getModelTier(id).local);
    assert.ok(getModelTier(id).estimatedSizeBytes > 0);
  }
});

test('BlueTalk uses a private Ollama port', () => {
  assert.equal(OLLAMA_DEFAULT_PORT, 32114);
  assert.notEqual(OLLAMA_DEFAULT_PORT, 11434);
  assert.equal(OLLAMA_SYSTEM_PORT, 11434);
});

test('Ollama runtime mode defaults to BlueTalk but allows system Ollama', () => {
  assert.equal(OLLAMA_DEFAULT_RUNTIME_MODE, OLLAMA_RUNTIME_MODE_BLUETALK);
  assert.equal(resolveOllamaRuntimeMode(''), OLLAMA_RUNTIME_MODE_BLUETALK);
  assert.equal(resolveOllamaRuntimeMode('bad'), OLLAMA_RUNTIME_MODE_BLUETALK);
  assert.equal(resolveOllamaRuntimeMode(OLLAMA_RUNTIME_MODE_SYSTEM), OLLAMA_RUNTIME_MODE_SYSTEM);
});

test('AI_CHAT_SYSTEM_PROMPT encodes offline assistant rules', () => {
  assert.ok(AI_CHAT_SYSTEM_PROMPT.includes('BlueTalk'));
  assert.ok(AI_CHAT_SYSTEM_PROMPT.includes('IMMER auf Deutsch'));
  assert.ok(AI_CHAT_SYSTEM_PROMPT.includes('Kein Live-Internet'));
  assert.ok(AI_CHAT_SYSTEM_PROMPT.length > 200);
});

test('getSystemPromptForTier returns tier-specific sections', () => {
  const fast = getSystemPromptForTier('fast');
  const smart = getSystemPromptForTier('smart');
  const cloud = getSystemPromptForTier('cloud');

  assert.ok(fast.includes('Modell-Stufe: Schnell'));
  assert.ok(fast.includes('Maximal 1–3 kurze Sätze'));
  assert.ok(smart.includes('Gemma 4'));
  assert.ok(smart.includes('analytisches Potenzial'));
  assert.ok(cloud.includes('gpt-oss 120B'));
  assert.ok(cloud.includes('Fachberaters'));

  assert.notEqual(fast, smart);
  assert.notEqual(smart, cloud);

  for (const id of ['fast', 'normal', 'normal+', 'smart', 'cloud']) {
    const prompt = getSystemPromptForTier(id);
    assert.ok(prompt.includes('BlueTalk'));
    assert.ok(prompt.includes('IMMER auf Deutsch'));
  }
});

test('getSystemPromptForTier falls back to normal for unknown tiers', () => {
  const fallback = getSystemPromptForTier('unknown');
  const normal = getSystemPromptForTier('normal');
  assert.equal(fallback, normal);
});

test('getSystemPromptForAgent appends personality presets and custom instructions', () => {
  const {
    getSystemPromptForAgent,
    resolveAgentPersonality,
    AI_PERSONALITY_DEFAULT_ID,
  } = require('../src/shared/ai-chat-constants.js');

  const base = getSystemPromptForAgent('normal', { personalityId: AI_PERSONALITY_DEFAULT_ID });
  const friendly = getSystemPromptForAgent('normal', { personalityId: 'friendly' });
  const custom = getSystemPromptForAgent('normal', {
    personalityId: 'default',
    personalityCustom: 'Antworte immer mit Humor.',
  });

  assert.ok(base.includes('BlueTalk'));
  assert.ok(friendly.includes('Persönlichkeit: Freundlich'));
  assert.notEqual(base, friendly);
  assert.ok(custom.includes('Zusätzliche Persönlichkeits-Anweisungen'));
  assert.ok(custom.includes('Antworte immer mit Humor.'));

  const resolved = resolveAgentPersonality({ personality: 'unknown', personalityCustom: '  x  ' });
  assert.equal(resolved.personalityId, 'default');
  assert.equal(resolved.personalityCustom, 'x');
});

test('cloud tier requires auth and has no local size', () => {
  const cloud = AI_MODEL_TIERS.cloud;
  assert.equal(cloud.local, false);
  assert.equal(cloud.requiresAuth, true);
  assert.equal(cloud.estimatedSizeBytes, 0);
});

test('agent modes include off and agent', () => {
  assert.ok(isValidAgentMode('off'));
  assert.ok(isValidAgentMode('agent'));
  assert.equal(isValidAgentMode('bogus'), false);
  assert.equal(AI_AGENT_MODES.off.label, 'Chat');
  assert.equal(AI_AGENT_MODES.agent.label, 'Agent');
});

test('isAgentModeEnabled detects agent agents', () => {
  assert.equal(isAgentModeEnabled({ agentMode: 'agent' }), true);
  assert.equal(isAgentModeEnabled({ agentMode: 'off' }), false);
  assert.equal(isAgentModeEnabled({}), false);
  assert.equal(isAgentModeEnabled({ agentMode: 'bogus' }), false);
  assert.equal(isAgentModeEnabled(null), false);
});

test('resolveAgentWorkDir returns trimmed dir or empty', () => {
  assert.equal(resolveAgentWorkDir({ agentWorkDir: '  /tmp/x  ' }), '/tmp/x');
  assert.equal(resolveAgentWorkDir({}), '');
  assert.equal(resolveAgentWorkDir(null), '');
});

test('thinking modes include auto, on, off', () => {
  const {
    AI_THINKING_MODES,
    AI_THINKING_MODE_IDS,
    AI_THINKING_DEFAULT_MODE_ID,
    isValidThinkingMode,
    resolveThinkOption,
    resolveAgentThinkingMode,
  } = require('../src/shared/ai-chat-constants.js');

  assert.deepEqual([...AI_THINKING_MODE_IDS].sort(), ['auto', 'off', 'on'].sort());
  assert.equal(AI_THINKING_DEFAULT_MODE_ID, 'auto');
  assert.ok(isValidThinkingMode('auto'));
  assert.ok(isValidThinkingMode('on'));
  assert.ok(isValidThinkingMode('off'));
  assert.equal(isValidThinkingMode('bogus'), false);
  assert.equal(isValidThinkingMode(''), false);

  // off -> false (nie thinking)
  assert.equal(resolveThinkOption('off', 'qwen3:1.7b', 'normal'), false);
  assert.equal(resolveThinkOption('off', 'gpt-oss:120b-cloud', 'cloud'), false);

  // on -> true, gpt-oss -> 'medium'
  assert.equal(resolveThinkOption('on', 'qwen3:1.7b', 'normal'), true);
  assert.equal(resolveThinkOption('on', 'gpt-oss:120b-cloud', 'cloud'), 'medium');

  // auto -> false für fast, true für normal+, 'medium' für gpt-oss
  assert.equal(resolveThinkOption('auto', 'qwen3:0.6b', 'fast'), false);
  assert.equal(resolveThinkOption('auto', 'qwen3:4b', 'normal+'), true);
  assert.equal(resolveThinkOption('auto', 'gpt-oss:120b-cloud', 'cloud'), 'medium');

  // Fallback für unbekannten Modus -> auto
  assert.equal(resolveThinkOption('bogus', 'qwen3:1.7b', 'normal'), true);

  // resolveAgentThinkingMode
  assert.equal(resolveAgentThinkingMode({ thinkingMode: 'off' }), 'off');
  assert.equal(resolveAgentThinkingMode({ thinkingMode: '  on  ' }), 'on');
  assert.equal(resolveAgentThinkingMode({}), 'auto');
  assert.equal(resolveAgentThinkingMode(null), 'auto');
});

test('agent tools define the core capabilities plus extensions', () => {
  // Kern-Tools bleiben erhalten
  for (const name of ['bluetalk_command', 'list_files', 'read_file', 'run_command', 'write_file']) {
    assert.ok(AI_AGENT_TOOL_NAMES.includes(name), `core tool present: ${name}`);
  }
  // Neue Erweiterungs-Tools
  for (const name of ['search_files', 'grep_files', 'edit_file', 'web_fetch', 'memory', 'ask_user', 'spawn_subagent', 'extract_file']) {
    assert.ok(AI_AGENT_TOOL_NAMES.includes(name), `extension tool present: ${name}`);
  }
  for (const tool of AI_AGENT_TOOLS) {
    assert.equal(tool.type, 'function');
    assert.ok(tool.function.name, 'tool has a name');
    assert.ok(tool.function.parameters, 'tool has parameters schema');
  }
});

test('getToolsForTier filters tools by model tier', () => {
  const { getToolsForTier } = require('../src/shared/ai-chat-constants.js');
  const fast = getToolsForTier('fast');
  const smart = getToolsForTier('smart');
  const cloud = getToolsForTier('cloud');
  const normal = getToolsForTier('normal');

  const names = (arr) => arr.map((t) => t.function.name);

  // Fast hat nur die sicheren Basis-Tools — keine Sub-Agenten, kein Web-Fetch
  assert.ok(!names(fast).includes('spawn_subagent'));
  assert.ok(!names(fast).includes('web_fetch'));

  // Smart und Cloud haben die volle Palette inkl. Sub-Agent
  assert.ok(names(smart).includes('spawn_subagent'));
  assert.ok(names(cloud).includes('web_fetch'));
  assert.ok(names(cloud).includes('spawn_subagent'));

  // Normal+ hat edit_file und web_fetch, aber keinen Sub-Agenten
  const normalPlus = getToolsForTier('normal+');
  assert.ok(names(normalPlus).includes('edit_file'));
  assert.ok(names(normalPlus).includes('web_fetch'));
  assert.ok(!names(normalPlus).includes('spawn_subagent'));

  // Normal hat edit_file, keinen Web-Fetch
  assert.ok(names(normal).includes('edit_file'));
  assert.ok(!names(normal).includes('web_fetch'));

  // Fallback für unbekannte Stufe
  assert.deepEqual(getToolsForTier('unknown').map((t) => t.function.name), getToolsForTier('normal').map((t) => t.function.name));
});

test('agent system prompt includes tier-specific agent strategies', () => {
  const { AI_AGENT_SYSTEM_PROMPT_BASE } = require('../src/shared/ai-chat-constants.js');
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('Tool-Pflicht'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('Arbeits-Loop'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('spawn_subagent'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('ask_user'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('keinen Zugriff auf Dateien'));
});

test('agent system prompt lists available tools per tier', () => {
  const { buildAgentToolsPromptSection, getToolsForTier } = require('../src/shared/ai-chat-constants.js');
  const fastSection = buildAgentToolsPromptSection('fast');
  const cloudSection = buildAgentToolsPromptSection('cloud');

  assert.ok(fastSection.includes('Verfügbare Tools'));
  assert.ok(fastSection.includes('read_file'));
  assert.ok(!fastSection.includes('spawn_subagent'));

  assert.ok(cloudSection.includes('spawn_subagent'));
  assert.ok(cloudSection.includes('web_fetch'));

  const fastAgent = getSystemPromptForTier('fast', true);
  assert.ok(fastAgent.includes('Verfügbare Tools'));
  for (const tool of getToolsForTier('fast')) {
    assert.ok(fastAgent.includes(tool.function.name));
  }
});

test('agent system prompt enforces code-quality rules', () => {
  const { AI_AGENT_SYSTEM_PROMPT_BASE } = require('../src/shared/ai-chat-constants.js');
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('Code-Qualität'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('<style>'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('<head>'));
  assert.ok(AI_AGENT_SYSTEM_PROMPT_BASE.includes('<body>'));
});

test('agent tier prompts are appended in agent mode', () => {
  const fastAgent = getSystemPromptForTier('fast', true);
  const cloudAgent = getSystemPromptForTier('cloud', true);
  const fastChat = getSystemPromptForTier('fast', false);

  assert.ok(fastAgent.includes('Agent-Strategie: Schnell'));
  assert.ok(cloudAgent.includes('Agent-Strategie: Cloud'));
  assert.ok(cloudAgent.includes('Sub-Agent'));
  assert.ok(fastAgent.includes('kompakter Agent mit wenigen'));
  assert.ok(!fastChat.includes('Agent-Strategie'));
  assert.notEqual(fastAgent, fastChat);
});

test('getSystemPromptForAgent uses agent base prompt when agent mode is enabled', () => {
  const chat = getSystemPromptForAgent('normal', { personalityId: 'default' });
  const agent = getSystemPromptForAgent('normal', {
    personalityId: 'default',
    agentMode: 'agent',
    agentWorkDir: '/home/user/proj',
  });

  assert.ok(chat.includes('kein Zugriff auf Dateien'));
  assert.ok(agent.includes('handlungsfaehiger Agent') || agent.includes('handlungsfähiger Agent') || agent.includes('ECHTE, AKTIVE Werkzeuge'));
  assert.ok(agent.includes('Verfügbare Tools'));
  assert.ok(agent.includes('Arbeitsverzeichnis'));
  assert.ok(agent.includes('/home/user/proj'));
  assert.ok(!agent.includes('Kein Live-Internet'));
  assert.notEqual(chat, agent);
});

test('getSystemPromptForAgent stays in chat mode when agentMode is off', () => {
  const off = getSystemPromptForAgent('normal', { personalityId: 'default', agentMode: 'off' });
  assert.ok(off.includes('BlueTalk'));
  assert.ok(!off.includes('Arbeitsverzeichnis'));
});
