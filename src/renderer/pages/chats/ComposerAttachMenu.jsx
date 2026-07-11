import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { File, FileImage, Plus, Smile, UserRound } from 'lucide-react';
import StickerPicker from '../../components/StickerPicker';
import { pluginRuntime } from '../../plugins/pluginRuntime';
import { CHAT_ICON_STROKE, resolveLucideIcon } from './messageHelpers.jsx';

/**
 * Anhang-Bereich des Composers: versteckte File-Inputs, Plus-Button,
 * Attach-Menü (Portal, inkl. Escape-/Outside-Click-Handling), Sticker-Picker
 * und Plugin-Anhänge. Menü-Zustand lebt lokal; die Komponente wird — wie der
 * frühere Inline-Block — nur gerendert, wenn showAiComposerAttach greift.
 *
 * Props:
 * - selectedPeer, isAiChatSelected, composerDisabled, readingFile, sendingFile
 * - queuePendingFile(file), setFileTransfer, sendMessage, connectToAddress,
 *   toast, settings, contacts, peers
 */
export function ComposerAttachMenu({
  selectedPeer,
  isAiChatSelected,
  composerDisabled,
  readingFile,
  sendingFile,
  queuePendingFile,
  setFileTransfer,
  sendMessage,
  connectToAddress,
  toast,
  settings,
  contacts,
  peers,
}) {
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [attachMenuPosition, setAttachMenuPosition] = useState({ bottom: 0, left: 0 });
  const attachMenuBtnRef = useRef(null);
  const attachMenuPanelRef = useRef(null);
  const [composerAttachments, setComposerAttachments] = useState(() => pluginRuntime.listComposerAttachments());
  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);

  // Beim Chat-Wechsel Attach-Menü schließen (Teil des früheren Sammel-Reset-Effekts).
  useEffect(() => {
    setAttachMenuOpen(false);
  }, [selectedPeer?.id]);

  useEffect(() => {
    const off = pluginRuntime.onComposerAttachmentsChanged((items) => {
      setComposerAttachments(items);
    });
    setComposerAttachments(pluginRuntime.listComposerAttachments());
    return off;
  }, []);

  useLayoutEffect(() => {
    if (!attachMenuOpen || !attachMenuBtnRef.current) return;
    const r = attachMenuBtnRef.current.getBoundingClientRect();
    const menuWidth = 248;
    const left = Math.min(Math.max(8, r.left), window.innerWidth - menuWidth - 8);
    setAttachMenuPosition({ bottom: window.innerHeight - r.top + 8, left });
  }, [attachMenuOpen]);

  useEffect(() => {
    if (!attachMenuOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setAttachMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    let onDown = null;
    const id = window.setTimeout(() => {
      onDown = (e) => {
        const t = e.target;
        if (attachMenuBtnRef.current?.contains(t)) return;
        if (attachMenuPanelRef.current?.contains(t)) return;
        setAttachMenuOpen(false);
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [attachMenuOpen]);

  const closeAttachMenu = useCallback(() => {
    setAttachMenuOpen(false);
    setStickerPickerOpen(false);
  }, []);

  const openStickerPicker = useCallback(() => {
    setAttachMenuOpen(false);
    setStickerPickerOpen(true);
  }, []);

  const sendSticker = useCallback(async (payload) => {
    if (!selectedPeer || composerDisabled) return;
    setFileTransfer({ stage: 'sending', percent: 60, detail: 'Sticker wird gesendet…' });
    try {
      const mime = payload.fileType || 'image/png';
      const withPreview = {
        ...payload,
        localPreviewUrl: payload.fileData ? `data:${mime};base64,${payload.fileData}` : undefined,
      };
      const result = await sendMessage(selectedPeer.id, withPreview);
      // Gruppen-Sends liefern ein Objekt ({ ok, error }), Direkt-Sends ein Boolean.
      const ok = result === true || result?.ok === true;
      if (!ok) {
        toast({ variant: 'error', title: 'Sticker nicht gesendet' });
      }
    } finally {
      setFileTransfer(null);
    }
  }, [selectedPeer, composerDisabled, sendMessage, setFileTransfer, toast]);

  const openFilePicker = useCallback((accept) => {
    closeAttachMenu();
    const input = accept === 'media' ? mediaInputRef.current : fileInputRef.current;
    if (!input) return;
    input.click();
  }, [closeAttachMenu]);

  const shareOwnContact = useCallback(async () => {
    if (!selectedPeer || !window.bluetalk) return;
    closeAttachMenu();
    try {
      const info = await window.bluetalk.peer.getInfo();
      const address =
        info?.endpoints?.[0]
        || (info?.addresses?.[0] && info?.port ? `${info.addresses[0]}:${info.port}` : '');
      const ok = await sendMessage(selectedPeer.id, {
        kind: 'contact-share',
        sharedContact: {
          id: info?.id,
          displayName: settings.displayName,
          bio: settings.bio || '',
          profilePicture: settings.profilePicture || '',
          address,
        },
      });
      if (ok) {
        toast({ variant: 'success', title: 'Kontakt geteilt' });
      } else {
        toast({ variant: 'error', title: 'Kontakt nicht gesendet', message: 'Peer ist evtl. offline oder blockiert.' });
      }
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Kontakt nicht gesendet',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  }, [selectedPeer, closeAttachMenu, sendMessage, settings.displayName, settings.bio, settings.profilePicture, toast]);

  const runPluginComposerAttachment = useCallback(async (item) => {
    if (!selectedPeer || !item?.onSelect) return;
    closeAttachMenu();
    try {
      await item.onSelect({
        peerId: selectedPeer.id,
        closeMenu: closeAttachMenu,
        sendMessage,
        toast,
        settings,
        contacts,
        peers,
        connectToAddress,
      });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Anhang fehlgeschlagen',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  }, [selectedPeer, closeAttachMenu, sendMessage, toast, settings, contacts, peers, connectToAddress]);

  const handleFilePicked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await queuePendingFile(file);
  };

  return (
    <>
      <input
        type="file"
        hidden
        ref={fileInputRef}
        onChange={handleFilePicked}
        disabled={composerDisabled || readingFile || sendingFile}
      />
      <input
        type="file"
        hidden
        ref={mediaInputRef}
        accept="image/*,video/*"
        onChange={handleFilePicked}
        disabled={composerDisabled || readingFile || sendingFile}
      />
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        ref={attachMenuBtnRef}
        aria-label="Anhang hinzufügen"
        aria-expanded={attachMenuOpen}
        aria-haspopup="menu"
        onClick={() => setAttachMenuOpen((o) => !o)}
        disabled={composerDisabled || readingFile || sendingFile}
        title="Anhang hinzufügen"
        style={{ height: 40, width: 40 }}
      >
        <Plus size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      </button>
      {attachMenuOpen &&
        createPortal(
          <div
            ref={attachMenuPanelRef}
            className="chat-list-context-menu chat-composer-attach-menu animate-scale"
            role="menu"
            style={{
              position: 'fixed',
              bottom: attachMenuPosition.bottom,
              left: attachMenuPosition.left,
              zIndex: 1250,
              minWidth: 248,
              maxHeight: 'min(360px, calc(100vh - 24px))',
              overflowY: 'auto',
            }}
          >
            {!isAiChatSelected ? (
              <button
                type="button"
                className="chat-list-context-menu-item"
                role="menuitem"
                onClick={() => openStickerPicker()}
              >
                <Smile size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Sticker
              </button>
            ) : null}
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => openFilePicker('file')}
            >
              <File size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Datei
            </button>
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => openFilePicker('media')}
            >
              <FileImage size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Bild / Video
            </button>
            {!isAiChatSelected ? (
              <button
                type="button"
                className="chat-list-context-menu-item"
                role="menuitem"
                onClick={() => void shareOwnContact()}
              >
                <UserRound size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Kontakt teilen
              </button>
            ) : null}
            {composerAttachments.length > 0 ? (
              <>
                <div className="chat-list-context-menu-sep" role="separator" />
                {composerAttachments.map((item) => {
                  const Icon = resolveLucideIcon(item.icon);
                  return (
                    <button
                      key={item.attachmentId}
                      type="button"
                      className="chat-list-context-menu-item"
                      role="menuitem"
                      onClick={() => void runPluginComposerAttachment(item)}
                    >
                      <Icon size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                      {item.label}
                    </button>
                  );
                })}
              </>
            ) : null}
          </div>,
          document.body
        )}
      <StickerPicker
        open={stickerPickerOpen}
        anchorRef={attachMenuBtnRef}
        onClose={() => setStickerPickerOpen(false)}
        onSelect={(payload) => void sendSticker(payload)}
        onError={(error) => toast({
          variant: 'error',
          title: 'Sticker konnte nicht erstellt werden',
          message: error?.message || 'Ungültige Bilddatei',
        })}
        disabled={composerDisabled || sendingFile}
      />
    </>
  );
}
