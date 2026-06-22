import React from 'react';
import { validateStickerData } from '../stickers/stickerStore';

function getStickerUrl(message) {
  if (message?.localPreviewUrl) return message.localPreviewUrl;
  if (!message?.fileData) return '';
  try {
    const valid = validateStickerData(message);
    return `data:${valid.fileType};base64,${valid.fileData}`;
  } catch {
    return '';
  }
}

export default function StickerMessage({ message, onExpandImage }) {
  const src = getStickerUrl(message);
  if (!src) {
    return <div className="msg-sticker msg-sticker--pending">Sticker wird geladen…</div>;
  }

  const open = () => {
    onExpandImage?.({
      src,
      alt: message.fileName || 'Sticker',
      defaultFilename: message.fileName || 'sticker.png',
      base64: message.fileData || '',
    });
  };

  return (
    <div className="msg-sticker">
      <button type="button" className="msg-sticker-btn" onClick={open}>
        <img src={src} alt={message.fileName || 'Sticker'} loading="lazy" />
      </button>
    </div>
  );
}
