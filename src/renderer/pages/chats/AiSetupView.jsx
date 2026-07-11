import React from 'react';
import { Bot } from 'lucide-react';
import { PeerAvatar } from './messageHelpers.jsx';

/**
 * Platzhalter-Ansicht für einen KI-Chat, dessen Ollama-Setup noch aussteht.
 * JSX 1:1 aus Chats.jsx übernommen.
 *
 * Props: selectedPeer, onShowProfile(), onOpenSettings()
 */
export function AiSetupView({ selectedPeer, onShowProfile, onOpenSettings }) {
  return (
    <div className="ai-chat-setup-wrap">
      <div className="chat-header">
        <button
          type="button"
          className="chat-header-profile-btn"
          onClick={onShowProfile}
          aria-haspopup="dialog"
          title="Profil bearbeiten"
        >
          <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={40} />
          <div style={{ minWidth: 0 }}>
            <div className="font-medium truncate" style={{ fontSize: 14 }}>{selectedPeer.displayName}</div>
            <div className="text-sm text-muted chat-header-meta">Einrichtung ausstehend</div>
          </div>
        </button>
      </div>
      <div className="ai-chat-setup-prompt animate-fade">
        <Bot size={40} strokeWidth={1.5} aria-hidden />
        <h3>KI-Chat noch nicht eingerichtet</h3>
        <p className="text-muted">
          Ollama und ein Modell werden in den Einstellungen eingerichtet. Danach kannst du hier chatten.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onOpenSettings}
        >
          Zu den Einstellungen
        </button>
      </div>
    </div>
  );
}
