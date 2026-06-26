const { app, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsPromises = require('fs/promises');
const http = require('http');
const https = require('https');
const path = require('path');
const { pipeline } = require('stream/promises');
const {
  AI_MODEL_TIERS,
  AI_MODEL_TIER_IDS,
  OLLAMA_DEFAULT_PORT,
  OLLAMA_SYSTEM_PORT,
  OLLAMA_RUNTIME_DISCLAIMER_BYTES,
  OLLAMA_DEFAULT_RUNTIME_MODE,
  OLLAMA_RUNTIME_MODE_SYSTEM,
  AI_AGENT_TOOLS,
  AI_AGENT_TOOL_NAMES,
  getToolsForTier,
  getSystemPromptForAgent,
  resolveAgentPersonality,
  isAgentModeEnabled,
  resolveAgentWorkDir,
  resolveAllowBluetalkMessaging,
  getModelTier,
  isValidModelTier,
  getCloudModel,
  isValidCloudModel,
  getDefaultCloudModelId,
  resolveCloudModelId,
  resolveActiveModelName,
  isAiChatPeerId,
  resolveThinkOption,
  resolveAgentThinkingMode,
  resolveOllamaRuntimeMode,
} = require(path.join(__dirname, '..', 'shared', 'ai-chat-constants.js'));
const {
  defaultWorkDir,
  executeToolCall,
  extractToolCallsFromText,
  normalizeToolCallsForOllama,
  sanitizeMessagesForOllama,
  formatToolResultMessageContent,
} = require(path.join(__dirname, 'agent-tools.js'));
const {
  BLUETALK_OLLAMA_MODELS_ENV,
  defaultModelsDir,
  isBlueTalkManagedModelsDir,
  isSameOrInsidePath,
  resolveOllamaModelsDir,
  resolveSystemOllamaModelsDir,
  windowsPublicModelsDir,
} = require(path.join(__dirname, 'ollama-paths.js'));

const RUNTIME_DIR_NAME = 'runtime';

function platformRuntimeAsset() {
  if (process.platform === 'win32') return 'ollama-windows-amd64.zip';
  if (process.platform === 'darwin') return 'ollama-darwin.zip';
  return 'ollama-linux-amd64.tgz';
}

function isArchiveTgz(name) {
  return name.endsWith('.tgz') || name.endsWith('.tar.gz');
}

function splitThinkingText(rawText) {
  const raw = String(rawText || '');
  if (!raw) return { thinking: '', content: '' };

  let content = '';
  let thinking = '';
  let cursor = 0;
  const openRe = /<think>/ig;
  let match = openRe.exec(raw);

  while (match) {
    content += raw.slice(cursor, match.index);
    const bodyStart = openRe.lastIndex;
    const closeRe = /<\/think>/ig;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(raw);
    if (!close) {
      thinking += raw.slice(bodyStart);
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
    content: content.trim(),
  };
}

const {
  upsertStreamThinking,
  upsertStreamAnswer,
  consolidateSegments,
} = require(path.join(__dirname, 'ai-stream-segments.js'));

class OllamaManager {
  constructor({
    store,
    onStateChange,
    invokePluginCommand,
    askUser,
    readBluetalkMessages,
    sendBluetalkMessage,
    getContactLabel,
  }) {
    this.store = store;
    this.onStateChange = onStateChange || (() => {});
    this.invokePluginCommand = typeof invokePluginCommand === 'function'
      ? invokePluginCommand
      : null;
    this.askUser = typeof askUser === 'function' ? askUser : null;
    this.readBluetalkMessages = typeof readBluetalkMessages === 'function'
      ? readBluetalkMessages
      : null;
    this.sendBluetalkMessage = typeof sendBluetalkMessage === 'function'
      ? sendBluetalkMessage
      : null;
    this.getContactLabel = typeof getContactLabel === 'function'
      ? getContactLabel
      : null;
    this.userDataDir = app.getPath('userData');
    this.baseDir = path.join(this.userDataDir, 'ollama');
    this.runtimeDir = path.join(this.baseDir, RUNTIME_DIR_NAME);
    this.runtimeMode = resolveOllamaRuntimeMode(this.store.get('aiChat.ollamaRuntimeMode', ''));
    this.systemRuntimePath = '';
    this._applyRuntimeMode();
    this.serverProcess = null;
    this.serverProcessMode = '';
    this.downloadAbort = null;
    this.modelPullAbort = null;
    this.chatAborters = new Map();
    this.state = this._emptyState();
  }

  _isSystemRuntime() {
    return this.runtimeMode === OLLAMA_RUNTIME_MODE_SYSTEM;
  }

  _runtimePort() {
    return this._isSystemRuntime() ? OLLAMA_SYSTEM_PORT : OLLAMA_DEFAULT_PORT;
  }

  _applyRuntimeMode() {
    const storedMode = resolveOllamaRuntimeMode(this.store.get('aiChat.ollamaRuntimeMode', ''));
    this.runtimeMode = storedMode;
    const modelsPath = this._isSystemRuntime()
      ? resolveSystemOllamaModelsDir()
      : resolveOllamaModelsDir({ appUserDataDir: this.userDataDir });
    this.modelsDir = modelsPath.dir;
    this.modelsDirSource = modelsPath.source;
  }

  _emptyState() {
    return {
      runtimeMode: this.runtimeMode || OLLAMA_DEFAULT_RUNTIME_MODE,
      runtimeStatus: 'missing',
      runtimePath: '',
      runtimeError: '',
      runtimePercent: 0,
      runtimeDownloadedBytes: 0,
      runtimeTotalBytes: OLLAMA_RUNTIME_DISCLAIMER_BYTES,
      serverRunning: false,
      selectedModelTier: '',
      modelStatus: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, 'missing'])),
      modelPercent: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, 0])),
      modelDownloadedBytes: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, 0])),
      modelTotalBytes: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, 0])),
      modelProgressStatus: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, ''])),
      modelError: Object.fromEntries(AI_MODEL_TIER_IDS.map((id) => [id, ''])),
      cloudAuth: false,
      selectedCloudModelId: getDefaultCloudModelId(),
      setupComplete: false,
      activeModel: '',
    };
  }

  async init() {
    this._applyRuntimeMode();
    if (!this._isSystemRuntime()) {
      await this._prepareModelsDir();
    }
    await fsPromises.mkdir(this.runtimeDir, { recursive: true });
    await this.refreshState();
  }

  async stop() {
    this._abortRuntimeDownload();
    this._abortModelPull();
    for (const abort of this.chatAborters.values()) {
      try {
        abort();
      } catch {
        /* ignore */
      }
    }
    this.chatAborters.clear();
    await this._stopServer();
  }

  getState() {
    return { ...this.state };
  }

  getStoragePaths() {
    return {
      runtimeMode: this.runtimeMode,
      baseDir: this.baseDir,
      runtimeDir: this.runtimeDir,
      modelsDir: this.modelsDir,
      modelsDirSource: this.modelsDirSource,
      modelsEnvVariable: BLUETALK_OLLAMA_MODELS_ENV,
      serverPort: this._runtimePort(),
      runtimePath: this.state.runtimePath || (this._isSystemRuntime() ? this.systemRuntimePath : this._ollamaBinaryPath()),
    };
  }

  _broadcast(patch = {}) {
    this.state = { ...this.state, ...patch };
    this.onStateChange(this.getState());
  }

  _ollamaBinaryPath() {
    const winExe = path.join(this.runtimeDir, 'ollama.exe');
    const unixBin = path.join(this.runtimeDir, 'ollama');
    if (process.platform === 'win32' && fs.existsSync(winExe)) return winExe;
    if (process.platform !== 'win32' && fs.existsSync(unixBin)) return unixBin;
    return '';
  }

  async _runtimeBinaryPath() {
    if (!this._isSystemRuntime()) return this._ollamaBinaryPath();
    const bin = await this._detectSystemOllama();
    this.systemRuntimePath = bin;
    return bin;
  }

  _runtimeEnv() {
    const env = {
      ...process.env,
      OLLAMA_HOST: `127.0.0.1:${this._runtimePort()}`,
      OLLAMA_ORIGINS: '*',
    };
    if (!this._isSystemRuntime()) {
      env.OLLAMA_MODELS = this.modelsDir;
    }
    return env;
  }

  async _prepareModelsDir() {
    const preferred = resolveOllamaModelsDir({ appUserDataDir: this.userDataDir });
    const fallback = {
      dir: defaultModelsDir(this.userDataDir),
      source: 'userData-fallback',
    };
    const candidates = [];
    const safePublicFallback = process.platform === 'win32' && preferred.source === 'windows-safe'
      ? { dir: windowsPublicModelsDir(process.env), source: 'windows-public' }
      : null;
    for (const candidate of [preferred, safePublicFallback, fallback]) {
      if (!candidate?.dir) continue;
      if (candidates.some((entry) => path.resolve(entry.dir) === path.resolve(candidate.dir))) continue;
      candidates.push(candidate);
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await fsPromises.mkdir(candidate.dir, { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await fsPromises.access(candidate.dir, fs.constants.R_OK | fs.constants.W_OK);
        this.modelsDir = candidate.dir;
        this.modelsDirSource = candidate.source;
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Modellordner konnte nicht angelegt werden.');
  }

  async _runtimeLooksReady() {
    if (this._isSystemRuntime() && await this._pingServer()) {
      return true;
    }
    const bin = await this._runtimeBinaryPath();
    if (!bin) return false;
    if (this._isSystemRuntime()) return true;
    try {
      await fsPromises.access(bin, fs.constants.X_OK | fs.constants.R_OK);
    } catch {
      if (process.platform === 'win32') {
        try {
          await fsPromises.access(bin, fs.constants.R_OK);
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  async _detectSystemOllama() {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['ollama'], { timeout: 4000 }, (err, stdout) => {
        if (err || !stdout?.trim()) {
          resolve('');
          return;
        }
        resolve(stdout.trim().split(/\r?\n/)[0].trim());
      });
    });
  }

  async _listLocalModels() {
    try {
      const res = await this._apiRequest('GET', '/api/tags');
      const models = res?.models || [];
      return new Set(models.map((m) => m.name).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async _refreshModelStatuses(localModels) {
    const modelStatus = { ...this.state.modelStatus };
    for (const tierId of AI_MODEL_TIER_IDS) {
      const tier = getModelTier(tierId);
      if (!tier) continue;
      if (tierId === 'cloud') {
        modelStatus[tierId] = this.state.cloudAuth ? 'ready' : 'missing';
        continue;
      }
      const hasModel = localModels.has(tier.model);
      if (this.state.modelStatus[tierId] === 'downloading') continue;
      modelStatus[tierId] = hasModel ? 'ready' : 'missing';
    }
    return modelStatus;
  }

  _computeSetupComplete({ runtimeStatus, selectedModelTier, modelStatus, cloudAuth }) {
    if (runtimeStatus !== 'ready') return false;
    if (!selectedModelTier || !isValidModelTier(selectedModelTier)) return false;
    const tier = getModelTier(selectedModelTier);
    if (!tier) return false;
    if (tier.requiresAuth) return cloudAuth && modelStatus.cloud === 'ready';
    return modelStatus[selectedModelTier] === 'ready';
  }

  async refreshState() {
    this._applyRuntimeMode();
    const storedTier = this.store.get('aiChat.selectedModelTier', '') || '';
    const runtimeReady = await this._runtimeLooksReady();
    let runtimeStatus = runtimeReady ? 'ready' : 'missing';
    let runtimePath = runtimeReady ? await this._runtimeBinaryPath() : '';
    let runtimeError = '';
    let serverRunning = false;

    if (this.state.runtimeStatus === 'downloading') {
      runtimeStatus = 'downloading';
    }

    if (runtimeReady && runtimeStatus !== 'downloading') {
      serverRunning = await this._ensureServerRunning();
      if (!serverRunning) {
        runtimeStatus = 'error';
        runtimeError = this._isSystemRuntime()
          ? 'Eigener Ollama-Server ist nicht erreichbar. Starte Ollama oder wechsle zu BlueTalk-Ollama.'
          : 'BlueTalk-Ollama konnte nicht gestartet werden.';
      }
    }

    const cloudAuth = Boolean(this.store.get('aiChat.cloudAuth', false));
    const selectedCloudModelId = resolveCloudModelId(this.store.get('aiChat.selectedCloudModelId', ''));
    if (selectedCloudModelId !== this.store.get('aiChat.selectedCloudModelId', '')) {
      this.store.set('aiChat.selectedCloudModelId', selectedCloudModelId);
    }
    const localModels = runtimeStatus === 'ready' ? await this._listLocalModels() : new Set();
    const modelStatus = await this._refreshModelStatuses(localModels);

    const selectedModelTier = storedTier;
    const setupComplete = this._computeSetupComplete({
      runtimeStatus,
      selectedModelTier,
      modelStatus,
      cloudAuth,
    });

    if (setupComplete !== this.store.get('aiChat.setupComplete', false)) {
      this.store.set('aiChat.setupComplete', setupComplete);
    }

    this._broadcast({
      runtimeMode: this.runtimeMode,
      runtimeStatus,
      runtimePath,
      runtimeError: runtimeStatus === 'error' ? (runtimeError || this.state.runtimeError) : '',
      serverRunning,
      selectedModelTier,
      modelStatus,
      cloudAuth,
      selectedCloudModelId,
      setupComplete,
      activeModel: resolveActiveModelName(selectedModelTier, selectedCloudModelId),
    });

    return this.getState();
  }

  async downloadRuntime() {
    this._applyRuntimeMode();
    if (this._isSystemRuntime()) {
      this._broadcast({
        runtimeStatus: 'error',
        runtimeError: 'Im eigenen Ollama-Modus verwaltet BlueTalk die Runtime nicht.',
      });
      return this.refreshState();
    }
    if (this.state.runtimeStatus === 'downloading') return this.getState();
    if (await this._runtimeLooksReady()) {
      await this.refreshState();
      return this.getState();
    }

    const asset = platformRuntimeAsset();
    const url = `https://github.com/ollama/ollama/releases/latest/download/${asset}`;
    const archivePath = path.join(this.baseDir, asset);

    this._broadcast({
      runtimeStatus: 'downloading',
      runtimeError: '',
      runtimePercent: 0,
      runtimeDownloadedBytes: 0,
      runtimeTotalBytes: OLLAMA_RUNTIME_DISCLAIMER_BYTES,
    });

    try {
      await fsPromises.mkdir(this.baseDir, { recursive: true });
      await this._downloadFile(url, archivePath, (progress) => {
        this._broadcast({
          runtimeStatus: 'downloading',
          runtimePercent: progress.percent,
          runtimeDownloadedBytes: progress.downloadedBytes,
          runtimeTotalBytes: progress.totalBytes || OLLAMA_RUNTIME_DISCLAIMER_BYTES,
        });
      });

      await this._extractArchive(archivePath, this.runtimeDir);
      await fsPromises.unlink(archivePath).catch(() => {});

      if (!(await this._runtimeLooksReady())) {
        throw new Error('Ollama konnte nach dem Entpacken nicht gefunden werden.');
      }

      const serverStarted = await this._ensureServerRunning();
      if (!serverStarted) {
        throw new Error('Ollama konnte nicht gestartet werden.');
      }
      this._broadcast({
        runtimeStatus: 'ready',
        runtimePath: this._ollamaBinaryPath(),
        runtimePercent: 100,
        runtimeError: '',
      });
    } catch (error) {
      this._broadcast({
        runtimeStatus: 'error',
        runtimeError: error?.message || 'Download fehlgeschlagen',
      });
    }

    return this.refreshState();
  }

  async selectRuntimeMode(mode) {
    const nextMode = resolveOllamaRuntimeMode(mode);
    if (nextMode === this.runtimeMode) {
      return { ok: true, state: await this.refreshState() };
    }

    this._abortRuntimeDownload();
    this._abortModelPull();
    for (const abort of this.chatAborters.values()) {
      try {
        abort();
      } catch {
        /* ignore */
      }
    }
    this.chatAborters.clear();
    await this._stopServer();

    this.store.set('aiChat.ollamaRuntimeMode', nextMode);
    this.runtimeMode = nextMode;
    this._applyRuntimeMode();
    return { ok: true, state: await this.refreshState() };
  }

  async selectModelTier(tierId) {
    if (!isValidModelTier(tierId)) {
      return { ok: false, error: 'invalid_tier', state: this.getState() };
    }
    const tier = getModelTier(tierId);
    if (tier?.requiresAuth && !this.state.cloudAuth) {
      return { ok: false, error: 'cloud_auth_required', state: this.getState() };
    }
    this.store.set('aiChat.selectedModelTier', tierId);
    await this.refreshState();
    return { ok: true, state: this.getState() };
  }

  async selectCloudModel(cloudModelId) {
    if (!isValidCloudModel(cloudModelId)) {
      return { ok: false, error: 'invalid_cloud_model', state: this.getState() };
    }
    this.store.set('aiChat.selectedCloudModelId', cloudModelId);
    await this.refreshState();
    return { ok: true, state: this.getState() };
  }

  async downloadModel(tierId) {
    if (!isValidModelTier(tierId)) {
      return { ok: false, error: 'invalid_tier', state: this.getState() };
    }

    const tier = getModelTier(tierId);
    if (tier.requiresAuth && !this.state.cloudAuth) {
      return { ok: false, error: 'cloud_auth_required', state: this.getState() };
    }

    if (this.state.runtimeStatus !== 'ready') {
      return { ok: false, error: 'runtime_not_ready', state: this.getState() };
    }

    if (tierId === 'cloud') {
      this.store.set('aiChat.selectedModelTier', 'cloud');
      await this.refreshState();
      return { ok: true, state: this.getState() };
    }

    if (this.state.modelStatus[tierId] === 'ready') {
      return { ok: true, state: this.getState() };
    }

    if (this.state.modelStatus[tierId] === 'downloading') {
      return { ok: true, state: this.getState() };
    }

    this.store.set('aiChat.selectedModelTier', tierId);
    await this._ensureServerRunning();

    const modelStatus = { ...this.state.modelStatus, [tierId]: 'downloading' };
    const modelPercent = { ...this.state.modelPercent, [tierId]: 0 };
    const modelDownloadedBytes = { ...this.state.modelDownloadedBytes, [tierId]: 0 };
    const modelTotalBytes = { ...this.state.modelTotalBytes, [tierId]: 0 };
    const modelProgressStatus = { ...this.state.modelProgressStatus, [tierId]: 'download_starting' };
    const modelError = { ...this.state.modelError, [tierId]: '' };
    this._broadcast({ modelStatus, modelPercent, modelDownloadedBytes, modelTotalBytes, modelProgressStatus, modelError });

    try {
      await this._pullModel(tier.model, (progress) => {
        const patch = {
          modelStatus: { ...this.state.modelStatus, [tierId]: 'downloading' },
        };
        if (typeof progress?.percent === 'number') {
          patch.modelPercent = { ...this.state.modelPercent, [tierId]: progress.percent };
        }
        if (typeof progress?.downloadedBytes === 'number') {
          patch.modelDownloadedBytes = { ...this.state.modelDownloadedBytes, [tierId]: progress.downloadedBytes };
        }
        if (typeof progress?.totalBytes === 'number') {
          patch.modelTotalBytes = { ...this.state.modelTotalBytes, [tierId]: progress.totalBytes };
        }
        if (typeof progress?.status === 'string') {
          patch.modelProgressStatus = { ...this.state.modelProgressStatus, [tierId]: progress.status };
        }
        this._broadcast(patch);
      });

      const finalTotalBytes = this.state.modelTotalBytes?.[tierId] || 0;
      this._broadcast({
        modelStatus: { ...this.state.modelStatus, [tierId]: 'ready' },
        modelPercent: { ...this.state.modelPercent, [tierId]: 100 },
        modelDownloadedBytes: { ...this.state.modelDownloadedBytes, [tierId]: finalTotalBytes },
        modelProgressStatus: { ...this.state.modelProgressStatus, [tierId]: 'success' },
        modelError: { ...this.state.modelError, [tierId]: '' },
      });
    } catch (error) {
      this._broadcast({
        modelStatus: { ...this.state.modelStatus, [tierId]: 'error' },
        modelError: { ...this.state.modelError, [tierId]: error?.message || 'Modell-Download fehlgeschlagen' },
      });
      return { ok: false, error: error?.message, state: this.getState() };
    }

    return this.refreshState().then((state) => ({ ok: true, state }));
  }

  async deleteModel(tierId) {
    if (!isValidModelTier(tierId)) {
      return { ok: false, error: 'invalid_tier', state: this.getState() };
    }
    const tier = getModelTier(tierId);
    if (!tier?.local) {
      return { ok: false, error: 'not_local_model', state: this.getState() };
    }
    if (this.state.runtimeStatus !== 'ready') {
      return { ok: false, error: 'runtime_not_ready', state: this.getState() };
    }

    await this._ensureServerRunning();
    try {
      await this._apiRequest('DELETE', '/api/delete', { name: tier.model });
    } catch (error) {
      const msg = String(error?.message || '');
      if (!msg.includes('not found') && !msg.includes('model not found')) {
        return { ok: false, error: error?.message || 'delete_failed', state: this.getState() };
      }
    }

    const modelStatus = { ...this.state.modelStatus, [tierId]: 'missing' };
    const modelPercent = { ...this.state.modelPercent, [tierId]: 0 };
    const modelDownloadedBytes = { ...this.state.modelDownloadedBytes, [tierId]: 0 };
    const modelTotalBytes = { ...this.state.modelTotalBytes, [tierId]: 0 };
    const modelProgressStatus = { ...this.state.modelProgressStatus, [tierId]: '' };
    this._broadcast({ modelStatus, modelPercent, modelDownloadedBytes, modelTotalBytes, modelProgressStatus });
    return this.refreshState().then((state) => ({ ok: true, state }));
  }

  async openModelsDir() {
    if (!this._isSystemRuntime()) {
      await fsPromises.mkdir(this.modelsDir, { recursive: true });
    }
    const result = await shell.openPath(this.modelsDir);
    return { ok: !result, error: result || '', path: this.modelsDir };
  }

  abortChat(requestId) {
    if (!requestId) return { ok: false, error: 'missing_request_id' };
    const abort = this.chatAborters.get(requestId);
    if (abort) {
      try {
        abort();
      } catch {
        /* ignore */
      }
      this.chatAborters.delete(requestId);
    }
    // Auch eine offene ask_user-Anfrage sofort abbrechen, damit der
    // Agent-Loop nicht an einem wartenden Dialog hängen bleibt.
    const askAbort = this.chatAborters.get(`ask:${requestId}`);
    if (askAbort) {
      try {
        askAbort();
      } catch {
        /* ignore */
      }
      this.chatAborters.delete(`ask:${requestId}`);
    }
    if (!abort && !askAbort) return { ok: false, error: 'not_found' };
    return { ok: true };
  }

  _thinkOption({ model, tierId, thinkingMode }) {
    return resolveThinkOption(thinkingMode, model, tierId);
  }

  async chat({ peerId, prompt, requestId, onProgress, askUser }) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, error: 'empty_prompt' };

    const state = await this.refreshState();
    if (!state.setupComplete) return { ok: false, error: 'setup_incomplete', state };

    const tier = getModelTier(state.selectedModelTier);
    const model = resolveActiveModelName(state.selectedModelTier, state.selectedCloudModelId);
    if (!model) return { ok: false, error: 'model_missing', state };

    const serverReady = await this._ensureServerRunning();
    if (!serverReady) return { ok: false, error: 'server_not_running', state: this.getState() };

    // Segmente in echter Reihenfolge: thinking -> tool -> thinking -> ... -> answer.
    // Werden während des Streamings live aufgebaut (liveSegments in
    // _chatRequestStream) und pro Tool-Aufruf ergänzt. Das Frontend rendert
    // sie originalgetreu mit je ausklappbarem Block.
    const segments = [];

    const emitProgress = (update) => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        requestId,
        thinking: update.thinking || '',
        content: update.content || '',
        toolCalls: Array.isArray(update.toolCalls) ? update.toolCalls : undefined,
        toolResults: Array.isArray(update.toolResults) ? update.toolResults : undefined,
        segments: Array.isArray(update.segments) ? update.segments : undefined,
        tps: typeof update.tps === 'number' ? update.tps : 0,
        genTimeMs: typeof update.genTimeMs === 'number' ? update.genTimeMs : 0,
        done: Boolean(update.done),
      });
    };

    const { agentEnabled, workDir, thinkingMode, allowBluetalkMessaging } = this._resolveAgentContext(peerId);
    const thinkOpt = this._thinkOption({ model, tierId: state.selectedModelTier, thinkingMode });
    const askUserHandler = async (question) => {
      const result = await this._runAskUser({ peerId, requestId, question, askUser });
      if (typeof result?.answer === 'string') return result.answer;
      return '';
    };
    const upsertSubagentSegment = (sub) => {
      const idx = segments.findIndex((s) => s.type === 'subagent' && s.id === sub.id);
      const seg = { type: 'subagent', ...sub };
      if (idx >= 0) segments[idx] = seg;
      else segments.push(seg);
    };

    let finalContent = '';
    let finalThinking = '';
    let finalStats = null;

    const toolCtx = {
      workDir,
      invokePluginCommand: this.invokePluginCommand
        ? (pluginId, commandId, args) => this.invokePluginCommand(pluginId, commandId, args)
        : undefined,
      memory: this._getAgentMemory(peerId),
      subagentRunner: (opts) => this._runSubagent({ ...opts, parentTier: state.selectedModelTier }),
      subagentTier: state.selectedModelTier,
      onSubagentStart: ({ id, task, tools: subTools }) => {
        upsertSubagentSegment({
          id,
          task,
          tools: subTools,
          status: 'running',
          content: '',
          thinking: '',
          toolEvents: [],
          segments: [],
        });
        emitProgress({
          thinking: finalThinking,
          content: finalContent,
          segments: [...segments],
          tps: 0,
          genTimeMs: 0,
          done: false,
        });
      },
      onSubagentProgress: (id, update) => {
        const existing = segments.find((s) => s.type === 'subagent' && s.id === id);
        if (!existing) return;
        if (update.content) existing.content = update.content;
        if (update.thinking) existing.thinking = update.thinking;
        if (Array.isArray(update.toolEvents)) existing.toolEvents = update.toolEvents;
        if (Array.isArray(update.segments)) existing.segments = update.segments;
        emitProgress({
          thinking: finalThinking,
          content: finalContent,
          segments: [...segments],
          tps: typeof update.tps === 'number' ? update.tps : 0,
          genTimeMs: typeof update.genTimeMs === 'number' ? update.genTimeMs : 0,
          done: false,
        });
      },
      onSubagentEnd: ({ id, ok, result, error }) => {
        const existing = segments.find((s) => s.type === 'subagent' && s.id === id);
        if (existing) {
          existing.status = ok ? 'done' : 'error';
          if (result?.content) existing.content = result.content;
          if (error) existing.error = error;
        }
        emitProgress({
          thinking: finalThinking,
          content: finalContent,
          segments: [...segments],
          tps: 0,
          genTimeMs: 0,
          done: false,
        });
      },
      askUser: askUserHandler,
      allowBluetalkMessaging,
      getContactLabel: (id) => (this.getContactLabel ? this.getContactLabel(id) : id),
      readBluetalkMessages: this.readBluetalkMessages
        ? (opts) => this.readBluetalkMessages(opts)
        : undefined,
      sendBluetalkMessage: this.sendBluetalkMessage
        ? (opts) => this.sendBluetalkMessage(opts)
        : undefined,
    };
    const tierTools = agentEnabled
      ? getToolsForTier(state.selectedModelTier).filter((tool) => {
        const name = tool.function.name;
        if ((name === 'read_bluetalk_messages' || name === 'send_bluetalk_message') && !allowBluetalkMessaging) {
          return false;
        }
        return true;
      })
      : [];
    const tierToolNames = tierTools.map((t) => t.function.name);

    try {
      const baseHistory = this._buildChatHistory(peerId, text, state.selectedModelTier, agentEnabled);
      let history = baseHistory;
      const collectedToolEvents = [];

      if (agentEnabled) {
        // eslint-disable-next-line no-constant-condition
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const response = await this._chatRequestStream(
            {
              model,
              messages: history,
              tools: tierTools,
              think: thinkOpt,
            },
            emitProgress,
            requestId,
            segments
          );
          const msgContent = response?.message?.content || '';
          const msgThinking = response?.message?.thinking || '';
          let toolCalls = Array.isArray(response?.message?.tool_calls)
            ? response.message.tool_calls
            : [];

          // Fallback: kleine lokale Modelle schreiben Tool-Aufrufe oft als
          // Text (```json {...} ``` oder rohes {...}) statt über tool_calls.
          // In dem Fall extrahieren wir sie aus dem Content, führen sie aus
          // und zeigen nur den bereinigten Text an.
          let displayContent = msgContent;
          if (!toolCalls.length && msgContent && tierToolNames.length) {
            const extracted = extractToolCallsFromText(msgContent, tierToolNames);
            if (extracted.calls.length) {
              toolCalls = extracted.calls;
              displayContent = extracted.cleanedText;
              console.log(
                `[Agent] Text-Fallback: ${extracted.calls.length} Tool-Aufruf(e) aus Content extrahiert ` +
                `(${extracted.calls.map((c) => c.function.name).join(', ')})`
              );
            }
          }

          finalStats = response?.stats || finalStats;
          if (displayContent) {
            finalContent = finalContent ? `${finalContent}\n\n${displayContent}` : displayContent;
          }
          if (msgThinking) {
            finalThinking = finalThinking ? `${finalThinking}\n\n${msgThinking}` : msgThinking;
          }
          // Segmente werden während des Streamings live aufgebaut
          // (liveSegments). Hier nach Stream-Ende nur sicherstellen, dass
          // Thinking und finales Content-Segment vorhanden sind — kein
          // Duplikat erzeugen, wenn das Streaming sie schon angelegt hat.
          if (msgThinking) {
            upsertStreamThinking(segments, msgThinking);
          }
          if (displayContent && displayContent.trim()) {
            upsertStreamAnswer(segments, displayContent);
          }

          if (!toolCalls.length) {
            break;
          }

          // Assistant-Nachricht mit Tool-Aufrufen an History anhängen.
          // Arguments müssen Objekte sein — Ollama lehnt JSON-Strings ab.
          history = [
            ...history,
            {
              role: 'assistant',
              content: displayContent || '',
              tool_calls: normalizeToolCallsForOllama(toolCalls),
            },
          ];

          let pendingUserQuestion = '';
          for (const call of toolCalls) {
            // eslint-disable-next-line no-await-in-loop
            const toolResult = await executeToolCall(call, toolCtx);
            const toolName = String(call?.function?.name || call?.name || '');
            console.log(
              `[Agent] Tool ausgefuehrt: ${toolName} -> ok=${toolResult?.ok !== false}`,
              toolResult?.error ? `error=${toolResult.error}` : ''
            );
            // Memory-Änderungen persistent sichern
            if (toolName === 'memory') this._persistAgentMemory(peerId);
            const toolEvent = {
              name: toolName,
              arguments: call?.function?.arguments ?? call?.arguments,
              result: toolResult,
            };
            collectedToolEvents.push(toolEvent);
            segments.push({ type: 'tool', event: toolEvent });
            const lastThinking = segments[segments.length - 2];
            if (lastThinking && lastThinking.type === 'thinking') {
              lastThinking.toolAfter = true;
            }
            emitProgress({
              thinking: finalThinking,
              content: finalContent,
              toolResults: [toolEvent],
              segments,
              tps: 0,
              genTimeMs: 0,
              done: false,
            });
            const toolMessage = {
              role: 'tool',
              name: toolName,
              content: formatToolResultMessageContent(toolName, toolResult),
            };
            history = [...history, toolMessage];

            // ask_user: Agent-Loop anhalten und Frage als finale Antwort
            // ausgeben. Der Nutzer antwortet im nächsten Chat-Turn normal,
            // was als neue User-Nachricht ans Modell geht.
            if (toolResult && toolResult.pending_user && toolResult.question) {
              pendingUserQuestion = String(toolResult.question);
              break;
            }
          }
          if (pendingUserQuestion) {
            finalContent = (finalContent ? `${finalContent}\n\n` : '') + `❓ ${pendingUserQuestion}`;
            break;
          }
        }
      } else {
        const response = await this._chatRequestStream(
          {
            model,
            messages: history,
            think: thinkOpt,
          },
          emitProgress,
          requestId,
          segments
        );
        finalContent = response?.message?.content || '';
        finalThinking = response?.message?.thinking || '';
        finalStats = response?.stats || null;
        // Segmente wurden während des Streamings live aufgebaut.
      }

      const split = splitThinkingText(finalContent);
      const content = split.content || finalContent;
      const thinking = [finalThinking, split.thinking].filter(Boolean).join('\n\n');
      // Kein harter Fehler, wenn zwar kein Text, aber Thinking- oder Tool-Segmente
      // vorhanden sind — kleine Modelle beenden den Loop oft ohne finale Antwort.
      const hasSegments = segments.some(
        (s) => s.type === 'thinking' || s.type === 'tool' || s.type === 'answer'
      );
      if (!content.trim() && !hasSegments) {
        return { ok: false, error: 'empty_response', state: this.getState() };
      }

      const normalizedSegments = consolidateSegments(segments);

      return {
        ok: true,
        message: {
          kind: 'chat',
          content,
          thinking: thinking.trim() || undefined,
          toolEvents: collectedToolEvents.length ? collectedToolEvents : undefined,
          segments: normalizedSegments.length ? normalizedSegments : undefined,
          stats: finalStats || undefined,
          sender: tier?.id === 'cloud'
            ? (getCloudModel(state.selectedCloudModelId)?.label || 'Cloud')
            : (tier?.label || 'Ollama'),
          model,
        },
        state: this.getState(),
      };
    } catch (error) {
      return {
        ok: false,
        error: error?.message || 'chat_failed',
        state: this.getState(),
      };
    }
  }

  async startCloudSignIn() {
    const bin = await this._runtimeBinaryPath();
    if (!bin) {
      return { ok: false, error: 'runtime_not_ready', state: this.getState() };
    }

    await this._ensureServerRunning();

    return new Promise((resolve) => {
      const child = spawn(bin, ['signin'], {
        env: this._runtimeEnv(),
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.unref();
      child.on('error', (err) => {
        resolve({ ok: false, error: err.message, state: this.getState() });
      });
      child.on('spawn', () => {
        resolve({ ok: true, state: this.getState() });
      });
    });
  }

  async confirmCloudAuth() {
    this.store.set('aiChat.cloudAuth', true);
    const modelStatus = { ...this.state.modelStatus, cloud: 'ready' };
    this._broadcast({ cloudAuth: true, modelStatus });
    return this.refreshState().then((state) => ({ ok: true, state }));
  }

  _resolveAgentPersonality(peerId) {
    const agent = this._getAgent(peerId);
    return resolveAgentPersonality(agent);
  }

  _getAgent(peerId) {
    const agents = this.store.get('aiChat.agents', []);
    const list = Array.isArray(agents) ? agents : [];
    return list.find((entry) => entry?.id === peerId) || null;
  }

  _resolveAgentContext(peerId) {
    const agent = this._getAgent(peerId);
    const personality = resolveAgentPersonality(agent);
    const agentEnabled = isAgentModeEnabled(agent);
    const workDirRaw = resolveAgentWorkDir(agent);
    const workDir = workDirRaw || defaultWorkDir();
    const thinkingMode = resolveAgentThinkingMode(agent);
    const allowBluetalkMessaging = resolveAllowBluetalkMessaging(agent);
    return { personality, agentEnabled, workDir, agent, thinkingMode, allowBluetalkMessaging };
  }

  /**
   * Persistenter Memory-Speicher pro Agent. Bleibt während der
   * App-Sitzung im Speicher und wird zusätzlich im Store gesichert.
   */
  _getAgentMemory(peerId) {
    if (!this._memoryCache) this._memoryCache = new Map();
    if (this._memoryCache.has(peerId)) return this._memoryCache.get(peerId);
    const stored = this.store.get(`aiChat.memory.${peerId}`, {}) || {};
    const bag = { ...stored };
    this._memoryCache.set(peerId, bag);
    return bag;
  }

  _persistAgentMemory(peerId) {
    if (!this._memoryCache) return;
    const bag = this._memoryCache.get(peerId);
    if (!bag) return;
    this.store.set(`aiChat.memory.${peerId}`, bag);
  }

  /** Löscht den persistenten Agent-Kontext (memory-Tool) für einen KI-Chat. */
  clearAgentContext(peerId) {
    if (!isAiChatPeerId(peerId)) return { ok: false, error: 'not_ai_chat' };
    if (this._memoryCache) this._memoryCache.delete(peerId);
    this.store.delete(`aiChat.memory.${peerId}`);
    return { ok: true };
  }

  /**
   * Führt eine ask_user-Anfrage aus: ruft den übergebenen askUser-Callback
   * (Renderer-Dialog) auf, registriert einen Abarter, sodass abortChat den
   * wartenden Dialog sofort auflösen kann, und fällt bei Timeout/Ausfall
   * sauber auf eine leere Antwort zurück — ohne den Agent-Loop blockieren.
   */
  async _runAskUser({ peerId, requestId, question, askUser }) {
    const callback = typeof askUser === 'function' ? askUser : this.askUser;
    if (typeof callback !== 'function') {
      return {
        ok: true,
        pending_user: true,
        answered: false,
        question,
        note: 'Kein interaktiver Dialog verfügbar.',
      };
    }
    const key = `ask:${requestId}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.chatAborters.delete(key);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: true, answered: false, question, answer: '', note: 'Zeitüberschreitung.' }), 3 * 60 * 1000);
      this.chatAborters.set(key, () => finish({ ok: true, answered: false, question, answer: '', note: 'Abgebrochen.' }));
      Promise.resolve()
        .then(() => callback({ peerId, requestId, question }))
        .then((answer) => {
          const text = String(answer || '').trim();
          finish({
            ok: true,
            answered: Boolean(text),
            question,
            answer: text.slice(0, 8000),
          });
        })
        .catch((e) => finish({ ok: false, error: e?.message || 'ask_user_failed', question }));
    });
  }

  /**
   * Führt einen Sub-Agenten aus: eigener Ollama-Chat mit eigenen Tools,
   * eigenem Loop und eigenem System-Prompt. Nutzt das gleiche Modell
   * wie der Eltern-Agent. Gibt die finale Textantwort zurück.
   */
  async _runSubagent({
    task,
    systemPrompt,
    tools,
    workDir,
    memory,
    invokePluginCommand,
    parentTier,
    subagentId,
    onProgress,
  }) {
    const state = await this.refreshState();
    const model = resolveActiveModelName(state.selectedModelTier, state.selectedCloudModelId)
      || resolveActiveModelName(parentTier, state.selectedCloudModelId);
    if (!model) throw new Error('subagent_model_missing');
    const ready = await this._ensureServerRunning();
    if (!ready) throw new Error('subagent_server_not_running');

    const subCtx = {
      workDir,
      invokePluginCommand,
      memory: memory || {},
      subagentRunner: null, // Sub-Agent darf keine weiteren Sub-Agenten starten (Rekursionsschutz)
      subagentTier: state.selectedModelTier,
    };
    const messages = [
      { role: 'system', content: systemPrompt || getSystemPromptForAgent(parentTier, { agentMode: true }) },
      { role: 'user', content: task },
    ];
    const subThink = false;

    const subSegments = [];
    const subToolEvents = [];
    let lastContent = '';
    let lastThinking = '';

    const emitSubProgress = (update) => {
      if (typeof onProgress !== 'function') return;
      onProgress({
        subagentId,
        content: update.content ?? lastContent,
        thinking: update.thinking ?? lastThinking,
        toolEvents: update.toolEvents ?? [...subToolEvents],
        segments: update.segments ?? [...subSegments],
        tps: typeof update.tps === 'number' ? update.tps : 0,
        genTimeMs: typeof update.genTimeMs === 'number' ? update.genTimeMs : 0,
      });
    };

    // eslint-disable-next-line no-constant-condition
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const response = await this._chatRequestStream(
        {
          model,
          messages,
          tools: tools && tools.length ? tools : AI_AGENT_TOOLS,
          think: subThink,
        },
        (update) => {
          if (update.content) lastContent = update.content;
          if (update.thinking) lastThinking = update.thinking;
          emitSubProgress(update);
        },
        null,
        subSegments
      );
      const content = response?.message?.content || '';
      lastContent = content.trim() || lastContent;
      const toolCalls = Array.isArray(response?.message?.tool_calls) ? response.message.tool_calls : [];
      if (!toolCalls.length) {
        emitSubProgress({ content: content.trim(), thinking: lastThinking });
        return { content: content.trim() };
      }
      messages.push({
        role: 'assistant',
        content,
        tool_calls: normalizeToolCallsForOllama(toolCalls),
      });
      for (const call of toolCalls) {
        // eslint-disable-next-line no-await-in-loop
        const result = await executeToolCall(call, subCtx);
        const toolName = String(call?.function?.name || call?.name || '');
        const toolEvent = {
          name: toolName,
          arguments: call?.function?.arguments ?? call?.arguments,
          result,
        };
        subToolEvents.push(toolEvent);
        subSegments.push({ type: 'tool', event: toolEvent });
        const lastThinkingSeg = subSegments[subSegments.length - 2];
        if (lastThinkingSeg && lastThinkingSeg.type === 'thinking') {
          lastThinkingSeg.toolAfter = true;
        }
        emitSubProgress({ content: lastContent, thinking: lastThinking });
        messages.push({
          role: 'tool',
          name: toolName,
          content: formatToolResultMessageContent(toolName, result),
        });
      }
    }
  }

  _buildChatHistory(peerId, latestPrompt, tierId, agentEnabled) {
    const raw = this.store.get(`messages.${peerId}`, []);
    const list = Array.isArray(raw) ? raw : [];
    const messages = [];
    for (const item of list.slice(-24)) {
      if (!item || item.kind !== 'chat') continue;
      const content = String(item.content || '').trim();
      if (!content) continue;
      messages.push({
        role: item.from === 'self' ? 'user' : 'assistant',
        content,
      });
    }
    if (!messages.some((m, index) => index === messages.length - 1 && m.role === 'user' && m.content === latestPrompt)) {
      messages.push({ role: 'user', content: latestPrompt });
    }
    const personality = this._resolveAgentPersonality(peerId);
    const agentConfig = agentEnabled
      ? { ...personality, agentMode: 'agent', agentWorkDir: this._resolveAgentContext(peerId).workDir }
      : personality;
    return [
      {
        role: 'system',
        content: getSystemPromptForAgent(tierId, agentConfig),
      },
      ...messages,
    ];
  }

  _chatRequest(body) {
    return new Promise((resolve, reject) => {
      const safeBody = body && Array.isArray(body.messages)
        ? { ...body, messages: sanitizeMessagesForOllama(body.messages) }
        : (body || {});
      const payload = JSON.stringify(safeBody);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this._runtimePort(),
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 0,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c.toString(); });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              let message = data.trim();
              try {
                const parsed = JSON.parse(data);
                message = parsed?.error || message;
              } catch {
                /* keep raw body */
              }
              reject(new Error(message || `Chat fehlgeschlagen (HTTP ${res.statusCode})`));
              return;
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              reject(new Error('UngÃ¼ltige Ollama-Antwort.'));
            }
          });
        }
      );
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  _chatRequestStream(body, onProgress, requestId, liveSegments = null) {
    return new Promise((resolve, reject) => {
      const safeBody = body && Array.isArray(body.messages)
        ? { ...body, messages: sanitizeMessagesForOllama(body.messages) }
        : (body || {});
      const payload = JSON.stringify({ ...safeBody, stream: true });
      const startedAt = Date.now();
      let estimatedTokens = 0;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this._runtimePort(),
          path: '/api/chat',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 0,
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let data = '';
            res.on('data', (c) => { data += c.toString(); });
            res.on('end', () => {
              if (requestId) this.chatAborters.delete(requestId);
              let message = data.trim();
              try {
                const parsed = JSON.parse(data);
                message = parsed?.error || message;
              } catch {
                /* keep raw body */
              }
              reject(new Error(message || `Chat fehlgeschlagen (HTTP ${res.statusCode})`));
            });
            return;
          }

          let buffer = '';
          let fullThinking = '';
          let fullContent = '';
          let lastToolCalls = [];
          let finalStats = null;
          let settled = false;

          const finish = (response) => {
            if (settled) return;
            settled = true;
            if (requestId) this.chatAborters.delete(requestId);
            resolve(response);
          };

          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let parsed;
              try {
                parsed = JSON.parse(trimmed);
              } catch {
                continue;
              }

              if (parsed.message?.thinking) {
                fullThinking += parsed.message.thinking;
                estimatedTokens += Math.max(1, Math.ceil(String(parsed.message.thinking).length / 4));
              }
              if (parsed.message?.content) {
                fullContent += parsed.message.content;
                estimatedTokens += Math.max(1, Math.ceil(String(parsed.message.content).length / 4));
              }
              if (Array.isArray(parsed.message?.tool_calls)) {
                lastToolCalls = parsed.message.tool_calls;
              }

              const split = splitThinkingText(fullContent);
              if (liveSegments) {
                if (fullThinking.trim()) {
                  upsertStreamThinking(liveSegments, fullThinking);
                }
                if (split.content.trim()) {
                  upsertStreamAnswer(liveSegments, split.content);
                }
              }
              const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
              const finalTps =
                typeof parsed.eval_count === 'number'
                && typeof parsed.eval_duration === 'number'
                && parsed.eval_duration > 0
                  ? parsed.eval_count / (parsed.eval_duration / 1e9)
                  : 0;
              const genTimeMs =
                typeof parsed.eval_duration === 'number' && parsed.eval_duration > 0
                  ? parsed.eval_duration / 1e6
                  : elapsedSeconds * 1000;
              if (parsed.done) {
                finalStats = {
                  tps: finalTps || estimatedTokens / elapsedSeconds,
                  genTimeMs,
                };
              }
              onProgress?.({
                thinking: [fullThinking, split.thinking].filter(Boolean).join('\n\n'),
                content: split.content || fullContent,
                segments: liveSegments,
                tps: finalTps || estimatedTokens / elapsedSeconds,
                genTimeMs,
                done: Boolean(parsed.done),
              });

              if (parsed.done) {
                finish({
                  message: {
                    thinking: fullThinking,
                    content: fullContent,
                    tool_calls: Array.isArray(parsed.message?.tool_calls) && parsed.message.tool_calls.length
                      ? parsed.message.tool_calls
                      : lastToolCalls,
                  },
                  stats: finalStats,
                });
              }
            }
          });

          res.on('end', () => {
            if (settled) return;
            if (fullContent.trim() || fullThinking.trim() || lastToolCalls.length) {
              finish({
                message: {
                  thinking: fullThinking,
                  content: fullContent,
                  tool_calls: lastToolCalls,
                },
                stats: finalStats || {
                  tps: estimatedTokens / Math.max(0.001, (Date.now() - startedAt) / 1000),
                  genTimeMs: Date.now() - startedAt,
                },
              });
              return;
            }
            reject(new Error('Leere Ollama-Antwort.'));
          });
        }
      );
      req.on('error', (error) => {
        if (requestId) this.chatAborters.delete(requestId);
        reject(error);
      });
      if (requestId) {
        this.chatAborters.set(requestId, () => {
          req.destroy(new Error('chat_aborted'));
        });
      }
      req.write(payload);
      req.end();
    });
  }

  async _ensureServerRunning() {
    if (this.serverProcess && !this.serverProcess.killed && this.serverProcessMode === this.runtimeMode) return true;

    const alreadyUp = await this._pingServer();
    if (alreadyUp) {
      this._broadcast({ serverRunning: true });
      return true;
    }

    const bin = await this._runtimeBinaryPath();
    if (!bin) return false;
    if (!this._isSystemRuntime()) {
      await this._prepareModelsDir();
    }

    this.serverProcess = spawn(bin, ['serve'], {
      env: this._runtimeEnv(),
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    this.serverProcessMode = this.runtimeMode;

    this.serverProcess.on('exit', () => {
      this.serverProcess = null;
      this.serverProcessMode = '';
      this._broadcast({ serverRunning: false });
    });

    for (let i = 0; i < 40; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const up = await this._pingServer();
      if (up) {
        this._broadcast({ serverRunning: true });
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
    }

    return false;
  }

  async _stopServer() {
    if (!this.serverProcess) return;
    try {
      this.serverProcess.kill();
    } catch {
      /* ignore */
    }
    this.serverProcess = null;
    this.serverProcessMode = '';
    this._broadcast({ serverRunning: false });
  }

  _pingServer() {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this._runtimePort(),
          path: '/api/tags',
          method: 'GET',
          timeout: 1500,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 300);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  }

  _downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const follow = (targetUrl, redirectsLeft = 5) => {
        if (redirectsLeft <= 0) {
          reject(new Error('Zu viele Weiterleitungen beim Download.'));
          return;
        }

        const lib = targetUrl.startsWith('https') ? https : http;
        const req = lib.get(targetUrl, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirectsLeft - 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download fehlgeschlagen (HTTP ${res.statusCode}).`));
            return;
          }

          const totalBytes = Number(res.headers['content-length'] || 0);
          let downloadedBytes = 0;

          const fileStream = fs.createWriteStream(destPath);
          res.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            const percent = totalBytes > 0
              ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
              : Math.min(99, Math.round(downloadedBytes / (OLLAMA_RUNTIME_DISCLAIMER_BYTES / 100)));
            onProgress?.({ downloadedBytes, totalBytes, percent });
          });

          pipeline(res, fileStream)
            .then(() => {
              onProgress?.({
                downloadedBytes: totalBytes || downloadedBytes,
                totalBytes: totalBytes || downloadedBytes,
                percent: 100,
              });
              resolve();
            })
            .catch(reject);
        });

        req.on('error', reject);
        this.downloadAbort = () => {
          req.destroy(new Error('Download abgebrochen'));
        };
      };

      follow(url);
    });
  }

  async _extractArchive(archivePath, destDir) {
    await fsPromises.mkdir(destDir, { recursive: true });

    if (process.platform === 'win32' && archivePath.endsWith('.zip')) {
      await this._extractZipWindows(archivePath, destDir);
      return;
    }

    if (isArchiveTgz(archivePath)) {
      await this._extractTar(archivePath, destDir);
      return;
    }

    if (archivePath.endsWith('.zip')) {
      await this._extractZipUnix(archivePath, destDir);
      return;
    }

    throw new Error(`Unbekanntes Archivformat: ${path.basename(archivePath)}`);
  }

  _extractZipWindows(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
        ],
        { windowsHide: true }
      );
      let stderr = '';
      ps.stderr.on('data', (d) => { stderr += d.toString(); });
      ps.on('error', reject);
      ps.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `Entpacken fehlgeschlagen (Code ${code})`));
      });
    });
  }

  _extractZipUnix(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      execFile('unzip', ['-o', archivePath, '-d', destDir], (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve();
      });
    });
  }

  _extractTar(archivePath, destDir) {
    return new Promise((resolve, reject) => {
      execFile('tar', ['-xzf', archivePath, '-C', destDir], (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve();
      });
    });
  }

  _pullModel(modelName, onProgress) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ name: modelName, stream: true });
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this._runtimePort(),
          path: '/api/pull',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 0,
        },
        (res) => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            let errBody = '';
            res.on('data', (c) => { errBody += c.toString(); });
            res.on('end', () => {
              reject(new Error(errBody.trim() || `Pull fehlgeschlagen (HTTP ${res.statusCode})`));
            });
            return;
          }

          let buffer = '';
          res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const evt = JSON.parse(line);
                const status = typeof evt.status === 'string' ? evt.status : '';
                if (typeof evt.completed === 'number' && typeof evt.total === 'number' && evt.total > 0) {
                  const downloadedBytes = Math.max(0, Math.min(evt.completed, evt.total));
                  onProgress?.({
                    percent: Math.min(100, Math.round((downloadedBytes / evt.total) * 100)),
                    downloadedBytes,
                    totalBytes: evt.total,
                    status,
                  });
                } else if (status) {
                  onProgress?.({ status });
                }
                if (evt.status === 'success') {
                  onProgress?.({ percent: 100, status: 'success' });
                }
              } catch {
                /* ignore malformed chunk */
              }
            }
          });
          res.on('end', () => resolve());
          res.on('error', reject);
        }
      );

      req.on('error', reject);
      req.write(body);
      req.end();
      this.modelPullAbort = () => req.destroy(new Error('Modell-Download abgebrochen'));
    });
  }

  _apiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this._runtimePort(),
          path: apiPath,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
          timeout: 8000,
        },
        (res) => {
          let data = '';
          res.on('data', (c) => { data += c.toString(); });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              reject(new Error(data.trim() || `API ${method} ${apiPath} → HTTP ${res.statusCode}`));
              return;
            }
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch {
              resolve({});
            }
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  _abortRuntimeDownload() {
    if (this.downloadAbort) {
      try {
        this.downloadAbort();
      } catch {
        /* ignore */
      }
      this.downloadAbort = null;
    }
  }

  _abortModelPull() {
    if (this.modelPullAbort) {
      try {
        this.modelPullAbort();
      } catch {
        /* ignore */
      }
      this.modelPullAbort = null;
    }
  }

  async resetAndDelete() {
    this._abortRuntimeDownload();
    this._abortModelPull();
    for (const abort of this.chatAborters.values()) {
      try {
        abort();
      } catch {
        /* ignore */
      }
    }
    this.chatAborters.clear();

    await this._stopServer();

    const storedMessages = this.store.get('messages', {}) || {};
    if (storedMessages && typeof storedMessages === 'object') {
      for (const peerId of Object.keys(storedMessages)) {
        if (isAiChatPeerId(peerId)) {
          this.store.delete(`messages.${peerId}`);
        }
      }
    }

    this.store.delete('aiChat.agents');
    this.store.delete('aiChat.selectedModelTier');
    this.store.delete('aiChat.setupComplete');
    this.store.delete('aiChat.cloudAuth');
    this.store.delete('aiChat.selectedCloudModelId');
    this.store.delete('aiChat.memory');
    if (this._memoryCache) this._memoryCache.clear();

    try {
      await fsPromises.rm(this.baseDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const canDeleteExternalModelsDir = this.modelsDirSource !== BLUETALK_OLLAMA_MODELS_ENV
      && isBlueTalkManagedModelsDir(this.modelsDir);
    if (!isSameOrInsidePath(this.modelsDir, this.baseDir) && canDeleteExternalModelsDir) {
      try {
        await fsPromises.rm(this.modelsDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    if (!this._isSystemRuntime()) {
      await this._prepareModelsDir().catch(() => {});
    }
    await fsPromises.mkdir(this.runtimeDir, { recursive: true }).catch(() => {});

    this.state = this._emptyState();
    this.onStateChange(this.getState());
    return { ok: true, state: this.getState() };
  }
}

module.exports = { OllamaManager };
