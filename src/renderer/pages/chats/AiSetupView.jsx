import React from 'react';
import { PeerAvatar } from './messageHelpers.jsx';

/**
 * Platzhalter-Ansicht für einen Bot, dem noch eine API fehlt.
 *
 * Props: selectedPeer, onShowProfile(), onOpenSettings()
 */
export function AiSetupView({ selectedPeer, onShowProfile, onOpenSettings }) {
  return (
    <div className="ai-chat-setup-wrap">
      <div className="chat-header chat-header--has-profile">
        <button
          type="button"
          className="chat-header-profile-btn"
          onClick={onShowProfile}
          aria-haspopup="dialog"
          title={`${selectedPeer.displayName} · API einrichten`}
        >
          <span className="chat-header-avatar-wrap">
            <PeerAvatar
              pictureUrl={selectedPeer.profilePicture}
              name={selectedPeer.displayName}
              size={40}
              className="peer-avatar-img--bot"
              botStatus="setup"
            />
            <span className="chat-header-presence-dot is-muted" aria-hidden />
          </span>
          <span className="chat-header-name">{selectedPeer.displayName}</span>
        </button>
      </div>
      <div className="ai-chat-setup-prompt animate-fade">
        <PeerAvatar
          pictureUrl={selectedPeer.profilePicture}
          name={selectedPeer.displayName}
          size={56}
          className="peer-avatar-img--bot"
          botStatus="setup"
        />
        <h3>API einrichten</h3>
        <p className="text-muted">
          Hinterlege eine OpenAI-kompatible API (URL, Schlüssel, Modell) in den Einstellungen
          oder direkt im Bot-Profil. Danach kannst du hier chatten.
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
