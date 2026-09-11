import React, { useEffect, useRef, useState } from 'react';
import { Bot, X } from 'lucide-react';
import {
  BOT_DEFAULT_NAME,
  BOT_DESCRIPTION_MAX_CHARS,
  resolveBotModel,
} from '../aiChatConstants';
import { SETTINGS_ICON_STROKE } from '../pages/settings/settingsUtils';
import { ModalOverlay } from './ModalOverlay.jsx';
import { BotModelSelect, BotApiFields } from './BotModelSelect.jsx';
import { PeerAvatar } from '../pages/chats/messageHelpers.jsx';

const DEFAULT_FORM = {
  name: BOT_DEFAULT_NAME,
  description: '',
  modelTier: 'cloud',
  cloudModelId: '',
  modelSource: 'openai',
  openaiBaseUrl: '',
  openaiApiKey: '',
  openaiModel: '',
};

export default function CreateAiAgentModal({
  open,
  onClose,
  onCreate,
  creating = false,
  ollamaState = null,
  debugMode = false,
  defaultOpenai = null,
}) {
  const nameRef = useRef(null);
  const [form, setForm] = useState(DEFAULT_FORM);

  useEffect(() => {
    if (!open) return undefined;
    const fallback = resolveBotModel({}, {
      modelTier: 'cloud',
      cloudModelId: ollamaState?.selectedCloudModelId,
    });
    setForm({
      ...DEFAULT_FORM,
      ...fallback,
      modelSource: 'openai',
      openaiBaseUrl: defaultOpenai?.baseUrl || '',
      openaiApiKey: defaultOpenai?.apiKey || '',
      openaiModel: defaultOpenai?.model || '',
    });
    const t = requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
    return () => cancelAnimationFrame(t);
  }, [open, ollamaState?.selectedCloudModelId, defaultOpenai?.baseUrl, defaultOpenai?.apiKey, defaultOpenai?.model]);

  if (!open) return null;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (creating) return;
    onCreate?.({
      name: form.name.trim() || BOT_DEFAULT_NAME,
      description: form.description.trim().slice(0, BOT_DESCRIPTION_MAX_CHARS),
      modelTier: form.modelTier || 'cloud',
      cloudModelId: form.cloudModelId,
      modelSource: form.modelSource || 'openai',
      openaiBaseUrl: form.openaiBaseUrl || '',
      openaiApiKey: form.openaiApiKey || '',
      openaiModel: form.openaiModel || '',
    });
  };

  return (
    <ModalOverlay
      onClick={() => !creating && onClose?.()}
    >
      <div
        className="modal animate-scale create-ai-agent-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-ai-agent-title"
      >
        <div className="create-ai-agent-modal-header">
          <div className="create-ai-agent-modal-title-block">
            <span className="create-ai-agent-modal-icon" aria-hidden>
              <Bot size={20} strokeWidth={SETTINGS_ICON_STROKE} />
            </span>
            <div className="create-ai-agent-modal-title-copy">
              <h3 id="create-ai-agent-title">Bot erstellen</h3>
              <p className="create-ai-agent-modal-lead">
                Name, Beschreibung und eine OpenAI-kompatible API reichen. Der Bot schreibt wie ein Kontakt.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon create-ai-agent-modal-close"
            onClick={() => onClose?.()}
            disabled={creating}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={SETTINGS_ICON_STROKE} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="create-ai-agent-modal-form">
          <div className="create-ai-agent-modal-body">
            <section className="create-ai-agent-section">
              <div className="create-ai-agent-fields">
                <div className="create-ai-agent-avatar-preview">
                  <PeerAvatar
                    pictureUrl=""
                    name={form.name || BOT_DEFAULT_NAME}
                    size={72}
                    className="profile-menu-preview peer-avatar-img--bot"
                  />
                  <p className="text-sm text-muted" style={{ margin: 0 }}>
                    Folgt dem Theme. Eigenes Bild kannst du später im Profil setzen.
                  </p>
                </div>
                <div className="input-group">
                  <label htmlFor="create-ai-agent-name">Name</label>
                  <input
                    ref={nameRef}
                    id="create-ai-agent-name"
                    className="input"
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    maxLength={64}
                    placeholder="z. B. Notizen-Bot"
                    disabled={creating}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="create-ai-agent-description">Beschreibung</label>
                  <textarea
                    id="create-ai-agent-description"
                    className="input create-ai-agent-textarea"
                    rows={4}
                    maxLength={BOT_DESCRIPTION_MAX_CHARS}
                    placeholder="Wer ist dieser Bot, und wie soll er antworten?"
                    value={form.description}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                    disabled={creating}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="create-bot-model">Modell</label>
                  <BotModelSelect
                    id="create-bot-model"
                    ollamaState={ollamaState}
                    debugMode={debugMode}
                    value={form}
                    disabled={creating}
                    onChange={(next) => setForm((prev) => ({ ...prev, ...next }))}
                  />
                </div>
                <BotApiFields
                  idPrefix="create-bot-api"
                  value={form}
                  disabled={creating}
                  onChange={(next) => setForm((prev) => ({ ...prev, ...next }))}
                />
              </div>
            </section>
          </div>

          <div className="modal-actions create-ai-agent-modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onClose?.()}
              disabled={creating}
            >
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              <Bot size={14} strokeWidth={SETTINGS_ICON_STROKE} />
              {creating ? 'Erstelle…' : 'Bot erstellen'}
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  );
}
