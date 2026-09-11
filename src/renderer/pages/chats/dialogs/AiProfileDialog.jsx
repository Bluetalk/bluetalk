import React, { useEffect, useRef, useState } from 'react';
import { FolderOpen, Play, Plus, Trash2, X } from 'lucide-react';
import {
  AI_THINKING_MODES,
  BOT_DEFAULT_NAME,
  BOT_DESCRIPTION_MAX_CHARS,
  BOT_ROUTINE_NAME_MAX_CHARS,
  BOT_ROUTINE_PROMPT_MAX_CHARS,
  createEmptyBotRoutine,
  formatRoutineRunAt,
  nextRoutineRunAt,
  normalizeBotRoutines,
} from '../../../aiChatConstants';
import { CHAT_ICON_STROKE, PeerAvatar, readImageDataUrl } from '../messageHelpers.jsx';
import { BotModelSelect, BotApiFields } from '../../../components/BotModelSelect.jsx';

function triggerLabel(routine) {
  if (routine.triggerType === 'interval') {
    return `alle ${routine.intervalMinutes} Min.`;
  }
  if (routine.triggerType === 'daily') {
    const hour = String(routine.hour).padStart(2, '0');
    const minute = String(routine.minute).padStart(2, '0');
    return `täglich ${hour}:${minute}`;
  }
  return 'manuell';
}

function routineScheduleHint(routine) {
  if (routine.enabled === false) return 'Pausiert';
  const last = formatRoutineRunAt(routine.lastRunAt);
  const next = nextRoutineRunAt(routine);
  const nextText = next ? formatRoutineRunAt(next) : '';
  if (routine.triggerType === 'manual') {
    return last ? `Zuletzt ${last}` : 'Nur per Knopf';
  }
  const bits = [];
  if (last) bits.push(`Zuletzt ${last}`);
  if (nextText) bits.push(`Nächste ${nextText}`);
  return bits.join(' · ') || 'Noch nicht gelaufen';
}

/**
 * Bot-Profil: Name, Beschreibung, Modell, Bild und Routinen.
 */
