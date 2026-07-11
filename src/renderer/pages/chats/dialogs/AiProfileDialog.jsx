import React, { useEffect, useRef, useState } from 'react';
import { Bot, X } from 'lucide-react';
import {
  AI_PERSONALITY_CUSTOM_MAX_CHARS,
  AI_PERSONALITY_PRESETS,
} from '../../../aiChatConstants';
import { CHAT_ICON_STROKE, readImageDataUrl } from '../messageHelpers.jsx';

/**
 * KI-Profil-Editor (Name, Info, Bild, Persönlichkeit). Der Entwurf lebt lokal
 * und wird — wie zuvor — beim Öffnen aus dem Agenten befüllt. Die Komponente
 * bleibt dauerhaft gemountet, damit der Init-Effekt exakt wie das Original
 * (deps: showPeerProfile, selectedPeerId, aiAgents) läuft. Der Escape-Handler
 * ist mitgewandert.
 *
 * Props: open (Render-Gate), showPeerProfile, selectedPeerId, selectedPeer,
 * aiAgents, updateAiAgent(agentId, patch), onClose(), toast
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
}) {
  const [aiProfileDraft, setAiProfileDraft] = useState({
    name: '',
    bio: '',
    profilePicture: '',
    personality: 'default',
    personalityCustom: '',
  });
  const aiProfileFileRef = useRef(null);

  useEffect(() => {
    if (!showPeerProfile || !selectedPeerId) return;
    const agent = aiAgents.find((entry) => entry.id === selectedPeerId);
    if (!agent) return;
    setAiProfileDraft({
      name: agent.name || '',
      bio: agent.bio || '',
      profilePicture: agent.profilePicture || '',
      personality: agent.personality || 'default',
      personalityCustom: agent.personalityCustom || '',
    });
  }, [showPeerProfile, selectedPeerId, aiAgents]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const saveAiProfile = async () => {
    if (!selectedPeer?.isAiChat) return;
    await updateAiAgent(selectedPeer.id, {
      name: aiProfileDraft.name.trim() || 'KI-Assistent',
      bio: aiProfileDraft.bio.slice(0, 500),
      profilePicture: aiProfileDraft.profilePicture || '',
      personality: aiProfileDraft.personality,
      personalityCustom: aiProfileDraft.personalityCustom.trim().slice(0, AI_PERSONALITY_CUSTOM_MAX_CHARS),
    });
    onClose();
    toast({ variant: 'success', title: 'Profil gespeichert' });
  };

  const onAiAvatarPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageDataUrl(file);
      setAiProfileDraft((prev) => ({ ...prev, profilePicture: dataUrl }));
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Profilbild',
        message: err?.message || 'Bild konnte nicht verwendet werden.',
      });
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <div
        className="modal animate-scale peer-profile-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-profile-title"
      >
        <div className="peer-profile-modal-toolbar">
          <h2 id="ai-profile-title" className="peer-profile-modal-title">
            KI-Profil
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
            {aiProfileDraft.profilePicture ? (
              <img src={aiProfileDraft.profilePicture} alt="" className="profile-menu-preview" />
            ) : (
              <div className="profile-menu-preview profile-menu-preview-placeholder ai-chat-list-avatar">
                <Bot size={28} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </div>
            )}
            <div className="profile-menu-avatar-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => aiProfileFileRef.current?.click()}
              >
                Bild ändern
              </button>
              {aiProfileDraft.profilePicture ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAiProfileDraft((prev) => ({ ...prev, profilePicture: '' }))}
                >
                  Entfernen
                </button>
              ) : null}
            </div>
            <input
              ref={aiProfileFileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={onAiAvatarPick}
            />
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-name">Name</label>
            <input
              id="ai-profile-name"
              className="input"
              value={aiProfileDraft.name}
              onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, name: e.target.value }))}
              maxLength={64}
              autoFocus
            />
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-bio">Info</label>
            <textarea
              id="ai-profile-bio"
              className="input profile-menu-bio"
              rows={3}
              maxLength={500}
              placeholder="Kurze Beschreibung für diesen KI-Assistenten"
              value={aiProfileDraft.bio}
              onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, bio: e.target.value }))}
            />
          </div>
          <div className="input-group">
            <span className="input-group-label">Persönlichkeit</span>
            <div className="ai-personality-grid" role="radiogroup" aria-label="Persönlichkeit">
              {Object.values(AI_PERSONALITY_PRESETS).map((preset) => {
                const selected = aiProfileDraft.personality === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={`ai-personality-option${selected ? ' ai-personality-option--selected' : ''}`}
                    onClick={() => setAiProfileDraft((prev) => ({ ...prev, personality: preset.id }))}
                    role="radio"
                    aria-checked={selected}
                  >
                    <span className="ai-personality-option-label">{preset.label}</span>
                    <span className="ai-personality-option-desc">{preset.description}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="input-group">
            <label htmlFor="ai-profile-personality-custom">Eigene Anweisungen (optional)</label>
            <textarea
              id="ai-profile-personality-custom"
              className="input profile-menu-bio"
              rows={3}
              maxLength={AI_PERSONALITY_CUSTOM_MAX_CHARS}
              placeholder="z. B. „Antworte immer mit einem Witz am Ende.“"
              value={aiProfileDraft.personalityCustom}
              onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, personalityCustom: e.target.value }))}
            />
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Abbrechen
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void saveAiProfile()}>
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
}
