import React, { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Cloud,
  Download,
  Gauge,
  Loader2,
  Sparkles,
  Zap,
} from 'lucide-react';
import { AI_CLOUD_DEFAULT_MODEL_ID, AI_CLOUD_MODELS, AI_MODEL_TIERS, OLLAMA_RUNTIME_DISCLAIMER_BYTES } from '../aiChatConstants';
import { formatBytes } from '../pages/settings/settingsUtils';

const TIER_ICONS = {
  fast: Zap,
  normal: Gauge,
  'normal+': Gauge,
  smart: Sparkles,
  cloud: Cloud,
};

function ProgressBlock({ label, percent, downloadedBytes, totalBytes, busy }) {
  const safePercent = Math.max(0, Math.min(100, percent || 0));
  return (
    <div className="ai-setup-progress">
      <div className="ai-setup-progress-head">
        <span>{label}</span>
        <span>{busy ? `${safePercent}%` : '100%'}</span>
      </div>
      <div className="updater-progress-bar" role="progressbar" aria-valuenow={safePercent} aria-valuemin={0} aria-valuemax={100}>
        <div className="updater-progress-fill" style={{ width: `${safePercent}%` }} />
      </div>
      {totalBytes > 0 && (
        <div className="text-sm text-muted ai-setup-progress-meta">
          {formatBytes(downloadedBytes)} / {formatBytes(totalBytes)}
        </div>
      )}
    </div>
  );
}

