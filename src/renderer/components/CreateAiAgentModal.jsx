import React, { useEffect, useRef, useState } from 'react';
import { Bot, Brain, Check, FolderOpen, MessageSquare, Sparkles, X } from 'lucide-react';
import {
  AI_AGENT_DEFAULT_MODE_ID,
  AI_PERSONALITY_CUSTOM_MAX_CHARS,
  AI_PERSONALITY_DEFAULT_ID,
  AI_PERSONALITY_PRESETS,
  AI_THINKING_DEFAULT_MODE_ID,
  AI_THINKING_MODES,
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
    onCreate?.({
      name: form.name.trim() || 'KI-Assistent',
      personality: form.personality,
      personalityCustom: form.personalityCustom.trim().slice(0, AI_PERSONALITY_CUSTOM_MAX_CHARS),
      agentMode: AI_AGENT_DEFAULT_MODE_ID,
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
          <div className="create-ai-agent-modal-title-block">
            <span className="create-ai-agent-modal-icon" aria-hidden>
              <Bot size={20} strokeWidth={SETTINGS_ICON_STROKE} />
            </span>
            <div className="create-ai-agent-modal-title-copy">
              <h3 id="create-ai-agent-title">KI-Agent erstellen</h3>
              <p className="create-ai-agent-modal-lead">
                Lokaler Agent mit Datei-, Befehls- und optionalen BlueTalk-Werkzeugen.
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
              <h4 className="create-ai-agent-section-title">Grundlagen</h4>
              <div className="create-ai-agent-fields">
                <div className="input-group">
                  <label htmlFor="create-ai-agent-name">Name</label>
                  <input
                    ref={nameRef}
                    id="create-ai-agent-name"
                    className="input"
                    value={form.name}
                    onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                    maxLength={64}
                    placeholder="z. B. Code-Helfer"
                    disabled={creating}
                  />
                </div>

                <div className="input-group">
                  <label htmlFor="create-ai-agent-workdir">Arbeitsverzeichnis</label>
                  <div className="agent-workdir-row">
                    <input
                      id="create-ai-agent-workdir"
                      className="input"
                      value={form.agentWorkDir}
                      onChange={(e) => setForm((prev) => ({ ...prev, agentWorkDir: e.target.value }))}
                      placeholder="Standard: Desktop-Ordner"
                      disabled={creating}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary agent-workdir-btn"
                      onClick={pickWorkDir}
                      disabled={creating}
                      aria-label="Ordner wählen"
                      title="Ordner wählen"
                    >
                      <FolderOpen size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                    </button>
                  </div>
                  <p className="create-ai-agent-hint">
                    Dateien lesen/schreiben und Befehle in diesem Ordner ausführen.
                  </p>
                </div>
              </div>
            </section>

            <section className="create-ai-agent-section">
              <label className={`agent-permission-card${form.allowBluetalkMessaging ? ' agent-permission-card--on' : ''}`}>
                <input
                  type="checkbox"
                  className="agent-permission-card-input"
                  checked={Boolean(form.allowBluetalkMessaging)}
                  onChange={(e) => setForm((prev) => ({ ...prev, allowBluetalkMessaging: e.target.checked }))}
                  disabled={creating}
                />
                <span className="agent-permission-card-check" aria-hidden>
                  {form.allowBluetalkMessaging ? <Check size={12} strokeWidth={2.5} /> : null}
                </span>
                <span className="agent-permission-card-copy">
                  <span className="agent-permission-card-title">
                    <MessageSquare size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                    BlueTalk-Nutzung erlauben
                  </span>
                  <span className="create-ai-agent-hint">
                    Kontakte und Chats einsehen, Nachrichten senden, Peers verbinden — sensible Aktionen nur nach Bestätigung.
                  </span>
                </span>
              </label>
            </section>

            <section className="create-ai-agent-section">
              <h4 className="create-ai-agent-section-title">
                <Brain size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Thinking-Modus
              </h4>
              <div className="ai-thinking-grid" role="radiogroup" aria-label="Thinking-Modus">
                {Object.values(AI_THINKING_MODES).map((mode) => {
                  const selected = thinkingMode === mode.id;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      className={`ai-choice-card${selected ? ' ai-choice-card--selected' : ''}`}
                      onClick={() => setForm((prev) => ({ ...prev, thinkingMode: mode.id }))}
                      role="radio"
                      aria-checked={selected}
                      disabled={creating}
                    >
                      <span className="ai-choice-card-label">{mode.label}</span>
                      <span className="ai-choice-card-desc">{mode.description}</span>
                      {selected ? (
                        <span className="ai-choice-card-mark" aria-hidden>
                          <Check size={11} strokeWidth={2.5} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="create-ai-agent-section">
              <h4 className="create-ai-agent-section-title">
                <Sparkles size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Persönlichkeit
              </h4>
              <div className="ai-personality-grid" role="radiogroup" aria-label="Persönlichkeit">
                {Object.values(AI_PERSONALITY_PRESETS).map((preset) => {
                  const selected = form.personality === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`ai-choice-card${selected ? ' ai-choice-card--selected' : ''}`}
                      onClick={() => setForm((prev) => ({ ...prev, personality: preset.id }))}
                      role="radio"
                      aria-checked={selected}
                      disabled={creating}
                    >
                      <span className="ai-choice-card-label">{preset.label}</span>
                      <span className="ai-choice-card-desc">{preset.description}</span>
                      {selected ? (
                        <span className="ai-choice-card-mark" aria-hidden>
                          <Check size={11} strokeWidth={2.5} />
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <div className="input-group create-ai-agent-custom">
                <label htmlFor="create-ai-agent-custom">Eigene Anweisungen</label>
                <textarea
                  id="create-ai-agent-custom"
                  className="input create-ai-agent-textarea"
                  rows={3}
                  maxLength={AI_PERSONALITY_CUSTOM_MAX_CHARS}
                  placeholder="Optional — z. B. „Antworte immer mit einem Witz am Ende.“"
                  value={form.personalityCustom}
                  onChange={(e) => setForm((prev) => ({ ...prev, personalityCustom: e.target.value }))}
                  disabled={creating}
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
              {creating ? 'Erstelle…' : 'Agent erstellen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
