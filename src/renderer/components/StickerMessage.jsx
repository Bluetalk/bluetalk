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

export default function StickerMessage({ message }) {
  const src = getStickerUrl(message);
  if (!src) {
    return <div className="msg-sticker msg-sticker--pending">Sticker wird geladen…</div>;
  }

  return (
    <div className="msg-sticker">
      <img
        src={src}
        alt=""
        className="msg-sticker-img"
        loading="lazy"
        draggable={false}
      />
    </div>
  );
}