export function AiProfileDialog({
  open,
  showPeerProfile,
  selectedPeerId,
  selectedPeer,
  aiAgents,
  updateAiAgent,
  onClose,
  toast,
  ollamaState = null,
  debugMode = false,
}) {
  const [draft, setDraft] = useState({
    name: '',
    description: '',
    profilePicture: '',
    modelTier: 'cloud',
    cloudModelId: '',
    modelSource: 'openai',
    openaiBaseUrl: '',
    openaiApiKey: '',
    openaiModel: '',
    agentWorkDir: '',
    thinkingMode: 'auto',
    workLogEnabled: false,
    routines: [],
  });
  const [runningRoutineId, setRunningRoutineId] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    if (!showPeerProfile || !selectedPeerId) return;
    const agent = aiAgents.find((entry) => entry.id === selectedPeerId);
    if (!agent) return;
    setDraft({
      name: agent.name || '',
      description: agent.description || agent.bio || '',
      profilePicture: agent.profilePicture || '',
      modelTier: agent.modelTier || 'cloud',
      cloudModelId: agent.cloudModelId || ollamaState?.selectedCloudModelId || '',
      modelSource: agent.modelSource || 'openai',
      openaiBaseUrl: agent.openaiBaseUrl || '',
      openaiApiKey: agent.openaiApiKey || '',
      openaiModel: agent.openaiModel || '',
      agentWorkDir: agent.agentWorkDir || '',
      thinkingMode: agent.thinkingMode || 'auto',
      workLogEnabled: agent.workLogEnabled === true,
      routines: normalizeBotRoutines(agent.routines),
    });
  }, [showPeerProfile, selectedPeerId, aiAgents, ollamaState?.selectedModelTier, ollamaState?.selectedCloudModelId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const saveProfile = async () => {
    if (!selectedPeer?.isAiChat) return;
    let routines = normalizeBotRoutines(draft.routines);
    try {
      const stored = await window.bluetalk.store.get('aiChat.agents', []);
      const storedAgent = Array.isArray(stored)
        ? stored.find((entry) => entry?.id === selectedPeer.id)
        : null;
      const storedRoutines = Array.isArray(storedAgent?.routines) ? storedAgent.routines : [];
      routines = routines.map((routine) => {
        const previous = storedRoutines.find((entry) => entry?.id === routine.id);
        const storedLast = Number(previous?.lastRunAt) || 0;
        return {
          ...routine,
          lastRunAt: Math.max(Number(routine.lastRunAt) || 0, storedLast),
        };
      });
    } catch {
      // lastRunAt aus dem Store mergen, Speichern darf daran nicht scheitern.
    }
    await updateAiAgent(selectedPeer.id, {
      name: draft.name.trim() || BOT_DEFAULT_NAME,
      description: draft.description.slice(0, BOT_DESCRIPTION_MAX_CHARS),
      profilePicture: draft.profilePicture || '',
      modelTier: draft.modelTier || 'cloud',
      cloudModelId: draft.cloudModelId,
      modelSource: draft.modelSource || 'openai',
      openaiBaseUrl: draft.openaiBaseUrl || '',
      openaiApiKey: draft.openaiApiKey || '',
      openaiModel: draft.openaiModel || '',
      agentWorkDir: draft.agentWorkDir || '',
      thinkingMode: draft.thinkingMode || 'auto',
      workLogEnabled: draft.workLogEnabled === true,
      routines,
    });
    onClose();
    toast({ variant: 'success', title: 'Bot gespeichert' });
  };

  const onAvatarPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageDataUrl(file);
      setDraft((prev) => ({ ...prev, profilePicture: dataUrl }));
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Profilbild',
        message: err?.message || 'Bild konnte nicht verwendet werden.',
      });
    }
  };

  const patchRoutine = (routineId, patch) => {
    setDraft((prev) => ({
      ...prev,
      routines: prev.routines.map((routine) => (
        routine.id === routineId ? { ...routine, ...patch } : routine
      )),
    }));
  };

  const runRoutine = async (routine) => {
    if (!selectedPeer?.id || !routine?.id || runningRoutineId) return;
    if (!String(routine.prompt || '').trim()) {
      toast({ variant: 'info', title: 'Routine', message: 'Gib zuerst einen Auftrag ein.' });
      return;
    }
    await updateAiAgent(selectedPeer.id, {
      name: draft.name.trim() || BOT_DEFAULT_NAME,
      description: draft.description.slice(0, BOT_DESCRIPTION_MAX_CHARS),
      profilePicture: draft.profilePicture || '',
      modelTier: draft.modelTier || 'cloud',
      cloudModelId: draft.cloudModelId,
      modelSource: draft.modelSource || 'openai',
      openaiBaseUrl: draft.openaiBaseUrl || '',
      openaiApiKey: draft.openaiApiKey || '',
      openaiModel: draft.openaiModel || '',
      agentWorkDir: draft.agentWorkDir || '',
      thinkingMode: draft.thinkingMode || 'auto',
      workLogEnabled: draft.workLogEnabled === true,
      routines: normalizeBotRoutines(draft.routines),
    });
    setRunningRoutineId(routine.id);
    try {
      const result = await window.bluetalk?.ollama?.runRoutine?.(selectedPeer.id, routine.id);
      if (result?.ok === false) {
        toast({
          variant: 'error',
          title: 'Routine fehlgeschlagen',
          message: result.error === 'chat_busy'
            ? 'Der Bot antwortet gerade noch.'
            : (result.error || 'Die Routine konnte nicht gestartet werden.'),
        });
      } else {
        patchRoutine(routine.id, { lastRunAt: Date.now() });
      }
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Routine fehlgeschlagen',
        message: err?.message || 'Die Routine konnte nicht gestartet werden.',
      });
    } finally {
      setRunningRoutineId('');
    }
  };

  if (!open) return null;

  return (
    <aside
      className="chat-profile-panel peer-profile-modal bot-profile-modal"
      role="dialog"
      aria-modal="false"
      aria-labelledby="ai-profile-title"
    >
        <div className="peer-profile-modal-toolbar">
          <h2 id="ai-profile-title" className="peer-profile-modal-title">
            Bot
          </h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Schließen"
          >
            <X size={18} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <div className="peer-profile-modal-body">
          <div className="profile-menu-avatar-row">
            <PeerAvatar
              pictureUrl={draft.profilePicture || ''}
              name={draft.name}
              size={72}
              className="profile-menu-preview peer-avatar-img--bot"
            />
            <div className="profile-menu-avatar-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                Bild ändern
              </button>
              {draft.profilePicture ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDraft((prev) => ({ ...prev, profilePicture: '' }))}
                >
                  Standard
                </button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={onAvatarPick}
            />
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-name">Name</label>
            <input
              id="ai-profile-name"
              className="input"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
              maxLength={64}
              autoFocus
            />
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-description">Beschreibung</label>
            <textarea
              id="ai-profile-description"
              className="input profile-menu-bio"
              rows={4}
              maxLength={BOT_DESCRIPTION_MAX_CHARS}
              placeholder="Wer ist dieser Bot, und wie soll er antworten?"
              value={draft.description}
              onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))}
            />
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-model">Modell</label>
            <BotModelSelect
              id="ai-profile-model"
              ollamaState={ollamaState}
              debugMode={debugMode}
              value={draft}
              onChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
            />
          </div>
          <BotApiFields
            idPrefix="ai-profile-api"
            value={draft}
            onChange={(next) => setDraft((prev) => ({ ...prev, ...next }))}
          />

          <section className="bot-settings-block">
            <h3 className="bot-routines-title">Arbeit</h3>
            <div className="input-group">
              <label htmlFor="ai-profile-workdir">Arbeitsordner</label>
              <div className="bot-workdir-row">
                <input
                  id="ai-profile-workdir"
                  className="input"
                  value={draft.agentWorkDir}
                  readOnly
                  placeholder="Standard: Desktop"
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    const path = await window.bluetalk?.agent?.pickFolder?.();
                    if (path) setDraft((prev) => ({ ...prev, agentWorkDir: path }));
                  }}
                >
                  <FolderOpen size={14} strokeWidth={CHAT_ICON_STROKE} />
                  Wählen
                </button>
                {draft.agentWorkDir ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setDraft((prev) => ({ ...prev, agentWorkDir: '' }))}
                  >
                    Standard
                  </button>
                ) : null}
              </div>
            </div>
            <div className="input-group">
              <label htmlFor="ai-profile-thinking">Denkprozess</label>
              <select
                id="ai-profile-thinking"
                className="input"
                value={draft.thinkingMode}
                onChange={(e) => setDraft((prev) => ({ ...prev, thinkingMode: e.target.value }))}
              >
                {Object.values(AI_THINKING_MODES).map((mode) => (
                  <option key={mode.id} value={mode.id}>{mode.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted" style={{ margin: '4px 0 0' }}>
                {AI_THINKING_MODES[draft.thinkingMode]?.description || ''}
              </p>
            </div>
          </section>

          <div className="toggle-row" style={{ padding: '8px 0' }}>
            <div className="toggle-row-info">
              <span>Worklog</span>
              <span>Denkprozess und Tool-Aufrufe als Seitenpanel. Klick auf „schreibt…“ oder Rechtsklick auf eine Bot-Nachricht.</span>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={draft.workLogEnabled === true}
                onChange={(e) => setDraft((prev) => ({ ...prev, workLogEnabled: e.target.checked }))}
              />
              <span className="toggle-slider" />
            </label>
          </div>

          <section className="bot-routines">
            <div className="bot-routines-header">
              <h3 className="bot-routines-title">Routinen</h3>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setDraft((prev) => ({
                  ...prev,
                  routines: [...prev.routines, createEmptyBotRoutine()],
                }))}
              >
                <Plus size={14} strokeWidth={CHAT_ICON_STROKE} />
                Hinzufügen
              </button>
            </div>
            {draft.routines.length === 0 ? (
              <p className="text-sm text-muted" style={{ margin: 0 }}>
                Zeitplan oder Knopfdruck: der Bot schreibt dann selbst in diesen Chat.
              </p>
            ) : draft.routines.map((routine) => (
              <div className="bot-routine-card" key={routine.id}>
                <div className="bot-routine-card-top">
                  <label className="bot-routine-enable">
                    <input
                      type="checkbox"
                      checked={routine.enabled !== false}
                      onChange={(e) => patchRoutine(routine.id, { enabled: e.target.checked })}
                    />
                    Aktiv
                  </label>
                  <span className="text-xs text-muted">{triggerLabel(routine)}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    aria-label="Routine löschen"
                    onClick={() => setDraft((prev) => ({
                      ...prev,
                      routines: prev.routines.filter((entry) => entry.id !== routine.id),
                    }))}
                  >
                    <Trash2 size={14} strokeWidth={CHAT_ICON_STROKE} />
                  </button>
                </div>
                <input
                  className="input"
                  value={routine.name}
                  maxLength={BOT_ROUTINE_NAME_MAX_CHARS}
                  placeholder="Name"
                  onChange={(e) => patchRoutine(routine.id, { name: e.target.value })}
                />
                <textarea
                  className="input"
                  rows={2}
                  maxLength={BOT_ROUTINE_PROMPT_MAX_CHARS}
                  placeholder="Auftrag, z. B. „Fasse ungelesene Chats zusammen.“"
                  value={routine.prompt}
                  onChange={(e) => patchRoutine(routine.id, { prompt: e.target.value })}
                />
                <div className="bot-routine-trigger-row">
                  <select
                    className="input"
                    value={routine.triggerType}
                    onChange={(e) => patchRoutine(routine.id, { triggerType: e.target.value })}
                  >
                    <option value="manual">Manuell</option>
                    <option value="interval">Intervall</option>
                    <option value="daily">Täglich</option>
                  </select>
                  {routine.triggerType === 'interval' ? (
                    <input
                      className="input"
                      type="number"
                      min={5}
                      max={1440}
                      value={routine.intervalMinutes}
                      onChange={(e) => patchRoutine(routine.id, { intervalMinutes: Number(e.target.value) })}
                      aria-label="Minuten"
                    />
                  ) : null}
                  {routine.triggerType === 'daily' ? (
                    <input
                      className="input"
                      type="time"
                      value={`${String(routine.hour).padStart(2, '0')}:${String(routine.minute).padStart(2, '0')}`}
                      onChange={(e) => {
                        const [hour, minute] = String(e.target.value || '08:00').split(':');
                        patchRoutine(routine.id, {
                          hour: Number(hour) || 0,
                          minute: Number(minute) || 0,
                        });
                      }}
                      aria-label="Uhrzeit"
                    />
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={Boolean(runningRoutineId)}
                    onClick={() => void runRoutine(routine)}
                  >
                    <Play size={14} strokeWidth={CHAT_ICON_STROKE} />
                    {runningRoutineId === routine.id ? 'Läuft…' : 'Jetzt'}
                  </button>
                </div>
                <p className="text-xs text-muted" style={{ margin: 0 }}>
                  {routineScheduleHint(routine)}
                </p>
              </div>
            ))}
          </section>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void saveProfile()}>
            Speichern
          </button>
        </div>
    </aside>
  );
}
