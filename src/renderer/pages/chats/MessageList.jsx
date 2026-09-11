import React from 'react';
import { Save, Trash2 } from 'lucide-react';
import StickerMessage from '../../components/StickerMessage';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import groupChat from '../../../shared/group-chat.js';
import {
  CHAT_BATCH_SIZE,
  CHAT_ICON_STROKE,
  PeerAvatar,
  formatDaySeparator,
  formatGenTime,
  formatMessageTime,
  formatMuteExpiry,
  isBareMediaMessage,
  isStickerMessage,
  isChatEmbedMessage,
  isMessageClusterContinuation,
  isSameCalendarDay,
  selfDeliveryLabel,
} from './messageHelpers.jsx';
import {
  ContactShareMessage,
  FileMessage,
  FileLinkMessage,
  GamePresenceBanner,
  MessageReplyQuote,
} from './messageParts.jsx';
import { ChatMessage } from './agentBlocks.jsx';
import { MessageReactions } from './MessageReactions.jsx';

const { getGroupMember } = groupChat;

// Spiel-Einladungen erscheinen im Spiele-Tab, nicht im Verlauf.
const INVITE_MESSAGE_KINDS = new Set([
  'poker-invite',
  'uno-invite',
  'connect-four-invite',
  'chess-invite',
  'tic-tac-toe-invite',
  'live-docs-invite',
]);

/**
 * Nachrichten-Container des aktiven Chats: Warn-/Hinweisbanner, Load-older,
 * die Nachrichtenliste (ChatMessage bleibt memo-freundlich: message-Referenzen
 * und stabile Handler werden unverändert durchgereicht) und der Live-KI-Block.
 * Scroll-Pinning-Refs kommen per Props aus useChatScroll — die Effekte laufen
 * weiterhin auf Seiten-Ebene, exakt wie zuvor.
 *
 * Props (gruppiert):
 * - chat: { selectedPeer, selectedContact, isAiChatSelected, isGroupSelected, ownPeerId }
 * - data: { msgs, readUpToId, hasMoreMessages, loadingMessages, loadingMore }
 * - ui: { debugMode, settings, contactById, peers, selectionMode,
 *   selectedMessageIds, aiChatPending, liveAiProgress, peerTypingActive }
 * - scroll: { chatMessagesRef, endRef, onScroll }
 * - actions: { onLoadOlder(), onToggleSelectMessage(id),
 *   onOpenMessageContextMenu(e, m), onExpandImage(payload), onSaveFile(m),
 *   onConnectFromSharedContact(address, peerId),
 *   openSubagentForSelectedChat(segment), openSubagentChat(peerId, subId),
 *   onExportChat(chat), onOpenDelete(peerId) }
 */
