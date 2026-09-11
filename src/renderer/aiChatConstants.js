/** Renderer-Einstieg; abgestimmt mit src/shared/ai-chat-constants.js (kein direkter Import — CJS im Browser). */

export const AI_CHAT_PEER_ID = '__ai_chat__';
export const AI_CHAT_PEER_PREFIX = '__ai_chat__:';

export const OLLAMA_RUNTIME_DISCLAIMER_BYTES = Math.round(1.5 * 1024 * 1024 * 1024);
export const OLLAMA_DEFAULT_PORT = 32114;
export const OLLAMA_SYSTEM_PORT = 11434;
export const OLLAMA_RUNTIME_MODE_BLUETALK = 'bluetalk';
export const OLLAMA_RUNTIME_MODE_SYSTEM = 'system';
export const OLLAMA_RUNTIME_MODE_IDS = [
  OLLAMA_RUNTIME_MODE_BLUETALK,
  OLLAMA_RUNTIME_MODE_SYSTEM,
];
export const OLLAMA_DEFAULT_RUNTIME_MODE = OLLAMA_RUNTIME_MODE_BLUETALK;

export const AI_MODEL_TIERS = {
  fast: {
    id: 'fast',
    label: 'Schnell',
    description: 'Kurze Antworten, geringer Speicherbedarf',
    model: 'qwen3:0.6b',
    estimatedSizeBytes: 523 * 1024 * 1024,
    local: true,
    supportsVision: false,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    description: 'Ausgewogen zwischen Qualität und Geschwindigkeit',
    model: 'qwen3:1.7b',
    estimatedSizeBytes: Math.round(1.4 * 1024 * 1024 * 1024),
    local: true,
    supportsVision: false,
  },
  'normal+': {
    id: 'normal+',
    label: 'Normal+',
    description: 'Mehr Qualität als Normal, moderater Speicherbedarf',
    model: 'qwen3:4b',
    estimatedSizeBytes: Math.round(2.5 * 1024 * 1024 * 1024),
    local: true,
    supportsVision: false,
  },
  ornith: {
    id: 'ornith',
    label: 'Ornith',
    description: 'Agentisches Programmieren zwischen Normal+ und Smart',
    model: 'ornith:9b',
    estimatedSizeBytes: Math.round(5.6 * 1024 * 1024 * 1024),
    local: true,
    supportsVision: false,
    beta: true,
    debugOnly: true,
  },
  smart: {
    id: 'smart',
    label: 'Smart',
    description: 'Beste lokale Qualität, mehr RAM nötig',
    model: 'gemma4:latest',
    estimatedSizeBytes: Math.round(9.6 * 1024 * 1024 * 1024),
    local: true,
    supportsVision: true,
  },
  cloud: {
    id: 'cloud',
    label: 'Cloud',
    description: 'Große Modelle über Ollama Cloud (Anmeldung erforderlich)',
    model: 'gpt-oss:120b-cloud',
    estimatedSizeBytes: 0,
    local: false,
    requiresAuth: true,
    supportsVision: false,
  },
};

export const AI_CLOUD_MODELS = {
  'gpt-oss-120b': {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    description: 'Höchste Qualität für komplexe Fragen',
    model: 'gpt-oss:120b-cloud',
    supportsVision: false,
  },
  'gpt-oss-20b': {
    id: 'gpt-oss-20b',
    label: 'GPT-OSS 20B',
    description: 'Schnellere Cloud-Antworten',
    model: 'gpt-oss:20b-cloud',
    supportsVision: false,
  },
  'deepseek-v3.1': {
    id: 'deepseek-v3.1',
    label: 'DeepSeek V3.1',
    description: 'Starkes Reasoning und Analyse',
    model: 'deepseek-v3.1:671b-cloud',
    supportsVision: false,
  },
  'qwen3-coder': {
    id: 'qwen3-coder',
    label: 'Qwen3 Coder',
    description: 'Für Code und Entwicklung',
    model: 'qwen3-coder:480b-cloud',
    supportsVision: false,
  },
};

export const AI_CLOUD_DEFAULT_MODEL_ID = 'gpt-oss-120b';

