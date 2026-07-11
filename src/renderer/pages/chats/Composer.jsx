import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { SendHorizontal, Square, X } from 'lucide-react';
import groupChat from '../../../shared/group-chat.js';
import {
  CHAT_ICON_STROKE,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  formatSize,
  getComposerTextareaMaxHeight,
  getMessagePreviewText,
} from './messageHelpers.jsx';
import { FileTypeIcon } from './messageParts.jsx';
import { ComposerAttachMenu } from './ComposerAttachMenu.jsx';
import { useComposerSend } from './hooks/useComposerSend.js';

const { getGroupMember } = groupChat;

/**
 * Eingabe-Stack: Offline-Overlay, Reply-Bar, Pending-File, Fortschritt,
 * Warnung und die Eingabezeile (Attach-Menü + Textarea + Senden/Stoppen).
 * Der Eingabetext (`input`) ist bewusst LOKALER State (Performance: Tippen
 * rendert nicht mehr die ganze Seite). Der Datei-Anhang-Zustand kommt per
 * Props aus useAttachments, weil er auch von außen geleert wird (z. B. beim
 * Löschen eines Chats).
 *
 * Props (gruppiert):
 * - chat: { selectedPeer, isAiChatSelected, isGroupSelected, ownPeerId,
 *   aiChatPending, aiChatSupportsVision, showAiComposerAttach,
 *   composerDisabled, showOfflineComposerReconnect }
 * - reply: { replyToMessage, onClearReply() }
 * - attachments: Rückgabe von useAttachments
 * - env: { settings, contacts, peers, debugMode, warning }
 * - actions: { sendMessage, cancelAiChat, connectToAddress, toast, setWarning }
 * - textareaRef: Ref aus der Seite (Fokus nach "Antworten" im Kontextmenü)
 */
