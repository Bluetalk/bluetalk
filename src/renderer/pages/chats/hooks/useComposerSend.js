import { isAiChatPeerId } from '../../../aiChatConstants';
import {
  contactOutgoingBlocked,
  getMessagePreviewText,
} from '../messageHelpers.jsx';

/**
 * Senden-Logik des Composers (Text, KI-Chat inkl. Anhang, Datei-Versand mit
 * Fortschrittsbalken). 1:1 aus dem früheren send() in Chats.jsx — nur der
 * Eingabetext kommt jetzt aus dem lokalen Composer-State.
 */
export function useComposerSend({
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
}) {
  const send = () => {
    if (!selectedPeer) return;
    if (contactOutgoingBlocked(selectedPeer.contact)) return;
    if (showOfflineComposerReconnect) return;
    if (!input.trim() && !pendingFile) return;
    if (sendingFile) return;
    if (isAiChatSelected && aiChatPending) return;

    setWarning('');
    const peerId = selectedPeer.id;

    if (isAiChatSelected) {
      const text = input.trim();
      const file = pendingFile;
      if (file && !aiChatSupportsVision) {
        toast({
          variant: 'warning',
          title: 'Anhänge nicht unterstützt',
          message: 'Das aktuelle Modell kann keine Bilder verarbeiten. Wähle z. B. die Stufe Smart (Gemma 4).',
        });
        return;
      }
      setInput('');
      if (file) setPendingFile(null);
      onClearReply();

      sendMessage(peerId, {
        kind: 'chat',
        content: text,
        fileAttachment: file
          ? {
              fileName: file.name,
              fileSize: file.size,
              fileType: file.type,
              fileData: file.base64,
              localPreviewUrl: file.objectUrl,
            }
          : undefined,
      }).then((result) => {
        const ok = result === true || result?.ok === true;
        if (!ok) {
          const rawError = typeof result?.error === 'string' ? result.error : '';
          if (rawError === 'chat_aborted') return;
          const aiMessage =
            rawError === 'chat_busy'
              ? 'Die KI antwortet noch auf eine vorherige Nachricht.'
              : rawError === 'setup_incomplete'
              ? 'Die KI ist noch nicht eingerichtet. Richte Ollama und ein Modell unter Einstellungen → AI Chat ein.'
              : rawError === 'ollama_handler_missing'
                ? 'BlueTalk muss einmal komplett neu gestartet werden, damit der neue Ollama-Chat aktiv ist.'
              : rawError === 'server_not_running'
                ? 'Ollama konnte nicht gestartet werden.'
                : rawError === 'model_missing'
                  ? 'Das ausgewählte Modell fehlt.'
                  : rawError === 'vision_not_supported'
                    ? 'Das aktuelle Modell unterstützt keine Bild-Anhänge. Wähle z. B. die Stufe Smart (Gemma 4).'
                  : /can't find closing '\}' symbol|looks like object/i.test(rawError)
                    ? 'Tool-Aufruf konnte nicht verarbeitet werden. Bitte BlueTalk neu starten und erneut versuchen.'
                  : rawError || 'Prüfe Ollama und das ausgewählte Modell.';
          toast({
            variant: 'error',
            title: 'KI antwortet nicht',
            message: aiMessage,
          });
        }
      });
      return;
    }

    // Text messages: clear input immediately, send in background (fire-and-forget)
    if (input.trim()) {
      const text = input.trim();
      setInput('');
      const payload = { kind: 'chat', content: text };
      if (replyToMessage) {
        payload.replyTo = {
          messageId: replyToMessage.messageId,
          sender:
            replyToMessage.from === 'self'
              ? settings.displayName || 'Du'
              : replyToMessage.sender || selectedPeer.displayName,
          preview: getMessagePreviewText(replyToMessage, debugMode),
          timestamp: replyToMessage.timestamp,
        };
        onClearReply();
      }
      sendMessage(peerId, payload).then((result) => {
        const ok = result === true || result?.ok === true;
        if (!ok) {
          const rawError = typeof result?.error === 'string' ? result.error : '';
          if (isAiChatPeerId(peerId) && rawError === 'chat_aborted') return;
          const aiPeer = isAiChatPeerId(peerId);
          const aiMessage =
            rawError === 'chat_busy'
              ? 'Die KI antwortet noch auf eine vorherige Nachricht.'
              : rawError === 'setup_incomplete'
              ? 'Die KI ist noch nicht eingerichtet. Richte Ollama und ein Modell unter Einstellungen → AI Chat ein.'
              : rawError === 'ollama_handler_missing'
                ? 'BlueTalk muss einmal komplett neu gestartet werden, damit der neue Ollama-Chat aktiv ist.'
              : rawError === 'server_not_running'
                ? 'Ollama konnte nicht gestartet werden.'
                : rawError === 'model_missing'
                  ? 'Das ausgewählte Modell fehlt.'
                  : rawError === 'vision_not_supported'
                    ? 'Das aktuelle Modell unterstützt keine Bild-Anhänge. Wähle z. B. die Stufe Smart (Gemma 4).'
                  : /can't find closing '\}' symbol|looks like object/i.test(rawError)
                    ? 'Tool-Aufruf konnte nicht verarbeitet werden. Bitte BlueTalk neu starten und erneut versuchen.'
                  : rawError || 'Prüfe Ollama und das ausgewählte Modell.';
          toast({
            variant: 'error',
            title: aiPeer ? 'KI antwortet nicht' : 'Message not sent',
            message: aiPeer ? aiMessage : 'Peer is probably offline.',
          });
        }
      });
    }

    // File messages: keep progress bar but send async
    if (pendingFile) {
      const file = pendingFile;
      setPendingFile(null);
      let progressTimer = null;
      setFileTransfer({ stage: 'sending', percent: 48, detail: 'Sending attachment…' });
      progressTimer = setInterval(() => {
        setFileTransfer((prev) => {
          if (!prev || prev.stage !== 'sending') return prev;
          return { ...prev, percent: Math.min(96, prev.percent + 1.1) };
        });
      }, 120);

      sendMessage(peerId, {
        kind: 'file',
        content: file.name,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type,
        fileData: file.base64,
        localPreviewUrl: file.objectUrl,
      }).then((result) => {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        // Gruppen-Sends liefern ein Objekt ({ ok, error }), Direkt-Sends ein Boolean.
        const ok = result === true || result?.ok === true;
        if (!ok) {
          toast({ variant: 'error', title: 'File not sent', message: 'Peer is probably offline.' });
          setFileTransfer(null);
          return;
        }
        setFileTransfer({ stage: 'sending', percent: 100, detail: 'Sent' });
        setTimeout(() => setFileTransfer(null), 400);
      }).catch(() => {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        setFileTransfer(null);
      });
    }
  };

  return send;
}