export const AI_PERSONALITY_PRESETS = {
  default: {
    id: 'default',
    label: 'Standard',
    description: 'Neutral, hilfsbereit und ausgewogen',
    prompt: '',
  },
  friendly: {
    id: 'friendly',
    label: 'Freundlich',
    description: 'Warm, locker und ermutigend',
    prompt: `## Persönlichkeit: Freundlich
- Sei warmherzig, zugänglich und ermutigend.
- Du darfst gelegentlich leichte Umgangssprache verwenden.
- Zeige echtes Interesse an den Anliegen des Nutzers.`,
  },
  professional: {
    id: 'professional',
    label: 'Professionell',
    description: 'Sachlich, präzise und formell',
    prompt: `## Persönlichkeit: Professionell
- Antworte sachlich, präzise und höflich.
- Vermeide Umgangssprache und übermäßige Emotionalität.
- Strukturiere Antworten klar und geschäftstauglich.`,
  },
  creative: {
    id: 'creative',
    label: 'Kreativ',
    description: 'Fantasievoll, bildhaft und inspirierend',
    prompt: `## Persönlichkeit: Kreativ
- Nutze lebendige Formulierungen, Analogien und Ideen.
- Sei neugierig und regt den Nutzer zu neuen Perspektiven an.
- Bei kreativen Aufgaben: mehrere unterschiedliche Vorschläge anbieten.`,
  },
  concise: {
    id: 'concise',
    label: 'Knapp',
    description: 'Sehr kurz und direkt auf den Punkt',
    prompt: `## Persönlichkeit: Knapp
- Antworte so kurz wie möglich, ohne wichtige Infos wegzulassen.
- Keine Einleitungen, keine Wiederholungen, kein Smalltalk.
- Lieber Stichpunkte als Fließtext, wenn es passt.`,
  },
  teacher: {
    id: 'teacher',
    label: 'Lehrreich',
    description: 'Geduldig erklärend mit Beispielen',
    prompt: `## Persönlichkeit: Lehrreich
- Erkläre Schritt für Schritt und baue vom Einfachen zum Komplexen auf.
- Nutze Beispiele und kurze Zusammenfassungen am Ende.
- Ermutige Rückfragen, wenn etwas unklar sein könnte.`,
  },
};

export const AI_PERSONALITY_IDS = Object.keys(AI_PERSONALITY_PRESETS);
export const AI_PERSONALITY_DEFAULT_ID = 'default';
export const AI_PERSONALITY_CUSTOM_MAX_CHARS = 500;

export const BOT_DEFAULT_NAME = 'Bot';
export const BOT_DESCRIPTION_MAX_CHARS = 2000;
export const BOT_ROUTINE_NAME_MAX_CHARS = 64;
export const BOT_ROUTINE_PROMPT_MAX_CHARS = 2000;
export const BOT_ROUTINE_TRIGGER_IDS = ['manual', 'interval', 'daily'];
export const BOT_ROUTINE_DEFAULT_TRIGGER = 'manual';
export const BOT_ROUTINE_MIN_INTERVAL_MINUTES = 5;
export const BOT_ROUTINE_MAX_INTERVAL_MINUTES = 24 * 60;

export function isValidModelTier(tierId) {
  return Boolean(AI_MODEL_TIERS[tierId]);
}

export function resolveBotModel(agent, fallback = {}) {
  const fallbackTier = isValidModelTier(fallback.modelTier) && !AI_MODEL_TIERS[fallback.modelTier]?.local
    ? fallback.modelTier
    : (isValidModelTier(fallback.selectedModelTier) && !AI_MODEL_TIERS[fallback.selectedModelTier]?.local
      ? fallback.selectedModelTier
      : 'cloud');
  const fallbackCloud = AI_CLOUD_MODELS[fallback.cloudModelId]
    ? fallback.cloudModelId
    : (AI_CLOUD_MODELS[fallback.selectedCloudModelId]
      ? fallback.selectedCloudModelId
      : AI_CLOUD_DEFAULT_MODEL_ID);
  const rawTier = isValidModelTier(agent?.modelTier) ? agent.modelTier : fallbackTier;
  const modelTier = AI_MODEL_TIERS[rawTier]?.local ? 'cloud' : rawTier;
  const cloudModelId = AI_CLOUD_MODELS[agent?.cloudModelId] ? agent.cloudModelId : fallbackCloud;
  const openaiBaseUrl = typeof agent?.openaiBaseUrl === 'string' ? agent.openaiBaseUrl.trim() : '';
  const openaiApiKey = typeof agent?.openaiApiKey === 'string' ? agent.openaiApiKey : '';
  const openaiModel = typeof agent?.openaiModel === 'string' ? agent.openaiModel.trim() : '';
  const modelSource = agent?.modelSource === 'openai' || agent?.modelSource === 'cloud'
    ? agent.modelSource
    : (openaiBaseUrl && openaiModel ? 'openai' : 'cloud');
  return {
    modelTier,
    cloudModelId,
    modelSource,
    openaiBaseUrl,
    openaiApiKey,
    openaiModel,
  };
}

