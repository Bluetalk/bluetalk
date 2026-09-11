import React from 'react';
import { AI_CLOUD_MODELS, resolveBotModel } from '../aiChatConstants';

/**
 * Modellwahl für Bots: Ollama Cloud oder eine beliebige OpenAI-kompatible API.
 */
export function BotModelSelect({
  ollamaState,
  value,
  onChange,
  disabled = false,
  id = 'bot-model',
}) {
  const fallback = {
    modelTier: ollamaState?.selectedModelTier,
    cloudModelId: ollamaState?.selectedCloudModelId,
  };
  const selected = resolveBotModel(value, fallback);
  const cloudReady = Boolean(ollamaState?.cloudAuth);
  const selectValue = selected.modelSource === 'openai'
    ? 'openai'
    : `cloud:${selected.cloudModelId}`;

  const handleChange = (event) => {
    const next = event.target.value;
    if (next === 'openai') {
      onChange?.({
        modelSource: 'openai',
        modelTier: 'cloud',
        openaiBaseUrl: selected.openaiBaseUrl,
        openaiApiKey: selected.openaiApiKey,
        openaiModel: selected.openaiModel,
      });
      return;
    }
    if (next.startsWith('cloud:')) {
      onChange?.({
        modelSource: 'cloud',
        modelTier: 'cloud',
        cloudModelId: next.slice('cloud:'.length),
      });
    }
  };

  return (
    <select
      id={id}
      className="input"
      value={selectValue}
      onChange={handleChange}
      disabled={disabled}
    >
      <option value="openai">OpenAI-kompatible API</option>
      {cloudReady ? (
        <optgroup label="Ollama Cloud">
          {Object.values(AI_CLOUD_MODELS).map((cloudModel) => (
            <option key={cloudModel.id} value={`cloud:${cloudModel.id}`}>
              {cloudModel.label}
            </option>
          ))}
        </optgroup>
      ) : (
        <option value="cloud:gpt-oss-120b" disabled>
          Ollama Cloud — Anmeldung nötig
        </option>
      )}
    </select>
  );
}

export function BotApiFields({ value, onChange, disabled = false, idPrefix = 'bot-api' }) {
  const selected = resolveBotModel(value, {});
  if (selected.modelSource !== 'openai') return null;
  const patch = (field) => (event) => onChange?.({ [field]: event.target.value });
  return (
    <div className="bot-api-fields">
      <div className="input-group">
        <label htmlFor={`${idPrefix}-url`}>API-URL</label>
        <input
          id={`${idPrefix}-url`}
          className="input"
          value={selected.openaiBaseUrl}
          onChange={patch('openaiBaseUrl')}
          placeholder="https://api.openai.com/v1"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="input-group">
        <label htmlFor={`${idPrefix}-key`}>API-Schlüssel</label>
        <input
          id={`${idPrefix}-key`}
          className="input"
          type="password"
          value={selected.openaiApiKey}
          onChange={patch('openaiApiKey')}
          placeholder="sk-… (optional bei lokalen Servern)"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      <div className="input-group">
        <label htmlFor={`${idPrefix}-model`}>Modell</label>
        <input
          id={`${idPrefix}-model`}
          className="input"
          value={selected.openaiModel}
          onChange={patch('openaiModel')}
          placeholder="gpt-4o, grok-3, llama3.1, …"
          disabled={disabled}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
