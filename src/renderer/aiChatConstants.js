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
