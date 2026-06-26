import React, { useEffect, useRef, useState } from 'react';
import { Bot, FolderOpen, Wrench, X } from 'lucide-react';
import {
  AI_AGENT_DEFAULT_MODE_ID,
  AI_AGENT_MODES,
  AI_PERSONALITY_CUSTOM_MAX_CHARS,
  AI_PERSONALITY_DEFAULT_ID,
  AI_PERSONALITY_PRESETS,
  AI_THINKING_DEFAULT_MODE_ID,
  AI_THINKING_MODES,
  isValidAgentMode,
  isValidThinkingMode,
} from '../aiChatConstants';
import { SETTINGS_ICON_STROKE } from '../pages/settings/settingsUtils';

const DEFAULT_FORM = {
  name: 'KI-Assistent',
  personality: AI_PERSONALITY_DEFAULT_ID,
  personalityCustom: '',
  agentMode: AI_AGENT_DEFAULT_MODE_ID,
  agentWorkDir: '',
  thinkingMode: AI_THINKING_DEFAULT_MODE_ID,
  allowBluetalkMessaging: false,
};

export default function CreateAiAgentModal({ open, onClose, onCreate, creating = false }) {
  const nameRef = useRef(null);
  const [form, setForm] = useState(DEFAULT_FORM);

  useEffect(() => {
    if (!open) return undefined;
    setForm(DEFAULT_FORM);
    const t = requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  if (!open) return null;

  const handleSubmit = (event) => {
    event.preventDefault();
    if (creating) return;
    const mode = isValidAgentMode(form.agentMode) ? form.agentMode : AI_AGENT_DEFAULT_MODE_ID;
    onCreate?.({
      name: form.name.trim() || 'KI-Assistent',
      personality: form.personality,
      personalityCustom: form.personalityCustom.trim().slice(0, AI_PERSONALITY_CUSTOM_MAX_CHARS),
      agentMode: mode,
      agentWorkDir: form.agentWorkDir.trim(),
      thinkingMode: isValidThinkingMode(form.thinkingMode) ? form.thinkingMode : AI_THINKING_DEFAULT_MODE_ID,
      allowBluetalkMessaging: Boolean(form.allowBluetalkMessaging),
    });
  };

  const pickWorkDir = async () => {
    if (creating) return;
    const picked = await window.bluetalk?.agent?.pickFolder?.();
    if (typeof picked === 'string' && picked) {
      setForm((prev) => ({ ...prev, agentWorkDir: picked }));
    }
  };

  const agentMode = isValidAgentMode(form.agentMode) ? form.agentMode : AI_AGENT_DEFAULT_MODE_ID;
  const isAgent = agentMode !== 'off';
  const thinkingMode = isValidThinkingMode(form.thinkingMode)
    ? form.thinkingMode
    : AI_THINKING_DEFAULT_MODE_ID;

  return (
    <div
      className="modal-overlay"
      onClick={() => !creating && onClose?.()}
      role="presentation"
    >
      <div
        className="modal animate-scale create-ai-agent-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-ai-agent-title"
      >
        <div className="create-ai-agent-modal-header">
          <h3 id="create-ai-agent-title" style={{ margin: 0 }}>
            {isAgent ? 'KI-Agent erstellen' : 'KI-Assistent erstellen'}
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => onClose?.()}
            disabled={creating}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={SETTINGS_ICON_STROKE} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="create-ai-agent-modal-body">
          <p className="text-sm text-muted" style={{ margin: '0 0 16px' }}>
            Erstelle einen lokalen KI-Assistenten in deiner Chatliste.
          </p>

          <div className="input-group">
            <label htmlFor="create-ai-agent-name">Name</label>
            <input
              ref={nameRef}
              id="create-ai-agent-name"
              className="input"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              maxLength={64}
              placeholder="Agent-Name"
              disabled={creating}
            />
          </div>

          <div className="input-group">
            <span className="input-group-label">Modus</span>
            <div className="ai-personality-grid" role="radiogroup" aria-label="Modus">
              {Object.values(AI_AGENT_MODES).map((mode) => {
                const selected = agentMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={`ai-personality-option${selected ? ' ai-personality-option--selected' : ''}`}
                    onClick={() => setForm((prev) => ({ ...prev, agentMode: mode.id }))}
                    role="radio"
                    aria-checked={selected}
                    disabled={creating}
                  >
                    <span className="ai-personality-option-label">
                      {mode.id === 'agent' ? <Wrench size={13} strokeWidth={SETTINGS_ICON_STROKE} /> : null}
                      {' '}
                      {mode.label}
                    </span>
                    <span className="ai-personality-option-desc">{mode.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {isAgent ? (
            <div className="input-group">
              <label htmlFor="create-ai-agent-workdir">Arbeitsverzeichnis (optional)</label>
              <div className="agent-workdir-row">
                <input
                  id="create-ai-agent-workdir"
                  className="input"
                  value={form.agentWorkDir}
                  onChange={(e) => setForm((prev) => ({ ...prev, agentWorkDir: e.target.value }))}
                  placeholder="Standard: Desktop-Ordner des Nutzers"
                  disabled={creating}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={pickWorkDir}
                  disabled={creating}
                  aria-label="Ordner wählen"
                >
                  <FolderOpen size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                </button>
              </div>
              <span className="text-sm text-muted">
                Der Agent liest und schreibt Dateien und führt Befehle in diesem Ordner aus.
              </span>
            </div>
          ) : null}

          {isAgent ? (
            <label className="agent-permission-toggle">
              <input
                type="checkbox"
                checked={Boolean(form.allowBluetalkMessaging)}
                onChange={(e) => setForm((prev) => ({ ...prev, allowBluetalkMessaging: e.target.checked }))}
                disabled={creating}
              />
              <span>
                BlueTalk-Nutzung erlauben
                <span className="text-sm text-muted" style={{ display: 'block', marginTop: 4 }}>
                  Der Agent kann Kontakte und Chats einsehen, Nachrichten lesen/senden, Peers verbinden und Plugins nutzen — sensible Aktionen nur nach deiner Bestätigung.
                </span>
              </span>
            </label>
          ) : null}

          <div className="input-group">
            <span className="input-group-label">Thinking-Modus</span>
            <div className="ai-personality-grid" role="radiogroup" aria-label="Thinking-Modus">
              {Object.values(AI_THINKING_MODES).map((mode) => {
                const selected = thinkingMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    className={`ai-personality-option${selected ? ' ai-personality-option--selected' : ''}`}
                    onClick={() => setForm((prev) => ({ ...prev, thinkingMode: mode.id }))}
                    role="radio"
                    aria-checked={selected}
                    disabled={creating}
                  >
                    <span className="ai-personality-option-label">{mode.label}</span>
                    <span className="ai-personality-option-desc">{mode.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="input-group">
            <span className="input-group-label">Persönlichkeit</span>
            <div className="ai-personality-grid" role="radiogroup" aria-label="Persönlichkeit">
              {Object.values(AI_PERSONALITY_PRESETS).map((preset) => {
                const selected = form.personality === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`ai-personality-option${selected ? ' ai-personality-option--selected' : ''}`}
                    onClick={() => setForm((prev) => ({ ...prev, personality: preset.id }))}
                    role="radio"
                    aria-checked={selected}
                    disabled={creating}
                  >
                    <span className="ai-personality-option-label">{preset.label}</span>
                    <span className="ai-personality-option-desc">{preset.description}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="input-group">
            <label htmlFor="create-ai-agent-custom">Eigene Anweisungen (optional)</label>
            <textarea
              id="create-ai-agent-custom"
              className="input profile-menu-bio"
              rows={3}
              maxLength={AI_PERSONALITY_CUSTOM_MAX_CHARS}
              placeholder="z. B. „Antworte immer mit einem Witz am Ende.“"
              value={form.personalityCustom}
              onChange={(e) => setForm((prev) => ({ ...prev, personalityCustom: e.target.value }))}
              disabled={creating}
            />
          </div>

          <div className="modal-actions">
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
              {creating ? 'Erstelle…' : isAgent ? 'Agent erstellen' : 'Assistent erstellen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
