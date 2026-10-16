import React from 'react';
import { PeerAvatar } from './messageHelpers.jsx';
import { ChatBackButton } from './ChatBackButton.jsx';

/**
 * Platzhalter-Ansicht für einen Bot, dem noch eine API fehlt.
 *
 * Props: selectedPeer, onShowProfile(), onOpenSettings(), onBack()
 */
export function AiSetupView({ selectedPeer, onShowProfile, onOpenSettings, onBack }) {
  return (
    <div className="ai-chat-setup-wrap">
      <div className="chat-header chat-header--has-profile">
        <ChatBackButton onBack={onBack} />
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
        <h3>Bots wurden eingestellt</h3>
        <p className="text-muted">
          Dieser Chat bleibt lesbar. Neue Nachrichten, Bots und KI-Chats sind nicht mehr möglich.
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onOpenSettings}
        >
          Zu den Einstellungen
        </button>
      </div>
    </div>
  );
}
