import React from 'react';
import { Bot, BellOff, ChevronDown, Pin, Users } from 'lucide-react';
import {
  formatGamePresenceLabel,
} from '../../../shared/game-presence.js';
import { isPeerDoNotDisturb } from '../../../shared/user-presence.js';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import {
  CHAT_ICON_STROKE,
  PeerAvatar,
  formatTime,
  formatUnreadBadgeCount,
  getLastPreview,
  subagentStatusLabel,
} from './messageHelpers.jsx';

/**
 * Eine Zeile der Chatliste inkl. optional ausgeklappter Sub-Agenten-Zeilen.
 * Memo-Komponente mit stabilen Callback-Props (onSelect(id), onContextMenu(e, chat), …).
 * JSX 1:1 aus dem früheren renderChatListRow in Chats.jsx übernommen.
 */
function ChatListRowInner({
  chat,
  chatContact,
  unreadCount,
  subagents,
  subagentsExpanded,
  isParentActive,
  selectedSubagent,
  aiPending,
  ollamaSetupComplete,
  debugMode,
  nested = false,
  onSelect,
  onContextMenu,
  onToggleSubs,
  onOpenSubagent,
}) {
  const hasSubagents = subagents.length > 0;
  const runningSubagentCount = subagents.filter((seg) => seg.status === 'running').length;

  return (
    <React.Fragment>
      <div
        className={`list-item ${isParentActive ? 'active' : ''}${chat.contact?.blocked ? ' list-item--blocked' : ''}${chat.contact?.blockedByPeer ? ' list-item--blocked-by-peer' : ''}${unreadCount > 0 ? ' list-item--has-unread' : ''}${chat.isAiChat ? ' list-item--ai' : ''}${chat.isGroup ? ' list-item--group' : ''}${nested ? ' list-item--nested' : ''}${hasSubagents ? ' list-item--expandable' : ''}${subagentsExpanded ? ' list-item--expanded' : ''}`}
        onClick={() => onSelect(chat.id)}
        onContextMenu={(e) => onContextMenu(e, chat)}
      >
        {hasSubagents ? (
          <button
            type="button"
            className="list-item-expand-btn"
            aria-expanded={subagentsExpanded}
            aria-label={subagentsExpanded ? 'Sub-Agenten einklappen' : 'Sub-Agenten ausklappen'}
            title={subagentsExpanded ? 'Sub-Agenten einklappen' : 'Sub-Agenten ausklappen'}
            onClick={(e) => onToggleSubs(chat.id, e)}
          >
            <ChevronDown
              size={14}
              strokeWidth={CHAT_ICON_STROKE}
              aria-hidden
              className={`list-item-expand-chevron${subagentsExpanded ? '' : ' list-item-expand-chevron--collapsed'}`}
            />
          </button>
        ) : null}
        {chat.isGroup ? (
          chat.profilePicture ? (
            <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
          ) : (
            <div className="group-chat-list-avatar" aria-hidden><Users size={19} strokeWidth={CHAT_ICON_STROKE} /></div>
          )
        ) : chat.isAiChat ? (
          chat.profilePicture ? (
            <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
          ) : (
            <div className="ai-chat-list-avatar" aria-hidden>
              <Bot size={20} strokeWidth={CHAT_ICON_STROKE} />
            </div>
          )
        ) : (
          <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
        )}
        <div className="list-item-info">
          <div className="list-item-name-row">
            <div className="list-item-name">{chat.displayName}</div>
            {chat.isAgent ? (
              <span className="ai-agent-badge" title="Agent-Modus — kann Dateien, Befehle und BlueTalk-Werkzeuge nutzen">
                Agent
              </span>
            ) : null}
            {chat.pinned && (
              <span className="chat-pin-badge" title="Angehefteter Chat">
                <Pin size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </span>
            )}
            {isContactNotificationMuted(chatContact) && (
              <span className="chat-pin-badge" title="Mitteilungen stumm">
                <BellOff size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </span>
            )}
          </div>
          <div className="list-item-sub">
            {chat.isGroup
              ? (chat.lastMessage
                ? `${chat.lastMessage.from === 'self' ? 'Du' : (chat.lastMessage.sender || 'Mitglied')}: ${getLastPreview(chat.lastMessage, debugMode).replace(/^You: |^Du: /, '')}`
                : `${chat.activeMemberCount} Mitglieder · Ende-zu-Ende-verschlüsselt`)
              : chat.isAiChat
              ? (aiPending
                ? (runningSubagentCount > 0
                  ? `${runningSubagentCount} Sub-Agent${runningSubagentCount === 1 ? '' : 'en'} aktiv…`
                  : 'Antwort wird erstellt…')
                : (hasSubagents && !subagentsExpanded
                  ? `${subagents.length} Sub-Agent${subagents.length === 1 ? '' : 'en'}`
                  : (ollamaSetupComplete
                    ? 'Agent · bereit'
                    : 'Einrichtung nötig')))
              : chat.gamePresence
                ? formatGamePresenceLabel(chat.gamePresence)
                : getLastPreview(chat.lastMessage, debugMode)}
          </div>
        </div>
        <div className="chat-list-meta">
          {chat.lastMessage && <span className="list-item-meta">{formatTime(chat.lastMessage.timestamp)}</span>}
          <div className="chat-list-meta-row">
            {unreadCount > 0 && (
              <>
                <span className="chat-unread-dot" title="Ungelesene Nachrichten" aria-hidden />
                <span
                  className="chat-unread-badge"
                  title={`${unreadCount} ungelesen`}
                  aria-label={`${unreadCount} ungelesene Nachrichten`}
                >
                  {formatUnreadBadgeCount(unreadCount)}
                </span>
              </>
            )}
            {chat.isGroup ? (
              <span className="group-chat-list-badge" title={`${chat.activeMemberCount} Mitglieder`}><Users size={12} /> {chat.activeMemberCount}</span>
            ) : chat.isAiChat ? (
              aiPending ? (
                <span className="ai-chat-list-badge ai-chat-list-badge--pending" title="Antwort wird erstellt">
                  <span className="spinner spinner--sm" aria-hidden />
                </span>
              ) : (
                <span className="ai-chat-list-badge" title="KI-Chat">KI</span>
              )
            ) : (
              <>
              {chat.gamePresence ? (
                <span className="game-presence-list-badge" title={formatGamePresenceLabel(chat.gamePresence)}>
                  {chat.gamePresence.game === 'poker' ? '♠' : chat.gamePresence.game === 'connect-four' ? '🔴' : chat.gamePresence.game === 'chess' ? '♟' : chat.gamePresence.game === 'tic-tac-toe' ? '✕' : '🎴'}
                </span>
              ) : null}
              {!chat.offline && isPeerDoNotDisturb(chat.userPresence) ? (
                <span className="dnd-dot" title="Nicht stören" />
              ) : (
                <span className={chat.offline ? 'offline-dot' : 'online-dot'} />
              )}
              </>
            )}
          </div>
        </div>
      </div>
      {subagentsExpanded ? subagents.map((sub) => {
        const taskPreview = String(sub.task || '').trim();
        const shortTask = taskPreview.length > 72 ? `${taskPreview.slice(0, 72)}…` : taskPreview;
        const running = sub.status === 'running';
        const failed = sub.status === 'error';
        const isSubagentActive = selectedSubagent?.parentPeerId === chat.id && selectedSubagent?.subagentId === sub.id;
        return (
          <div
            key={`sub-${sub.id}`}
            className={`list-item list-item--subagent${isSubagentActive ? ' active' : ''}${running ? ' list-item--subagent-live' : ''}${failed ? ' list-item--subagent-error' : ''}`}
            aria-label={`Sub-Agent · ${subagentStatusLabel(sub.status)}`}
            role="button"
            tabIndex={0}
            onClick={() => onOpenSubagent(chat.id, sub.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenSubagent(chat.id, sub.id);
              }
            }}
          >
            <div className="ai-chat-list-avatar list-item--subagent-icon" aria-hidden>
              <Bot size={16} strokeWidth={CHAT_ICON_STROKE} />
            </div>
            <div className="list-item-info">
              <div className="list-item-name-row">
                <div className="list-item-name">Sub-Agent · {subagentStatusLabel(sub.status)}</div>
                {running ? (
                  <span className="ai-chat-list-badge ai-chat-list-badge--pending" title="Sub-Agent läuft">
                    <span className="spinner spinner--sm" aria-hidden />
                  </span>
                ) : null}
              </div>
              <div className="list-item-sub">
                {shortTask || (running ? 'Teilaufgabe wird bearbeitet…' : (failed ? (sub.error || 'Fehlgeschlagen') : 'Abgeschlossen'))}
              </div>
            </div>
          </div>
        );
      }) : null}
    </React.Fragment>
  );
}

export const ChatListRow = React.memo(ChatListRowInner);