export function Composer({ chat, reply, attachments, env, actions, textareaRef }) {
  const {
    selectedPeer,
    isAiChatSelected,
    isGroupSelected,
    ownPeerId,
    aiChatPending,
    aiChatSupportsVision,
    showAiComposerAttach,
    composerDisabled,
    showOfflineComposerReconnect,
  } = chat;
  const { replyToMessage, onClearReply } = reply;
  const {
    pendingFile,
    setPendingFile,
    clearPendingFile,
    queuePendingFile,
    fileTransfer,
    setFileTransfer,
    readingFile,
    sendingFile,
  } = attachments;
  const { settings, contacts, peers, debugMode, warning } = env;
  const { sendMessage, cancelAiChat, connectToAddress, toast, setWarning } = actions;

  const [input, setInput] = useState('');

  // Ohne Attach-Unterstützung (KI-Modell ohne Vision) einen bereits
  // gewählten Anhang verwerfen — exakt wie zuvor.
  useEffect(() => {
    if (showAiComposerAttach) return;
    if (pendingFile) clearPendingFile();
  }, [showAiComposerAttach, pendingFile, clearPendingFile]);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = getComposerTextareaMaxHeight();
    el.style.height = `${Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(el.scrollHeight, max))}px`;
  }, [textareaRef]);

  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  useEffect(() => {
    const onResize = () => adjustTextareaHeight();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [adjustTextareaHeight]);

  const send = useComposerSend({
    input,
    setInput,
    selectedPeer,
    isAiChatSelected,
    aiChatPending,
    aiChatSupportsVision,
    showOfflineComposerReconnect,
    replyToMessage,
    onClearReply,
    pendingFile,
    setPendingFile,
    setFileTransfer,
    sendingFile,
    sendMessage,
    setWarning,
    toast,
    settings,
    debugMode,
  });

  const handleComposerPaste = (event) => {
    if (composerDisabled || readingFile || sendingFile) return;
    if (isAiChatSelected && !aiChatSupportsVision) return;
    const items = event.clipboardData?.items;
    if (!items?.length) return;
    const fileItem = [...items].find((item) => item.kind === 'file');
    if (!fileItem) return;
    const file = fileItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    void queuePendingFile(file);
  };

  return (
    <div className="chat-composer-stack">
      {/* Offline wird jetzt allein durch den ausgegrauten Senden-Button und den
          Composer-Platzhalter signalisiert — keine schwebende Statuspille mehr. */}
      {replyToMessage && (
        <div className="chat-reply-bar">
          <div className="chat-reply-bar-body">
            <span className="chat-reply-bar-label">
              Antwort an{' '}
              {replyToMessage.from === 'self'
                ? settings.displayName || 'Du'
                : replyToMessage.sender || selectedPeer.displayName}
            </span>
            <span className="chat-reply-bar-preview">{getMessagePreviewText(replyToMessage, debugMode)}</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon chat-reply-bar-close"
            onClick={onClearReply}
            aria-label="Antwort abbrechen"
            title="Antwort abbrechen"
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
      )}

      {pendingFile && (
        <div className="pending-file">
          <div className="pending-file-icon-wrap" aria-hidden>
            <FileTypeIcon mime={pendingFile.type} fileName={pendingFile.name} size={20} />
          </div>
          <div className="pending-file-info">
            <div className="pending-file-name">{pendingFile.name}</div>
            <div className="pending-file-meta">{formatSize(pendingFile.size)}</div>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => !sendingFile && clearPendingFile()}
            disabled={sendingFile}
            title="Anhang entfernen"
            type="button"
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
      )}

      {fileTransfer && (
        <div
          className="chat-file-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fileTransfer.percent)}
          aria-label={fileTransfer.detail}
        >
          <div className="chat-file-progress-track">
            <div
              className="chat-file-progress-fill"
              style={{ width: `${Math.min(100, fileTransfer.percent)}%` }}
            />
          </div>
          <div className="chat-file-progress-label">
            {fileTransfer.detail} <span className="text-muted">{Math.round(fileTransfer.percent)}%</span>
          </div>
        </div>
      )}

      {warning && <div className="chat-warning">{warning}</div>}

      <div className="chat-input-bar">
        {showAiComposerAttach ? (
          <ComposerAttachMenu
            selectedPeer={selectedPeer}
            isAiChatSelected={isAiChatSelected}
            composerDisabled={composerDisabled}
            readingFile={readingFile}
            sendingFile={sendingFile}
            queuePendingFile={queuePendingFile}
            setFileTransfer={setFileTransfer}
            sendMessage={sendMessage}
            connectToAddress={connectToAddress}
            toast={toast}
            settings={settings}
            contacts={contacts}
            peers={peers}
          />
        ) : null}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={handleComposerPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            isAiChatSelected
              ? aiChatPending ? 'KI antwortet...' : 'Nachricht an KI schreiben...'
              : isGroupSelected && !selectedPeer.canSend
                ? (getGroupMember(selectedPeer.group, ownPeerId)?.state === 'invited'
                  ? 'Beitritt wird bestätigt…'
                  : 'Du bist nicht mehr Mitglied dieser Gruppe.')
              : selectedPeer.contact?.blocked
              ? 'Entblocken, um Nachrichten zu senden…'
              : selectedPeer.contact?.blockedByPeer
                ? 'Du wurdest blockiert…'
                : selectedPeer.contact?.chatDeletedByPeer
                  ? 'Kontakt hat den Chat gelöscht…'
                  : showOfflineComposerReconnect
                    ? 'Warte auf Verbindung …'
                    : readingFile
                      ? 'Datei wird gelesen…'
                      : 'Nachricht schreiben…'
          }
          rows={1}
          disabled={composerDisabled}
        />
        <button
          className="btn btn-primary btn-icon"
          onClick={isAiChatSelected && aiChatPending ? () => void cancelAiChat() : send}
          disabled={
            !(isAiChatSelected && aiChatPending)
            && (
              sendingFile
              || readingFile
              || (!input.trim() && !pendingFile)
              || composerDisabled
            )
          }
          style={{ height: 40, width: 40 }}
          title={isAiChatSelected && aiChatPending ? 'Antwort stoppen' : 'Nachricht senden'}
        >
          {isAiChatSelected && aiChatPending ? (
            <Square size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          ) : (
            <SendHorizontal size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}