export function botHasRemoteApi(agent, globalOpenai = null, ollamaState = null) {
  const resolved = resolveBotModel(agent, {});
  if (resolved.modelSource === 'openai') {
    if (resolved.openaiBaseUrl && resolved.openaiModel) return true;
    return Boolean(globalOpenai?.baseUrl && globalOpenai?.model);
  }
  return Boolean(ollamaState?.cloudAuth);
}

export function migrateBotDescription(agent) {
  const direct = typeof agent?.description === 'string' ? agent.description.trim() : '';
  if (direct) return direct.slice(0, BOT_DESCRIPTION_MAX_CHARS);
  const personality = resolveAgentPersonality(agent);
  const parts = [];
  const bio = typeof agent?.bio === 'string' ? agent.bio.trim() : '';
  if (bio) parts.push(bio);
  if (typeof agent?.personality === 'string' && agent.personality) {
    const preset = AI_PERSONALITY_PRESETS[agent.personality]?.prompt?.trim();
    if (preset) parts.push(preset);
  }
  if (personality.personalityCustom) parts.push(personality.personalityCustom);
  return parts.join('\n\n').slice(0, BOT_DESCRIPTION_MAX_CHARS);
}

export function clampRoutineIntervalMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.min(BOT_ROUTINE_MAX_INTERVAL_MINUTES, Math.max(BOT_ROUTINE_MIN_INTERVAL_MINUTES, Math.round(n)));
}

export function normalizeBotRoutine(routine, index = 0) {
  const triggerType = BOT_ROUTINE_TRIGGER_IDS.includes(routine?.triggerType)
    ? routine.triggerType
    : BOT_ROUTINE_DEFAULT_TRIGGER;
  const id = typeof routine?.id === 'string' && routine.id.trim()
    ? routine.id.trim()
    : `rt-${Date.now().toString(36)}-${index}`;
  const hourRaw = Number(routine?.hour);
  const minuteRaw = Number(routine?.minute);
  return {
    id,
    name: String(routine?.name || 'Routine').trim().slice(0, BOT_ROUTINE_NAME_MAX_CHARS) || 'Routine',
    prompt: String(routine?.prompt || '').trim().slice(0, BOT_ROUTINE_PROMPT_MAX_CHARS),
    enabled: routine?.enabled !== false,
    triggerType,
    intervalMinutes: clampRoutineIntervalMinutes(routine?.intervalMinutes),
    hour: Number.isFinite(hourRaw) ? Math.min(23, Math.max(0, Math.round(hourRaw))) : 8,
    minute: Number.isFinite(minuteRaw) ? Math.min(59, Math.max(0, Math.round(minuteRaw))) : 0,
    lastRunAt: Number(routine?.lastRunAt) || 0,
  };
}

export function normalizeBotRoutines(routines) {
  if (!Array.isArray(routines)) return [];
  return routines.map((routine, index) => normalizeBotRoutine(routine, index));
}

export function nextRoutineRunAt(routine, now = Date.now()) {
  if (!routine || routine.enabled === false) return 0;
  if (routine.triggerType === 'interval') {
    const last = Number(routine.lastRunAt) || 0;
    const span = clampRoutineIntervalMinutes(routine.intervalMinutes) * 60_000;
    return (last > 0 ? last : now) + span;
  }
  if (routine.triggerType === 'daily') {
    const next = new Date(now);
    next.setHours(Number(routine.hour) || 0, Number(routine.minute) || 0, 0, 0);
    const last = Number(routine.lastRunAt) || 0;
    if (next.getTime() <= now || (last > 0 && new Date(last).toDateString() === next.toDateString())) {
      next.setDate(next.getDate() + 1);
    }
    return next.getTime();
  }
  return 0;
}

