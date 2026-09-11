import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Cloud, Download, FolderOpen, RefreshCw, Server, Trash2 } from 'lucide-react';
import SettingsPage from '../../components/settings/SettingsPage';
import CreateAiAgentModal from '../../components/CreateAiAgentModal';
import {
  AI_CHAT_PEER_PREFIX,
  AI_CLOUD_MODELS,
  AI_MODEL_TIERS,
  BOT_DEFAULT_NAME,
  isModelTierVisible,
  OLLAMA_DEFAULT_RUNTIME_MODE,
  OLLAMA_RUNTIME_MODE_BLUETALK,
  OLLAMA_RUNTIME_MODE_SYSTEM,
} from '../../aiChatConstants';
import { formatBytes, SETTINGS_ICON_STROKE } from './settingsUtils';
import { useToast } from '../../components/ToastProvider';
import { useApp } from '../../App';

function modelStatusLabel(status) {
  if (status === 'ready') return 'Bereit';
  if (status === 'downloading') return 'Lädt';
  if (status === 'error') return 'Fehler';
  return 'Nicht geladen';
}

export default function AiSettingsPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { settings } = useApp();
  const debugMode = settings.debugMode ?? false;
  const [state, setState] = useState(null);
  const [paths, setPaths] = useState(null);
  const [busy, setBusy] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [cloudPending, setCloudPending] = useState(false);
  const [openaiGlobal, setOpenaiGlobal] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [agents, setAgents] = useState([]);

  const refresh = useCallback(async () => {
    if (!window.bluetalk?.ollama) return;
    const [nextState, nextPaths, storedOpenai, storedAgents] = await Promise.all([
      window.bluetalk.ollama.getState(),
      window.bluetalk.ollama.getStoragePaths?.(),
      window.bluetalk.store.get('aiChat.openai', {}),
      window.bluetalk.store.get('aiChat.agents', []),
    ]);
    setState(nextState);
    setPaths(nextPaths);
    setAgents(Array.isArray(storedAgents) ? storedAgents : []);
    setOpenaiGlobal({
      baseUrl: typeof storedOpenai?.baseUrl === 'string' ? storedOpenai.baseUrl : '',
      apiKey: typeof storedOpenai?.apiKey === 'string' ? storedOpenai.apiKey : '',
      model: typeof storedOpenai?.model === 'string' ? storedOpenai.model : '',
    });
  }, []);

  useEffect(() => {
    void refresh();
    if (!window.bluetalk?.on) return undefined;
    const off = window.bluetalk.on('ollama:state', (nextState) => setState(nextState));
    return () => off?.();
  }, [refresh]);

  const run = async (name, fn) => {
    if (busy) return;
    setBusy(name);
    try {
      const result = await fn();
      if (result?.ok === false) {
        toast({ variant: 'error', title: 'Aktion fehlgeschlagen', message: result.error || 'Unbekannter Fehler.' });
      }
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const setupComplete = Boolean(state?.setupComplete);
  const runtimeMode = state?.runtimeMode || paths?.runtimeMode || OLLAMA_DEFAULT_RUNTIME_MODE;

  const switchRuntimeMode = async (mode) => {
    await run(`runtime-mode-${mode}`, async () => {
      const result = await window.bluetalk.ollama.selectRuntimeMode(mode);
      if (result?.ok !== false) {
        toast({
          variant: 'success',
          title: mode === OLLAMA_RUNTIME_MODE_BLUETALK ? 'BlueTalk-Ollama aktiv' : 'Eigener Ollama aktiv',
          message: 'Bots nutzen jetzt diesen Ollama-Modus.',
        });
      }
      return result;
    });
  };

  const createAiAgent = async ({
    name,
    description,
    modelTier,
    cloudModelId,
    modelSource,
    openaiBaseUrl,
    openaiApiKey,
    openaiModel,
  }) => {
    if (!window.bluetalk?.store || creatingAgent) return;
    setCreatingAgent(true);
    try {
      const stored = await window.bluetalk.store.get('aiChat.agents', []);
      const agents = Array.isArray(stored) ? stored : [];
      const id = `${AI_CHAT_PEER_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const cleanName = name.trim() || `${BOT_DEFAULT_NAME} ${agents.length + 1}`;
      await window.bluetalk.store.set('aiChat.agents', [
        ...agents,
        {
          id,
          name: cleanName,
          description: description || '',
          modelTier: modelTier || 'cloud',
          cloudModelId: cloudModelId || state?.selectedCloudModelId || '',
          modelSource: modelSource || 'openai',
          openaiBaseUrl: openaiBaseUrl || openaiGlobal.baseUrl || '',
          openaiApiKey: openaiApiKey || openaiGlobal.apiKey || '',
          openaiModel: openaiModel || openaiGlobal.model || '',
          createdAt: Date.now(),
        },
      ]);
      setShowCreateModal(false);
      navigate('/', { state: { openPeerId: id } });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Bot konnte nicht erstellt werden',
        message: err?.message || 'Unbekannter Fehler.',
      });
    } finally {
      setCreatingAgent(false);
    }
  };

  const saveOpenaiGlobal = async () => {
    if (!window.bluetalk?.store) return;
    await window.bluetalk.store.set('aiChat.openai', {
      baseUrl: openaiGlobal.baseUrl.trim(),
      apiKey: openaiGlobal.apiKey,
      model: openaiGlobal.model.trim(),
    });
    toast({ variant: 'success', title: 'API gespeichert', message: 'Neue Bots nutzen diese Vorgabe, wenn sie keine eigene URL haben.' });
  };

  const useLocalModel = async (tierId) => {
    if (busy) return;
    setBusy(`local-${tierId}`);
    try {
      const result = await window.bluetalk.ollama.selectModelTier(tierId);
      if (result?.ok === false) {
        toast({
          variant: 'error',
          title: 'Modellwechsel fehlgeschlagen',
          message: result.error || 'Das Modell konnte nicht aktiviert werden.',
        });
      } else {
        toast({ variant: 'success', title: 'Standardmodell', message: 'Neue Bots ohne eigenes Modell nutzen dieses Modell.' });
      }
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const useCloudModel = async (cloudModelId) => {
    if (busy) return;
    setBusy(`cloud-${cloudModelId}`);
    try {
      const cloudResult = await window.bluetalk.ollama.selectCloudModel(cloudModelId);
      if (cloudResult?.ok === false) {
        toast({
          variant: 'error',
          title: 'Cloud-Modell fehlgeschlagen',
          message: cloudResult.error || 'Das Cloud-Modell konnte nicht gewählt werden.',
        });
        await refresh();
        return;
      }
      const tierResult = await window.bluetalk.ollama.selectModelTier('cloud');
      if (tierResult?.ok === false) {
        toast({
          variant: 'error',
          title: 'Cloud aktivieren fehlgeschlagen',
          message: tierResult.error === 'cloud_auth_required'
            ? 'Melde dich zuerst bei Ollama an.'
            : (tierResult.error || 'Cloud konnte nicht aktiviert werden.'),
        });
      } else {
        toast({ variant: 'success', title: 'Standardmodell', message: 'Neue Bots ohne eigenes Modell nutzen dieses Cloud-Modell.' });
      }
      await refresh();
    } finally {
      setBusy('');
    }
  };

  return (
    <SettingsPage title="Bots">
        <section className="settings-section">
          <div className="card bots-hero">
            <div className="bots-hero-copy">
              <h3>Deine Bots</h3>
              <p>Name, Beschreibung und API reichen. Der Bot erscheint danach in der Chatliste.</p>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setShowCreateModal(true)}
              disabled={creatingAgent}
            >
              <Bot size={14} strokeWidth={SETTINGS_ICON_STROKE} />
              Bot erstellen
            </button>
          </div>
          {agents.length > 0 ? (
            <div className="bots-agent-list">
              {agents.map((agent) => (
                <div className="card bots-agent-row" key={agent.id}>
                  <div className="min-w-0">
                    <div className="font-medium">{agent.name || 'Bot'}</div>
                    <div className="text-sm text-muted">
                      {agent.description || agent.openaiModel || agent.cloudModelId || 'Kein Modell hinterlegt'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => navigate('/', { state: { openPeerId: agent.id } })}
                  >
                    Öffnen
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted bots-empty">Noch keine Bots. Erstelle den ersten mit dem Button oben.</p>
          )}
        </section>

        <CreateAiAgentModal
          open={showCreateModal}
          onClose={() => setShowCreateModal(false)}
          onCreate={createAiAgent}
          creating={creatingAgent}
          ollamaState={state}
          debugMode={debugMode}
          defaultOpenai={openaiGlobal}
        />

        <section className="settings-section">
          <h3 className="settings-section-title">API-Vorgabe</h3>
          <div className="card">
            <p className="text-sm text-muted" style={{ marginTop: 0 }}>
              OpenAI-kompatible APIs: OpenAI, Groq, OpenRouter, LM Studio, vLLM. Neue Bots nutzen diese Werte, wenn sie keine eigene URL haben.
            </p>
            <div className="input-group">
              <label htmlFor="openai-global-url">API-URL</label>
              <input
                id="openai-global-url"
                className="input"
                value={openaiGlobal.baseUrl}
                onChange={(e) => setOpenaiGlobal((prev) => ({ ...prev, baseUrl: e.target.value }))}
                placeholder="https://api.openai.com/v1"
                autoComplete="off"
              />
            </div>
            <div className="input-group">
              <label htmlFor="openai-global-key">API-Schlüssel</label>
              <input
                id="openai-global-key"
                className="input"
                type="password"
                value={openaiGlobal.apiKey}
                onChange={(e) => setOpenaiGlobal((prev) => ({ ...prev, apiKey: e.target.value }))}
                placeholder="sk-… (optional bei lokalen Servern)"
                autoComplete="off"
              />
            </div>
            <div className="input-group">
              <label htmlFor="openai-global-model">Standard-Modell</label>
              <input
                id="openai-global-model"
                className="input"
                value={openaiGlobal.model}
                onChange={(e) => setOpenaiGlobal((prev) => ({ ...prev, model: e.target.value }))}
                placeholder="gpt-4o"
                autoComplete="off"
              />
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveOpenaiGlobal()}>
              Vorgabe speichern
            </button>
          </div>
        </section>

        {debugMode ? <section className="settings-section">
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Ollama Runtime</span>
                <span>{state?.runtimeStatus === 'ready' ? 'Installiert' : 'Noch nicht installiert'}</span>
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()}>
                <RefreshCw size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                Aktualisieren
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Ollama-Modus</span>
                <span>
                  {runtimeMode === OLLAMA_RUNTIME_MODE_SYSTEM
                    ? `Eigener Ollama auf Port ${paths?.serverPort || 11434}`
                    : `BlueTalk-Ollama auf Port ${paths?.serverPort || 32114}`}
                </span>
              </div>
              <div className="ai-settings-runtime-actions">
                <button
                  type="button"
                  className={`btn btn-sm ${runtimeMode === OLLAMA_RUNTIME_MODE_BLUETALK ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => void switchRuntimeMode(OLLAMA_RUNTIME_MODE_BLUETALK)}
                  disabled={Boolean(busy) || runtimeMode === OLLAMA_RUNTIME_MODE_BLUETALK}
                >
                  <Bot size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                  BlueTalk
                </button>
                <button
                  type="button"
                  className={`btn btn-sm ${runtimeMode === OLLAMA_RUNTIME_MODE_SYSTEM ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => void switchRuntimeMode(OLLAMA_RUNTIME_MODE_SYSTEM)}
                  disabled={Boolean(busy) || runtimeMode === OLLAMA_RUNTIME_MODE_SYSTEM}
                >
                  <Server size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                  Eigener
                </button>
              </div>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Modellordner</span>
                <span className="font-mono">{paths?.modelsDir || 'Noch nicht angelegt'}</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => run('open-dir', () => window.bluetalk.ollama.openModelsDir())}
                disabled={Boolean(busy)}
              >
                <FolderOpen size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                Öffnen
              </button>
            </div>
          </div>
        </section> : null}

        {debugMode ? <section className="settings-section">
          <h3 className="settings-section-title">Lokale Modelle</h3>
          <div className="ai-settings-model-list">
            {Object.values(AI_MODEL_TIERS).filter((tier) => tier.local && isModelTierVisible(tier, debugMode)).map((tier) => {
              const status = state?.modelStatus?.[tier.id] || 'missing';
              const isReady = status === 'ready';
              const isActive = state?.selectedModelTier === tier.id;
              const isDownloading = status === 'downloading' || busy === `download-${tier.id}`;
              return (
                <div className="card ai-settings-model-row" key={tier.id}>
                  <div className="min-w-0">
                    <div className="font-medium">
                      {tier.label}
                      {tier.beta ? <span className="badge badge-muted" style={{ marginLeft: 8 }}>Beta</span> : null}
                    </div>
                    <div className="text-sm text-muted">{tier.model} · ca. {formatBytes(tier.estimatedSizeBytes)}</div>
                    <div className={`badge ${isActive ? 'badge-success' : isReady ? 'badge-success' : status === 'error' ? 'badge-danger' : isDownloading ? 'badge-blue' : 'badge-muted'}`}>
                      {isActive ? 'Standard' : isReady ? 'Bereit' : modelStatusLabel(isDownloading ? 'downloading' : status)}
                    </div>
                  </div>
                  <div className="ai-settings-model-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void useLocalModel(tier.id)}
                      disabled={Boolean(busy) || !isReady || isActive}
                    >
                      Verwenden
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => run(`download-${tier.id}`, () => window.bluetalk.ollama.downloadModel(tier.id))}
                      disabled={Boolean(busy) || state?.runtimeStatus !== 'ready' || isReady}
                    >
                      <Download size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                      Laden
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => run(`delete-${tier.id}`, () => window.bluetalk.ollama.deleteModel(tier.id))}
                      disabled={Boolean(busy) || !isReady}
                    >
                      <Trash2 size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                      Entfernen
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section> : null}

        <section className="settings-section">
          <h3 className="settings-section-title">Ollama Cloud</h3>
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Anmeldung</span>
                <span>{state?.cloudAuth ? 'Angemeldet — Cloud-Modelle verfügbar' : 'Noch nicht angemeldet'}</span>
              </div>
              {!state?.cloudAuth ? (
                <div className="flex gap-2 flex-wrap">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      setCloudPending(true);
                      void run('cloud-signin', () => window.bluetalk.ollama.startCloudSignIn());
                    }}
                  >
                    <Cloud size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                    Bei Ollama anmelden
                  </button>
                  {cloudPending ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        setCloudPending(false);
                        void run('cloud-confirm', () => window.bluetalk.ollama.confirmCloudAuth());
                      }}
                    >
                      Anmeldung abgeschlossen
                    </button>
                  ) : null}
                </div>
              ) : (
                <span className="badge badge-success">Bereit</span>
              )}
            </div>
          </div>

          {state?.cloudAuth ? (
            <div className="ai-settings-model-list">
              {Object.values(AI_CLOUD_MODELS).map((cloudModel) => {
                const isActive = state?.selectedModelTier === 'cloud'
                  && state?.selectedCloudModelId === cloudModel.id;
                return (
                  <div className="card ai-settings-model-row" key={cloudModel.id}>
                    <div className="min-w-0">
                      <div className="font-medium">{cloudModel.label}</div>
                      <div className="text-sm text-muted">{cloudModel.description}</div>
                      <div className="text-sm text-muted font-mono">{cloudModel.model}</div>
                      <div className={`badge ${isActive ? 'badge-success' : 'badge-muted'}`}>
                        {isActive ? 'Standard' : 'Verfügbar'}
                      </div>
                    </div>
                    <div className="ai-settings-model-actions">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void useCloudModel(cloudModel.id)}
                        disabled={Boolean(busy) || isActive}
                      >
                        Verwenden
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted">
              Melde dich bei Ollama an, um Cloud-Modelle zu nutzen. Danach kannst du das Modell hier oder direkt beim Bot wählen.
            </p>
          )}
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Zurücksetzen</h3>
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>AI zurücksetzen und löschen</span>
                <span>
                  Entfernt alle Bots und Chatverläufe, löscht heruntergeladene Modelle und die
                  Ollama-Laufzeit. Das Setup muss danach erneut durchlaufen werden.
                </span>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                disabled={Boolean(busy)}
                onClick={() => {
                  const ok = window.confirm(
                    'Alle KI-Daten unwiderruflich löschen?\n\n'
                    + 'Dazu gehören Bot-Chats, heruntergeladene Modelle und die Ollama-Laufzeit.'
                  );
                  if (!ok) return;
                  void run('reset-ai', async () => {
                    const result = await window.bluetalk.ollama.resetAndDelete();
                    if (result?.ok !== false) {
                      toast({
                        variant: 'success',
                        title: 'KI zurückgesetzt',
                        message: 'Alle KI-Daten wurden entfernt. Du kannst das Setup erneut starten.',
                      });
                    }
                    return result;
                  });
                }}
              >
                <Trash2 size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                {busy === 'reset-ai' ? 'Wird gelöscht…' : 'Zurücksetzen & löschen'}
              </button>
            </div>
          </div>
        </section>
    </SettingsPage>
  );
}
