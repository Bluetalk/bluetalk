import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SendHorizontal, Square, X } from 'lucide-react';
import groupChat from '../../../shared/group-chat.js';
import { TYPING_REFRESH_MS } from '../../../shared/chat-typing.js';
import {
  CHAT_ICON_STROKE,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  formatSize,
  getComposerTextareaMaxHeight,
  getFileCategory,
  getMessagePreviewText,
} from './messageHelpers.jsx';
import { FileTypeIcon } from './messageParts.jsx';
import { ComposerAttachMenu } from './ComposerAttachMenu.jsx';
import { BotActionBar } from './BotActionBar.jsx';
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
    askUser = null,
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
  const { sendMessage, sendTyping, cancelAiChat, connectToAddress, toast, setWarning, onAskReply } = actions;
  const askActive = Boolean(askUser?.requestId);
  const showStop = isAiChatSelected && aiChatPending && !askActive;

  const [input, setInput] = useState('');
  const typingPeerRef = useRef('');
  const lastTypingSentRef = useRef(0);
  const typingActiveRef = useRef(false);

  const stopTyping = useCallback(() => {
    const peerId = typingPeerRef.current;
    if (!peerId || !typingActiveRef.current) {
      typingActiveRef.current = false;
      return;
    }
    typingActiveRef.current = false;
    lastTypingSentRef.current = 0;
    sendTyping?.(peerId, false);
  }, [sendTyping]);

  const pulseTyping = useCallback(() => {
    const peerId = selectedPeer?.id;
    if (!peerId || isAiChatSelected || isGroupSelected || composerDisabled) return;
    const now = Date.now();
    typingPeerRef.current = peerId;
    if (!typingActiveRef.current || now - lastTypingSentRef.current >= TYPING_REFRESH_MS) {
      typingActiveRef.current = true;
      lastTypingSentRef.current = now;
      sendTyping?.(peerId, true);
    }
  }, [composerDisabled, isAiChatSelected, isGroupSelected, selectedPeer?.id, sendTyping]);

  useEffect(() => {
    const previous = typingPeerRef.current;
    if (previous && previous !== selectedPeer?.id) {
      if (typingActiveRef.current) sendTyping?.(previous, false);
      typingActiveRef.current = false;
      lastTypingSentRef.current = 0;
    }
    typingPeerRef.current = selectedPeer?.id || '';
  }, [selectedPeer?.id, sendTyping]);

  useEffect(() => () => {
    const peerId = typingPeerRef.current;
    if (peerId && typingActiveRef.current) sendTyping?.(peerId, false);
  }, [sendTyping]);

  useEffect(() => {
    if (composerDisabled) stopTyping();
  }, [composerDisabled, stopTyping]);

  useEffect(() => {
    if (!input.trim() || isAiChatSelected || isGroupSelected || composerDisabled) return undefined;
    const id = window.setInterval(() => pulseTyping(), TYPING_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [composerDisabled, input, isAiChatSelected, isGroupSelected, pulseTyping]);

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

  const [sendBurst, setSendBurst] = useState(false);

  const fireSend = () => {
    if (askActive) {
      if (!input.trim() || composerDisabled) return;
      onAskReply?.(input.trim());
      setInput('');
      return;
    }
    if (isAiChatSelected && aiChatPending) return;
    if (
      sendingFile
      || readingFile
      || pendingFile?.launching
      || (!input.trim() && !pendingFile)
      || composerDisabled
    ) return;
    setSendBurst(true);
    window.setTimeout(() => setSendBurst(false), 380);
    stopTyping();
    send();
  };

  const handleComposerPaste = (event) => {
    if (composerDisabled || readingFile || sendingFile || pendingFile?.launching) return;
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
    <div className="chat-composer-wrap">
      {isAiChatSelected ? <BotActionBar askUser={askUser} onReply={onAskReply} /> : null}
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
        <div className={`pending-file${pendingFile.launching ? ' pending-file--launch' : ''}`}>
          {getFileCategory(pendingFile.type, pendingFile.name) === 'image' && pendingFile.objectUrl ? (
            <img src={pendingFile.objectUrl} alt="" className="pending-file-thumb" />
          ) : (
            <div className="pending-file-icon-wrap" aria-hidden>
              <FileTypeIcon mime={pendingFile.type} fileName={pendingFile.name} size={20} />
            </div>
          )}
          <div className="pending-file-info">
            <div className="pending-file-name">{pendingFile.name}</div>
            <div className="pending-file-meta">{formatSize(pendingFile.size)}</div>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => !sendingFile && !pendingFile.launching && clearPendingFile()}
            disabled={sendingFile || pendingFile.launching}
            title="Anhang entfernen"
            type="button"
          >
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
      )}

      {fileTransfer && !pendingFile?.launching && (
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
          onChange={(e) => {
            const value = e.target.value;
            setInput(value);
            if (value.trim()) pulseTyping();
            else stopTyping();
          }}
          onPaste={handleComposerPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              fireSend();
            }
          }}
          placeholder={
            isAiChatSelected
              ? askActive
                ? (askUser?.options?.length ? 'Oder selbst antworten…' : 'Antwort schreiben…')
                : aiChatPending ? 'Bot schreibt…' : 'Nachricht an Bot…'
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
          className={`btn btn-primary btn-icon chat-send-btn${sendBurst ? ' is-sending' : ''}`}
          onClick={showStop ? () => void cancelAiChat() : fireSend}
          disabled={
            !showStop
            && (
              sendingFile
              || readingFile
              || pendingFile?.launching
              || (!input.trim() && !pendingFile)
              || composerDisabled
            )
          }
          style={{ height: 32, width: 32 }}
          title={showStop ? 'Antwort stoppen' : askActive ? 'Antwort senden' : 'Nachricht senden'}
        >
          {showStop ? (
            <Square size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          ) : (
            <SendHorizontal size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          )}
        </button>
      </div>
      </div>
    </div>
  );
}