export function formatRoutineRunAt(ts) {
  const n = Number(ts);
  if (!n) return '';
  return new Date(n).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

export function createEmptyBotRoutine() {
  return normalizeBotRoutine({
    id: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    prompt: '',
    enabled: true,
    triggerType: 'manual',
    intervalMinutes: 60,
    hour: 8,
    minute: 0,
  });
}

export function isValidPersonalityId(personalityId) {
  return Boolean(AI_PERSONALITY_PRESETS[personalityId]);
}

export function resolveAgentPersonality(agent) {
  const personalityId = isValidPersonalityId(agent?.personality)
    ? agent.personality
    : AI_PERSONALITY_DEFAULT_ID;
  const personalityCustom = typeof agent?.personalityCustom === 'string'
    ? agent.personalityCustom.trim().slice(0, AI_PERSONALITY_CUSTOM_MAX_CHARS)
    : '';
  return { personalityId, personalityCustom };
}

export const AI_AGENT_MODES = {
  agent: {
    id: 'agent',
    label: 'Agent',
    description: 'Agent mit Datei-, Befehls- und BlueTalk-Werkzeugen',
  },
};
export const AI_AGENT_MODE_IDS = Object.keys(AI_AGENT_MODES);
export const AI_AGENT_DEFAULT_MODE_ID = 'agent';

export const AI_THINKING_MODES = {
  auto: { id: 'auto', label: 'Auto', description: 'Thinking je nach Modellstufe automatisch' },
  on: { id: 'on', label: 'An', description: 'Tiefes Reasoning aktiviert (langsamer, gründlicher)' },
  off: { id: 'off', label: 'Aus', description: 'Kein Thinking — schnelle, direkte Antworten' },
};
export const AI_THINKING_MODE_IDS = Object.keys(AI_THINKING_MODES);
export const AI_THINKING_DEFAULT_MODE_ID = 'auto';

export function isValidThinkingMode(modeId) {
  return Boolean(AI_THINKING_MODES[modeId]);
}

export function resolveAgentThinkingMode(agent) {
  const raw = typeof agent?.thinkingMode === 'string' ? agent.thinkingMode.trim() : '';
  return isValidThinkingMode(raw) ? raw : AI_THINKING_DEFAULT_MODE_ID;
}

export function isValidAgentMode(modeId) {
  return modeId === 'agent' || modeId === 'off';
}

export function normalizeAgentMode(modeId) {
  return modeId === 'off' ? 'agent' : (isValidAgentMode(modeId) ? modeId : AI_AGENT_DEFAULT_MODE_ID);
}

export function isAgentModeEnabled(agent) {
  return Boolean(agent);
}

export function resolveAgentWorkDir(agent) {
  const raw = typeof agent?.agentWorkDir === 'string' ? agent.agentWorkDir.trim() : '';
  return raw || '';
}

export function resolveAllowBluetalkMessaging(agent) {
  return Boolean(agent?.allowBluetalkMessaging);
}

export function isAiChatPeerId(peerId) {
  return peerId === AI_CHAT_PEER_ID || String(peerId || '').startsWith(AI_CHAT_PEER_PREFIX);
}

export function isModelTierVisible(tier, debugMode = false) {
  if (!tier) return false;
  return !tier.debugOnly || Boolean(debugMode);
}

export function modelSupportsVision(selectedModelTier, selectedCloudModelId) {
  const tier = AI_MODEL_TIERS[selectedModelTier];
  if (!tier) return false;
  if (tier.id === 'cloud') {
    const cloudId = AI_CLOUD_MODELS[selectedCloudModelId]
      ? selectedCloudModelId
      : AI_CLOUD_DEFAULT_MODEL_ID;
    return Boolean(AI_CLOUD_MODELS[cloudId]?.supportsVision);
  }
  return Boolean(tier.supportsVision);
}