export function MessageList({ chat, data, ui, scroll, actions }) {
  const { selectedPeer, selectedContact, isAiChatSelected, isGroupSelected, ownPeerId } = chat;
  const { msgs, readUpToId, hasMoreMessages, loadingMessages, loadingMore } = data;
  const {
    debugMode,
    settings,
    contactById,
    peers,
    selectionMode,
    selectedMessageIds,
    aiChatPending,
    peerTypingActive = false,
    liveAiProgress = null,
    workLogEnabled = false,
  } = ui;

  const visibleMsgs = msgs.filter((m) => !INVITE_MESSAGE_KINDS.has(m.kind));

  return (
    <div className={`chat-messages${isAiChatSelected ? ' chat-messages--ai' : ''}`} ref={scroll.chatMessagesRef} onScroll={scroll.onScroll}>
      {isAiChatSelected && visibleMsgs.length === 0 && !aiChatPending && !peerTypingActive ? (
        <div className="empty-state ai-chat-ready-placeholder">
          <PeerAvatar
            pictureUrl={selectedPeer.profilePicture}
            name={selectedPeer.displayName}
            size={56}
            className="peer-avatar-img--bot"
            botStatus={aiChatPending ? 'thinking' : 'idle'}
          />
          <p>Schreib dem Bot — Antworten erscheinen wie bei einem Kontakt.</p>
        </div>
      ) : null}
      {isGroupSelected && !selectedPeer.canSend ? (
        <div className="chat-warning" role="status">
          {getGroupMember(selectedPeer.group, ownPeerId)?.state === 'invited'
            ? 'Dein Beitritt wird bestätigt. Danach kannst du in der Gruppe schreiben.'
            : 'Du bist nicht mehr Mitglied dieser Gruppe. Der bisherige Verlauf bleibt auf diesem Gerät erhalten, neue Nachrichten werden nicht mehr zugestellt.'}
        </div>
      ) : null}
      {!selectedPeer.contact?.blocked &&
        !selectedPeer.contact?.blockedByPeer &&
        selectedPeer.gamePresence ? (
          <GamePresenceBanner
            peerId={selectedPeer.id}
            presence={selectedPeer.gamePresence}
          />
        ) : null}
      {selectedPeer.contact?.blocked && (
        <div className="chat-warning" role="status">
          Dieser Kontakt ist blockiert. Entblocken, um Nachrichten zu senden.
        </div>
      )}
      {!selectedPeer.contact?.blocked && selectedPeer.contact?.blockedByPeer && (
        <div className="chat-warning" role="status">
          Du wurdest blockiert. Du kannst keine Nachrichten senden, bis der Kontakt dich wieder entblockt.
        </div>
      )}
      {!selectedPeer.contact?.blocked &&
        !selectedPeer.contact?.blockedByPeer &&
        selectedPeer.contact?.chatDeletedByPeer && (
          <div className="chat-warning" role="status">
            <p style={{ margin: 0 }}>
              {selectedPeer.displayName} hat den Chat gelöscht. Dein lokaler Verlauf bleibt erhalten, bis du
              ihn exportierst oder löschst.
            </p>
            <div className="flex gap-2 flex-wrap" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => void actions.onExportChat(selectedPeer)}
              >
                <Save size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Exportieren
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() => actions.onOpenDelete(selectedPeer.id)}
              >
                <Trash2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Chat löschen
              </button>
            </div>
          </div>
        )}
      {!selectedContact?.blocked &&
        isContactNotificationMuted(selectedContact) && (
          <div className="chat-notice-muted" role="status">
            {selectedContact?.notifyMutedManual ? (
              <>
                Mitteilungen für diesen Kontakt sind stumm, bis du im Menü oben wieder{' '}
                <strong>Mitteilungen ein</strong> wählst.
              </>
            ) : typeof selectedContact?.notifyMutedUntil === 'number' ? (
              <>
                Mitteilungen sind bis{' '}
                <strong>{formatMuteExpiry(selectedContact.notifyMutedUntil)}</strong> stumm (nur
                Windows-Benachrichtigungen).
              </>
            ) : (
              <>Mitteilungen für diesen Kontakt sind stumm.</>
            )}
          </div>
        )}
      {hasMoreMessages && (
        <div className="chat-load-more">
          <button className="btn btn-secondary btn-sm" onClick={actions.onLoadOlder} disabled={loadingMore}>
            {loadingMore ? (
              <span className="spinner-label">
                <span className="spinner spinner--sm" />
                <span>Loading</span>
              </span>
            ) : `Load ${Math.min(CHAT_BATCH_SIZE, selectedPeer.messageCount - msgs.length)} older messages`}
          </button>
        </div>
      )}

      {loadingMessages && msgs.length === 0 && (
        <div className="chat-empty">
          <span className="spinner-label">
            <span className="spinner spinner--md" />
            <span>Loading messages</span>
          </span>
        </div>
      )}

      {!loadingMessages && msgs.length === 0 && !aiChatPending && !peerTypingActive && (
        <div className="chat-empty">
          <p className="text-muted">No messages yet. Say hello!</p>
        </div>
      )}

      {visibleMsgs.map((m, i) => {
        const prev = visibleMsgs[i - 1];
        const next = visibleMsgs[i + 1];
        const clusteredWithPrev = isMessageClusterContinuation(prev, m);
        const clusteredWithNext = isMessageClusterContinuation(m, next);
        const showDaySep = typeof m.timestamp === 'number'
          && (!prev || !isSameCalendarDay(prev.timestamp, m.timestamp));
        const isSelf = m.from === 'self';
        const bubbleName = isSelf ? (settings.displayName || 'You') : (m.sender || selectedPeer.displayName);
        const senderContact = isGroupSelected && !isSelf ? contactById.get(m.senderPeerId || m.from) : null;
        const bubblePic = isSelf
          ? settings.profilePicture
          : isGroupSelected
            ? (senderContact?.profilePicture || '')
            : selectedPeer.profilePicture;
        const stickerMessage = isStickerMessage(m);
        const bareMedia = isBareMediaMessage(m);
        const embedMessage = isChatEmbedMessage(m, debugMode);
        const isLegacyAgentMessage = isAiChatSelected && !isSelf && m.via !== 'message_send'
          && Boolean(m.segments || m.thinking || m.toolEvents);
        const isBotBubble = isAiChatSelected && !isSelf && !isLegacyAgentMessage;
        const outsideBubble = bareMedia || embedMessage || stickerMessage;
        const delivery = selfDeliveryLabel(m);
        const seen = isSelf && readUpToId && m.messageId && readUpToId === m.messageId ? 'Seen' : '';
        const isSelected = Boolean(m.messageId && selectedMessageIds.has(m.messageId));
        const aiStats = !isSelf && m.aiStats && typeof m.aiStats === 'object' ? m.aiStats : null;
        const showAvatar = isGroupSelected && !isLegacyAgentMessage && !isBotBubble && !selectionMode && !clusteredWithNext;
        const showAvatarSpacer = isGroupSelected && !isLegacyAgentMessage && !isBotBubble && !selectionMode && clusteredWithNext;
        const showSender = isGroupSelected && !isSelf && !clusteredWithPrev;
        const showTime = !clusteredWithNext;
        const showMeta = Boolean(
          showTime
          || delivery.pending
          || delivery.text
          || seen
          || aiStats?.tps > 0
          || aiStats?.genTimeMs > 0
          || m.aiStopped
        );
        return (
          <React.Fragment key={m.messageId || `${m.timestamp || i}-${m.from || 'msg'}-${i}`}>
            {showDaySep ? (
              <div className="msg-day-sep" role="separator">
                <span>{formatDaySeparator(m.timestamp)}</span>
              </div>
            ) : null}
            <div
              className={[
                'msg-row',
                isSelf ? 'msg-row-self' : 'msg-row-other',
                outsideBubble && 'msg-row--bare',
                stickerMessage && 'msg-row--sticker',
                isLegacyAgentMessage && 'msg-row--ai-agent',
                embedMessage && 'msg-row--embed',
                selectionMode && 'msg-row--selectable',
                isSelected && 'msg-row--selected',
                clusteredWithPrev && 'msg-row--cluster-follow',
                clusteredWithNext && 'msg-row--cluster-lead',
                isSelf
                  && (m.kind === 'file' || m.kind === 'sticker' || bareMedia)
                  && typeof m.timestamp === 'number'
                  && Date.now() - m.timestamp < 2000
                  && 'msg-row--file-send',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={
                selectionMode && m.messageId
                  ? () => actions.onToggleSelectMessage(m.messageId)
                  : undefined
              }
            >
            {selectionMode && m.messageId ? (
              <label className="msg-select-check" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => actions.onToggleSelectMessage(m.messageId)}
                  aria-label="Nachricht auswählen"
                />
              </label>
            ) : null}
            {showAvatar ? (
              <PeerAvatar pictureUrl={bubblePic} name={bubbleName} size={28} className="msg-avatar" />
            ) : showAvatarSpacer ? (
              <span className="msg-avatar-spacer" aria-hidden />
            ) : null}
            <div className="msg-stack">
            {showSender ? <div className="msg-sender">{bubbleName}</div> : null}
            <div
              className={['msg', isSelf ? 'msg-self' : isLegacyAgentMessage ? 'msg--ai-agent' : 'msg-other', bareMedia && 'msg--bare-media', stickerMessage && 'msg--sticker', embedMessage && 'msg--embed', 'animate-in']
                .filter(Boolean)
                .join(' ')}
              onContextMenu={selectionMode ? undefined : (e) => actions.onOpenMessageContextMenu(e, m)}
            >
              {m.replyTo && m.kind !== 'chat' ? (
                <MessageReplyQuote replyTo={m.replyTo} isSelf={isSelf} />
              ) : null}
              {m.kind === 'file' ? (
                <FileMessage
                  message={m}
                  bareLayout={bareMedia}
                  onExpandImage={actions.onExpandImage}
                  onSaveToDisk={actions.onSaveFile}
                />
              ) : m.kind === 'file-link' ? (
                <FileLinkMessage message={m} />
              ) : m.kind === 'sticker' ? (
                <StickerMessage message={m} />
              ) : m.kind === 'contact-share' ? (
                <ContactShareMessage
                  message={m}
                  isConnected={Boolean(peers.find((p) => p.id === (m.sharedContact?.id || m.from)))}
                  onConnect={actions.onConnectFromSharedContact}
                />
              ) : (
                <ChatMessage
                  message={m}
                  onExpandImage={actions.onExpandImage}
                  onOpenSubagent={isLegacyAgentMessage ? actions.openSubagentForSelectedChat : undefined}
                />
              )}
              {showMeta ? (
              <div className={`msg-meta${isSelf ? ' msg-meta--self' : ''}`}>
                {showTime ? <span className="msg-time">{formatMessageTime(m.timestamp)}</span> : null}
                {delivery.pending ? (
                  <span className="msg-delivery msg-delivery-pending">
                    <span className="spinner spinner--sm spinner--accent" />
                    <span>{delivery.text}</span>
                  </span>
                ) : (delivery.text || seen) ? (
                  <span className="msg-delivery">{[delivery.text, seen].filter(Boolean).join(' · ')}</span>
                ) : null}
                {aiStats?.tps > 0 ? (
                  <span className="msg-ai-stat">{aiStats.tps.toFixed(1)} t/s</span>
                ) : null}
                {aiStats?.genTimeMs > 0 ? (
                  <span className="msg-ai-stat">gen {formatGenTime(aiStats.genTimeMs)}</span>
                ) : null}
                {m.aiStopped ? (
                  <span className="msg-ai-stat msg-ai-stat--stopped">Gestoppt</span>
                ) : null}
              </div>
              ) : null}
            </div>
            <MessageReactions
              message={m}
              hidden={Boolean(selectionMode)}
              onReact={actions.onReact}
            />
            </div>
          </div>
          </React.Fragment>
        );
      })}
      {(isAiChatSelected && (aiChatPending || liveAiProgress)) || peerTypingActive ? (
        <div className="msg-row msg-row-other">
          <div className="msg-stack">
            <div
              className={['msg', 'msg-other', 'msg-bot-typing', workLogEnabled && 'msg-bot-typing--log'].filter(Boolean).join(' ')}
              aria-live="polite"
              role={workLogEnabled ? 'button' : undefined}
              tabIndex={workLogEnabled ? 0 : undefined}
              title={workLogEnabled ? 'Worklog öffnen' : undefined}
              onClick={workLogEnabled ? () => actions.onOpenWorklog?.() : undefined}
              onContextMenu={workLogEnabled ? (event) => {
                event.preventDefault();
                actions.onOpenWorklog?.();
              } : undefined}
              onKeyDown={workLogEnabled ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  actions.onOpenWorklog?.();
                }
              } : undefined}
            >
              <span className="msg-bot-typing-dots" aria-hidden>
                <span />
                <span />
                <span />
              </span>
              <span className="sr-only">{selectedPeer?.displayName || 'Kontakt'} schreibt…</span>
            </div>
          </div>
        </div>
      ) : null}
      <div ref={scroll.endRef} />
    </div>
  );
}
