import React from 'react';
import { Bot, Save, Trash2 } from 'lucide-react';
import StickerMessage from '../../components/StickerMessage';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import groupChat from '../../../shared/group-chat.js';
import {
  CHAT_BATCH_SIZE,
  CHAT_ICON_STROKE,
  PeerAvatar,
  formatGenTime,
  formatMessageTime,
  formatMuteExpiry,
  isBareMediaMessage,
  isChatEmbedMessage,
  selfDeliveryLabel,
  splitThinkingText,
} from './messageHelpers.jsx';
import {
  ContactShareMessage,
  FileMessage,
  GamePresenceBanner,
  MessageReplyQuote,
} from './messageParts.jsx';
import { ChatMessage, MessageSegments } from './agentBlocks.jsx';

const { getGroupMember } = groupChat;

// Einladungen erscheinen im Spiele-/Dokumente-Tab, nicht im Verlauf.
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
 *   selectedMessageIds, aiChatPending, liveAiProgress }
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
    liveAiProgress,
  } = ui;

  return (
    <div className={`chat-messages${isAiChatSelected ? ' chat-messages--ai' : ''}`} ref={scroll.chatMessagesRef} onScroll={scroll.onScroll}>
      {false ? (
        <div className="empty-state ai-chat-ready-placeholder">
          <Bot size={36} strokeWidth={1.5} aria-hidden />
          <p>KI-Chat ist eingerichtet. Die Chat-Unterhaltung wird als Nächstes implementiert.</p>
        </div>
      ) : (
      <>
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

      {!loadingMessages && msgs.length === 0 && (
        <div className="chat-empty">
          <p className="text-muted">No messages yet. Say hello!</p>
        </div>
      )}

      {msgs.map((m, i) => {
        // Spiel-/Dokument-Einladungen leben im Spiele- bzw. Dokumente-Tab;
        // Alt-Einträge im Verlauf werden nicht mehr als Karten gerendert.
        if (INVITE_MESSAGE_KINDS.has(m.kind)) return null;
        const isSelf = m.from === 'self';
        const bubbleName = isSelf ? (settings.displayName || 'You') : (m.sender || selectedPeer.displayName);
        const senderContact = isGroupSelected && !isSelf ? contactById.get(m.senderPeerId || m.from) : null;
        const bubblePic = isSelf
          ? settings.profilePicture
          : isGroupSelected
            ? (senderContact?.profilePicture || '')
            : selectedPeer.profilePicture;
        const bareMedia = isBareMediaMessage(m);
        const embedMessage = isChatEmbedMessage(m, debugMode);
        const isAiAgentMessage = isAiChatSelected && !isSelf;
        const outsideBubble = bareMedia || embedMessage;
        const delivery = selfDeliveryLabel(m);
        const seen = isSelf && readUpToId && m.messageId && readUpToId === m.messageId ? 'Seen' : '';
        const isSelected = Boolean(m.messageId && selectedMessageIds.has(m.messageId));
        const aiStats = !isSelf && m.aiStats && typeof m.aiStats === 'object' ? m.aiStats : null;
        return (
          <div
            key={m.messageId || `${m.timestamp || i}-${m.from || 'msg'}-${i}`}
            className={[
              'msg-row',
              isSelf ? 'msg-row-self' : 'msg-row-other',
              outsideBubble && 'msg-row--bare',
              isAiAgentMessage && 'msg-row--ai-agent',
              embedMessage && 'msg-row--embed',
              selectionMode && 'msg-row--selectable',
              isSelected && 'msg-row--selected',
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
            {!selectionMode && !isAiAgentMessage ? (
              <PeerAvatar pictureUrl={bubblePic} name={bubbleName} size={28} className="msg-avatar" />
            ) : null}
            <div
              className={['msg', isSelf ? 'msg-self' : isAiAgentMessage ? 'msg--ai-agent' : 'msg-other', bareMedia && 'msg--bare-media', embedMessage && 'msg--embed', 'animate-in']
                .filter(Boolean)
                .join(' ')}
              onContextMenu={selectionMode ? undefined : (e) => actions.onOpenMessageContextMenu(e, m)}
            >
              {!isSelf && !selectionMode && <div className="msg-sender">{m.sender || m.from}</div>}
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
              ) : m.kind === 'sticker' ? (
                <StickerMessage message={m} onExpandImage={actions.onExpandImage} />
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
                  onOpenSubagent={isAiChatSelected ? actions.openSubagentForSelectedChat : undefined}
                />
              )}
              <div className={`msg-meta${isSelf ? ' msg-meta--self' : ''}`}>
                <span className="msg-time">{formatMessageTime(m.timestamp)}</span>
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
            </div>
          </div>
        );
      })}
      {isAiChatSelected && aiChatPending ? (
        <div className="msg-row msg-row-other msg-row--ai-agent msg-row--ai-agent-live">
          <div className="msg msg--ai-agent msg--ai-agent-live animate-in">
            {(() => {
              const split = splitThinkingText(liveAiProgress?.content || '');
              const thinking = [liveAiProgress?.thinking || '', split.thinking].filter(Boolean).join('\n\n');
              const content = split.content || liveAiProgress?.content || '';
              const toolEvents = Array.isArray(liveAiProgress?.toolEvents) ? liveAiProgress.toolEvents : [];
              const segments = Array.isArray(liveAiProgress?.segments) ? liveAiProgress.segments : null;
              const hasAnything = thinking || content || toolEvents.length || (segments && segments.length);
              return (
                <>
                  <MessageSegments
                    segments={segments}
                    content={content}
                    thinking={thinking}
                    toolEvents={toolEvents}
                    live
                    onOpenSubagent={(segment) => actions.openSubagentChat(selectedPeer.id, segment.id)}
                  />
                  {!hasAnything ? (
                    <div className="spinner-label">
                      <span className="spinner spinner--sm" />
                      <span>Antwort wird erstellt...</span>
                    </div>
                  ) : null}
                </>
              );
            })()}
            <div className="msg-meta msg-ai-live-meta">
              {typeof liveAiProgress?.tps === 'number' && liveAiProgress.tps > 0 ? (
                <span className="msg-ai-stat">{liveAiProgress.tps.toFixed(1)} t/s</span>
              ) : null}
              {typeof liveAiProgress?.genTimeMs === 'number' && liveAiProgress.genTimeMs > 0 ? (
                <span className="msg-ai-stat">gen {formatGenTime(liveAiProgress.genTimeMs)}</span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      <div ref={scroll.endRef} />
      </>
      )}
    </div>
  );
}
