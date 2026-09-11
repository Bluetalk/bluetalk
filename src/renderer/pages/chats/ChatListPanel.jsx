import React, { useEffect, useRef, useState } from 'react';
import { MessageCircle, PanelLeftClose, PanelLeftOpen, Search, Users, X } from 'lucide-react';
import VerticalResizeHandle from '../../components/VerticalResizeHandle';
import {
  CHAT_ICON_STROKE,
  CHAT_LIST_WIDTH_COLLAPSED,
  countUnreadPeerMessages,
} from './messageHelpers.jsx';
import { ChatListRow } from './ChatListRow.jsx';

/**
 * Linke Spalte: Chatlisten-Header, Suche (inkl. Strg+K-Fokus), Chat-/Agenten-
 * Zeilen, Resize-Handle und eingeklappte Avatar-Leiste.
 *
 * Props:
 * - collapsed, widthPx, onToggleCollapse: Collapse/Breite (useChatListWidth)
 * - onResizeBegin/onResizeDelta/onResizeCommit/onResizeReset: Resize-Handle
 * - onShowCreateGroup(): öffnet den Gruppen-Dialog
 * - chats: mainChatList (die Suche/Filterung passiert lokal)
 * - listState: { chatLastViewedPeerTs, messages, subagentsByPeer,
 *   expandedAgentSubs, selectedPeerId, selectedSubagent, debugMode, peerTyping }
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
  const [railMotion, setRailMotion] = useState(false);
  const searchInputRef = useRef(null);

  const handleToggleCollapse = () => {
    setRailMotion(true);
    onToggleCollapse();
  };

  useEffect(() => {
    if (!railMotion) return undefined;
    const id = window.setTimeout(() => setRailMotion(false), 400);
    return () => window.clearTimeout(id);
  }, [railMotion]);

  // Ctrl/Cmd+K jumps to the chat search from anywhere in the page.
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
        && (event.key === 'k' || event.key === 'K')) {
        event.preventDefault();
        if (collapsed) {
          setRailMotion(true);
          onToggleCollapse();
          return;
        }
        const input = searchInputRef.current;
        if (input) {
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [collapsed, onToggleCollapse]);

  const filtered = (collapsed ? chats : chats.filter((chat) =>
    `${chat.displayName} ${chat.baseName} ${chat.id}`.toLowerCase().includes(search.toLowerCase())
  ));

  const {
    chatLastViewedPeerTs,
    messages,
    subagentsByPeer,
    expandedAgentSubs,
    selectedPeerId,
    selectedSubagent,
    debugMode,
    peerTyping = {},
  } = listState;

  return (
    <div
      className={`split-list-shell${collapsed ? ' split-list-shell--collapsed' : ''}${railMotion ? ' split-list-shell--motion' : ''}`}
      style={{ width: collapsed ? CHAT_LIST_WIDTH_COLLAPSED : widthPx, flexShrink: 0 }}
    >
      <div className={`split-list split-list--resizable${collapsed ? ' split-list--collapsed' : ''}`}>
        <div className="split-list-header">
          <h2>Chats</h2>
          <div className="split-list-header-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm split-list-create-group"
              onClick={onShowCreateGroup}
              title="Neue Gruppe"
              aria-label="Neue Gruppe"
              aria-hidden={collapsed}
              tabIndex={collapsed ? -1 : undefined}
            >
              <Users size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm split-list-collapse-btn"
              onClick={handleToggleCollapse}
              title={collapsed ? 'Chatliste einblenden' : 'Chatliste einklappen'}
              aria-label={collapsed ? 'Chatliste einblenden' : 'Chatliste einklappen'}
              aria-expanded={!collapsed}
            >
              {collapsed
                ? <PanelLeftOpen size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                : <PanelLeftClose size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />}
            </button>
          </div>
        </div>
        <div className="split-list-search-wrap" aria-hidden={collapsed}>
          <div className="search-bar">
            <Search size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            <input
              ref={searchInputRef}
              className="input"
              placeholder="Chats durchsuchen…"
              value={search}
              tabIndex={collapsed ? -1 : undefined}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="search-bar-clear"
                aria-label="Suche zurücksetzen"
                onClick={() => { setSearch(''); searchInputRef.current?.focus(); }}
              >
                <X size={13} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
            ) : (
              <kbd className="search-kbd">Strg+K</kbd>
            )}
          </div>
        </div>
        <div className="split-list-body">
          {filtered.length === 0 && (
            <div className="empty-state split-list-empty-state">
              {search ? (
                <>
                  <Search size={22} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  <p className="empty-state-title">Keine Treffer</p>
                  <p>Kein Chat passt zu „{search.trim()}“.</p>
                </>
              ) : (
                <>
                  <MessageCircle size={22} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  <p className="empty-state-title">Noch keine Chats</p>
                  <p>Unter Neu jemanden finden oder einen Peer per Adresse verbinden.</p>
                </>
              )}
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
                subagentsExpanded={!collapsed && subagentsExpanded}
                isParentActive={isParentActive}
                selectedSubagent={selectedSubagent}
                aiPending={actions.isAiChatPending(chat.id)}
                peerTypingActive={Number(peerTyping?.[chat.id]) > Date.now()}
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
    </div>
  );
}
