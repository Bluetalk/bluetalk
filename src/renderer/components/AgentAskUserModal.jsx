import React, { useEffect, useRef, useState } from 'react';
import { MessageCircleQuestion, X } from 'lucide-react';
import { SETTINGS_ICON_STROKE } from '../pages/settings/settingsUtils';

/**
 * Dialog für den Agent-Tool-Aufruf `ask_user`. Der Main-Prozess sendet
 * `ollama:ask-user` mit Frage + requestId; der Nutzer antwortet hier, und
 * die Antwort geht per `ollama:replyAskUser` zurück, woraufhin das
 * blockierende Tool im Agent-Loop aufgelöst wird.
 */
export default function AgentAskUserModal({ open, question, onSubmit, onCancel }) {
  const inputRef = useRef(null);
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    if (!open) {
      setAnswer('');
      return undefined;
    }
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  if (!open) return null;

  const handleSubmit = (event) => {
    event.preventDefault();
    onSubmit?.(answer);
  };

  return (
    <div
      className="modal-overlay"
      onClick={() => onCancel?.()}
      role="presentation"
    >
      <div
        className="modal animate-scale create-ai-agent-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-ask-user-title"
      >
        <div className="create-ai-agent-modal-header">
          <h3 id="agent-ask-user-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <MessageCircleQuestion size={18} strokeWidth={SETTINGS_ICON_STROKE} />
            Rückfrage des Agents
          </h3>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={() => onCancel?.()}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={SETTINGS_ICON_STROKE} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="create-ai-agent-modal-body">
          <div className="input-group">
            <label htmlFor="agent-ask-user-question" className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>
              {question || 'Der Agent hat eine Rückfrage.'}
            </label>
            <input
              ref={inputRef}
              id="agent-ask-user-question"
              className="input"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Deine Antwort…"
              maxLength={8000}
            />
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onCancel?.()}
            >
              Überspringen
            </button>
            <button type="submit" className="btn btn-primary" disabled={!answer.trim()}>
              Antworten
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
