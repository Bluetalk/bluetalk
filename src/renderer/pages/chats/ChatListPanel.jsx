import React, { useEffect, useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search, Users, X } from 'lucide-react';
import VerticalResizeHandle from '../../components/VerticalResizeHandle';
import { CHAT_ICON_STROKE, countUnreadPeerMessages } from './messageHelpers.jsx';
import { ChatListRow } from './ChatListRow.jsx';

/**
 * Linke Spalte: Chatlisten-Header, Suche (inkl. Strg+K-Fokus), Chat-/Agenten-
 * Zeilen und Resize-Handle bzw. Collapse-Strip.
 *
 * Props:
 * - collapsed, widthPx, onToggleCollapse: Collapse/Breite (useChatListWidth)
 * - onResizeBegin/onResizeDelta/onResizeCommit/onResizeReset: Resize-Handle
 * - onShowCreateGroup(): öffnet den Gruppen-Dialog
 * - chats: mainChatList (die Suche/Filterung passiert lokal)
 * - listState: { chatLastViewedPeerTs, messages, subagentsByPeer,
 *   expandedAgentSubs, selectedPeerId, selectedSubagent, debugMode,
 *   ollamaSetupComplete }
 * - actions: { resolveContact, isAiChatPending, onSelectChat(id),
 *   onChatContextMenu(e, chat), onToggleAgentSubs(id, e), onOpenSubagent(chatId, subId) }
 */
export function ChatListPanel({
  collapsed,
  widthPx,
  onToggleCollapse,
  onResizeBegin,
  onResizeDelta,
  onResizeCommit,
  onResizeReset,
  onShowCreateGroup,
  chats,
  listState,
  actions,
}) {
  const [search, setSearch] = useState('');
  const searchInputRef = useRef(null);

  // Ctrl/Cmd+K jumps to the chat search from anywhere in the page.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
        && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const filtered = chats.filter((chat) =>
    `${chat.displayName} ${chat.baseName} ${chat.id}`.toLowerCase().includes(search.toLowerCase())
  );

  const {
    chatLastViewedPeerTs,
    messages,
    subagentsByPeer,
    expandedAgentSubs,
    selectedPeerId,
    selectedSubagent,
    debugMode,
    ollamaSetupComplete,
  } = listState;

  if (collapsed) {
    return (
      <button
        type="button"
        className="panel-collapse-strip panel-collapse-strip--chat-list"
        onClick={onToggleCollapse}
        title="Chatliste einblenden"
        aria-label="Chatliste einblenden"
        aria-expanded={false}
      >
        <PanelLeftOpen size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      </button>
    );
  }

  return (
    <>
      <div
        className="split-list split-list--resizable"
        style={{ width: widthPx, flexShrink: 0 }}
      >
        <div className="split-list-header">
          <h2>Chats</h2>
          <div className="split-list-header-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={onShowCreateGroup}
              title="Neue Gruppe"
              aria-label="Neue Gruppe"
            >
              <Users size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={onToggleCollapse}
              title="Chatliste einklappen"
              aria-label="Chatliste einklappen"
              aria-expanded
            >
              <PanelLeftClose size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </button>
          </div>
        </div>
        <div className="split-list-search-wrap">
          <div className="search-bar">
            <Search size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            <input
              ref={searchInputRef}
              className="input"
              placeholder="Chats durchsuchen…  (Strg+K)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="search-bar-clear"
                aria-label="Suche zurücksetzen"
                onClick={() => { setSearch(''); searchInputRef.current?.focus(); }}
              >
                <X size={13} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
            )}
          </div>
        </div>
        <div className="split-list-body">
          {filtered.length === 0 && (
            <div className="empty-state split-list-empty-state">
              <p>No chats yet. Use New in the sidebar for peers without a conversation, or connect below.</p>
            </div>
          )}
          {filtered.map((chat) => {
            const chatContact = actions.resolveContact(chat.id);
            const unreadCount = !chat.isAiChat
              ? countUnreadPeerMessages(
                  chat.id,
                  chatLastViewedPeerTs[chat.id],
                  messages,
                  chat.lastMessage
                )
              : 0;
            const subagents = chat.isAgent ? (subagentsByPeer[chat.id] || []) : [];
            const hasSubagents = subagents.length > 0;
            const subagentsExpanded = hasSubagents && expandedAgentSubs.has(chat.id);
            const isParentActive = selectedPeerId === chat.id && selectedSubagent?.parentPeerId !== chat.id;
            return (
              <ChatListRow
                key={chat.id}
                chat={chat}
                chatContact={chatContact}
                unreadCount={unreadCount}
                subagents={subagents}
                subagentsExpanded={subagentsExpanded}
                isParentActive={isParentActive}
                selectedSubagent={selectedSubagent}
                aiPending={actions.isAiChatPending(chat.id)}
                ollamaSetupComplete={ollamaSetupComplete}
                debugMode={debugMode}
                onSelect={actions.onSelectChat}
                onContextMenu={actions.onChatContextMenu}
                onToggleSubs={actions.onToggleAgentSubs}
                onOpenSubagent={actions.onOpenSubagent}
              />
            );
          })}
        </div>
      </div>
      <VerticalResizeHandle
        onBegin={onResizeBegin}
        onDelta={onResizeDelta}
        onCommit={onResizeCommit}
        onDoubleClick={onResizeReset}
      />
    </>
  );
}