export default function AiChatSetup({ ollamaState, onRefresh, embedded = false }) {
  const [step, setStep] = useState(1);
  const [selectedTier, setSelectedTier] = useState('');
  const [selectedCloudModel, setSelectedCloudModel] = useState(AI_CLOUD_DEFAULT_MODEL_ID);
  const [action, setAction] = useState('');
  const [cloudPending, setCloudPending] = useState(false);

  const runtimeReady = ollamaState?.runtimeStatus === 'ready';
  const runtimeBusy = ollamaState?.runtimeStatus === 'downloading';
  const setupComplete = Boolean(ollamaState?.setupComplete);

  useEffect(() => {
    if (!ollamaState) return;
    if (ollamaState.selectedModelTier) {
      setSelectedTier(ollamaState.selectedModelTier);
    }
    if (ollamaState.selectedCloudModelId) {
      setSelectedCloudModel(ollamaState.selectedCloudModelId);
    }
    if (ollamaState.runtimeStatus === 'ready' && step === 1) {
      setStep(2);
    }
    if (setupComplete) {
      setStep(3);
    }
  }, [ollamaState, setupComplete, step]);

  const runAction = useCallback(async (name, fn) => {
    if (action) return null;
    setAction(name);
    try {
      return await fn();
    } finally {
      setAction('');
    }
  }, [action]);

  const downloadRuntime = () => runAction('runtime', async () => {
    await window.bluetalk.ollama.downloadRuntime();
    setStep(2);
  });

  const downloadModel = (tierId) => runAction(`model-${tierId}`, async () => {
    await window.bluetalk.ollama.selectModelTier(tierId);
    const result = await window.bluetalk.ollama.downloadModel(tierId);
    if (result?.ok) {
      setSelectedTier(tierId);
      onRefresh?.();
    }
    return result;
  });

  const finishSetup = () => runAction('finish', async () => {
    if (!selectedTier) return;
    if (selectedTier === 'cloud') {
      await window.bluetalk.ollama.selectCloudModel(selectedCloudModel);
    }
    await window.bluetalk.ollama.selectModelTier(selectedTier);
    const tier = AI_MODEL_TIERS[selectedTier];
    if (tier?.local && ollamaState?.modelStatus?.[selectedTier] !== 'ready') {
      await window.bluetalk.ollama.downloadModel(selectedTier);
    }
    onRefresh?.();
  });

  const startCloudSignIn = () => runAction('cloud-signin', async () => {
    setCloudPending(true);
    await window.bluetalk.ollama.startCloudSignIn();
  });

  const confirmCloudAuth = () => runAction('cloud-confirm', async () => {
    await window.bluetalk.ollama.confirmCloudAuth();
    setSelectedTier('cloud');
    setSelectedCloudModel(ollamaState?.selectedCloudModelId || AI_CLOUD_DEFAULT_MODEL_ID);
    setCloudPending(false);
    onRefresh?.();
  });

  if (setupComplete) {
    return (
      <div className="ai-setup-complete animate-fade">
        <Bot size={40} strokeWidth={1.5} aria-hidden />
        <h3>KI-Chat bereit</h3>
        <p className="text-muted">
          Modell: {selectedTier === 'cloud'
            ? (AI_CLOUD_MODELS[ollamaState.selectedCloudModelId]?.label || AI_CLOUD_MODELS[selectedCloudModel]?.label || 'Cloud')
            : (AI_MODEL_TIERS[ollamaState.selectedModelTier]?.label || ollamaState.activeModel)}
        </p>
      </div>
    );
  }

  return (
    <div className={`ai-chat-setup${embedded ? ' ai-chat-setup--embedded' : ''}`}>
      {!embedded && (
        <div className="ai-setup-header">
          <div className="ai-setup-icon-wrap">
            <Bot size={28} strokeWidth={1.75} aria-hidden />
          </div>
          <div>
            <h2>KI-Chat einrichten</h2>
            <p className="text-sm text-muted">Lokale KI über Ollama — deine Nachrichten bleiben auf dem Gerät.</p>
          </div>
        </div>
      )}

      {step === 1 && (
        <section className="ai-setup-panel animate-fade">
          <h3>Ollama installieren</h3>
          <p>
            BlueTalk lädt die Ollama-Laufzeit in einen eigenen Ordner unter deinem Benutzerprofil.
            Beim ersten Mal sind das etwa <strong>{formatBytes(OLLAMA_RUNTIME_DISCLAIMER_BYTES)}</strong> Download.
          </p>
          <div className="ai-setup-disclaimer card">
            <Download size={18} strokeWidth={1.75} aria-hidden />
            <div>
              <strong>Download-Hinweis</strong>
              <p className="text-sm text-muted" style={{ margin: 0 }}>
                Es werden ca. {formatBytes(OLLAMA_RUNTIME_DISCLAIMER_BYTES)} heruntergeladen.
                Stelle eine stabile Internetverbindung sicher. Der Vorgang kann einige Minuten dauern.
              </p>
            </div>
          </div>

          {ollamaState?.runtimeStatus === 'error' && (
            <div className="ai-setup-error">{ollamaState.runtimeError}</div>
          )}

          {runtimeBusy && (
            <ProgressBlock
              label="Ollama wird heruntergeladen…"
              percent={ollamaState.runtimePercent}
              downloadedBytes={ollamaState.runtimeDownloadedBytes}
              totalBytes={ollamaState.runtimeTotalBytes}
              busy
            />
          )}

          <div className="ai-setup-actions">
            {!runtimeReady && !runtimeBusy && (
              <button type="button" className="btn btn-primary" onClick={downloadRuntime} disabled={Boolean(action)}>
                {action === 'runtime' ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                Ollama herunterladen
              </button>
            )}
            {runtimeReady && (
              <button type="button" className="btn btn-primary" onClick={() => setStep(2)}>
                Weiter zur Modellauswahl
              </button>
            )}
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="ai-setup-panel animate-fade">
          <h3>Modell wählen</h3>
          <p className="text-sm text-muted">
            Jedes Modell wird separat in den BlueTalk-Modellordner geladen
            (<code>OLLAMA_MODELS</code>).
          </p>

          <div className="ai-model-tier-grid">
            {Object.values(AI_MODEL_TIERS).map((tier) => {
              const Icon = TIER_ICONS[tier.id] || Sparkles;
              const status = ollamaState?.modelStatus?.[tier.id] || 'missing';
              const isSelected = selectedTier === tier.id;
              const isCloud = tier.id === 'cloud';
              const cloudLocked = isCloud && !ollamaState?.cloudAuth;
              const tierBusy = ollamaState?.modelStatus?.[tier.id] === 'downloading' || action === `model-${tier.id}`;

              return (
                <button
                  key={tier.id}
                  type="button"
                  className={`ai-model-tier card${isSelected ? ' ai-model-tier--selected' : ''}${status === 'ready' ? ' ai-model-tier--ready' : ''}`}
                  onClick={() => setSelectedTier(tier.id)}
                >
                  <div className="ai-model-tier-head">
                    <Icon size={20} strokeWidth={1.75} aria-hidden />
                    <span className="ai-model-tier-label">{tier.label}</span>
                    {status === 'ready' && <span className="badge badge-success">Bereit</span>}
                    {tierBusy && <span className="badge badge-blue">Lädt…</span>}
                    {isCloud && cloudLocked && <span className="badge badge-muted">Anmeldung</span>}
                  </div>
                  <p className="text-sm text-muted">{tier.description}</p>
                  <div className="ai-model-tier-meta text-sm text-muted">
                    {tier.local ? (
                      <>~{formatBytes(tier.estimatedSizeBytes)} · {tier.model}</>
                    ) : (
                      <>Cloud · {tier.model}</>
                    )}
                  </div>
                  {tierBusy && (
                    <ProgressBlock
                      label="Modell wird geladen…"
                      percent={ollamaState?.modelPercent?.[tier.id]}
                      downloadedBytes={0}
                      totalBytes={tier.estimatedSizeBytes}
                      busy
                    />
                  )}
                  {ollamaState?.modelError?.[tier.id] && (
                    <div className="ai-setup-error">{ollamaState.modelError[tier.id]}</div>
                  )}
                </button>
              );
            })}
          </div>

          {selectedTier === 'cloud' && ollamaState?.cloudAuth && (
            <div className="ai-setup-cloud-models">
              <h4 className="text-sm font-medium" style={{ margin: '0 0 8px' }}>Cloud-Modell wählen</h4>
              <div className="ai-model-tier-grid">
                {Object.values(AI_CLOUD_MODELS).map((cloudModel) => {
                  const isSelected = selectedCloudModel === cloudModel.id;
                  return (
                    <button
                      key={cloudModel.id}
                      type="button"
                      className={`ai-model-tier card${isSelected ? ' ai-model-tier--selected' : ''}`}
                      onClick={() => setSelectedCloudModel(cloudModel.id)}
                    >
                      <div className="ai-model-tier-head">
                        <Cloud size={20} strokeWidth={1.75} aria-hidden />
                        <span className="ai-model-tier-label">{cloudModel.label}</span>
                      </div>
                      <p className="text-sm text-muted">{cloudModel.description}</p>
                      <div className="ai-model-tier-meta text-sm text-muted font-mono">{cloudModel.model}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {selectedTier === 'cloud' && !ollamaState?.cloudAuth && (
            <div className="ai-setup-cloud-auth card">
              <Cloud size={18} strokeWidth={1.75} aria-hidden />
              <div>
                <strong>Ollama Cloud</strong>
                <p className="text-sm text-muted">
                  Melde dich bei Ollama an, um große Cloud-Modelle zu nutzen. Es öffnet sich dein Browser.
                </p>
                <div className="ai-setup-actions" style={{ marginTop: 10 }}>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={startCloudSignIn} disabled={Boolean(action)}>
                    Bei Ollama anmelden
                  </button>
                  {cloudPending && (
                    <button type="button" className="btn btn-primary btn-sm" onClick={confirmCloudAuth} disabled={Boolean(action)}>
                      Anmeldung abgeschlossen
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="ai-setup-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
              Zurück
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!selectedTier || Boolean(action)}
              onClick={() => {
                if (!selectedTier) return;
                const tier = AI_MODEL_TIERS[selectedTier];
                if (tier?.local && ollamaState?.modelStatus?.[selectedTier] !== 'ready') {
                  setStep(3);
                } else if (selectedTier === 'cloud' && !ollamaState?.cloudAuth) {
                  startCloudSignIn();
                } else {
                  finishSetup();
                }
              }}
            >
              Weiter
            </button>
          </div>
        </section>
      )}

      {step === 3 && selectedTier && AI_MODEL_TIERS[selectedTier]?.local && (
        <section className="ai-setup-panel animate-fade">
          <h3>Modell herunterladen</h3>
          <p>
            <strong>{AI_MODEL_TIERS[selectedTier].label}</strong> ({AI_MODEL_TIERS[selectedTier].model})
            wird in den BlueTalk-Modellordner geladen.
          </p>

          {ollamaState?.modelStatus?.[selectedTier] === 'ready' ? (
            <div className="ai-setup-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>
                Zurück
              </button>
              <button type="button" className="btn btn-primary" onClick={finishSetup} disabled={Boolean(action)}>
                Einrichtung abschließen
              </button>
            </div>
          ) : (
            <>
              {(ollamaState?.modelStatus?.[selectedTier] === 'downloading' || action === `model-${selectedTier}`) && (
                <ProgressBlock
                  label="Modell wird heruntergeladen…"
                  percent={ollamaState?.modelPercent?.[selectedTier]}
                  downloadedBytes={0}
                  totalBytes={AI_MODEL_TIERS[selectedTier].estimatedSizeBytes}
                  busy
                />
              )}
              <div className="ai-setup-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setStep(2)}>
                  Zurück
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => downloadModel(selectedTier)}
                  disabled={Boolean(action) || ollamaState?.modelStatus?.[selectedTier] === 'downloading'}
                >
                  {action === `model-${selectedTier}` ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
                  Modell herunterladen (~{formatBytes(AI_MODEL_TIERS[selectedTier].estimatedSizeBytes)})
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
