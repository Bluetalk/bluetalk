import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Archive,
  Ban,
  Copy,
  Lock,
  Unlock,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Film,
  MessageSquare,
  Music,
  Pencil,
  Pin,
  PinOff,
  FileBarChart,
  Plus,
  Plug,
  Save,
  Search,
  SendHorizontal,
  Smile,
  Trash2,
  Bell,
  BellOff,
  UserRound,
  X,
  MoreVertical,
  Reply,
  Forward,
  CheckSquare,
  ChevronRight,
} from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';
import StickerPicker from '../components/StickerPicker';
import StickerMessage from '../components/StickerMessage';
import VerticalResizeHandle from '../components/VerticalResizeHandle';
import { getEffectiveFlag, isContactNotificationMuted } from '../featureFlags';
import { pluginRuntime } from '../plugins/pluginRuntime';

const CHAT_ICON_STROKE = 1.75;

function resolveLucideIcon(name) {
  if (!name || typeof name !== 'string') return Plug;
  return {
    Plug,
    Plus,
    Smile,
    File,
    FileImage,
    FileText,
    Film,
    Music,
    MessageSquare,
  }[name] || Plug;
}

const MUTE_1H_MS = 60 * 60 * 1000;
const MUTE_8H_MS = 8 * MUTE_1H_MS;
const MUTE_24H_MS = 24 * MUTE_1H_MS;

function isContextMenuFlyoutTarget(target) {
  return target instanceof Element && Boolean(target.closest('.chat-list-context-menu-flyout-panel'));
}

function notificationMuteSelectValue(contact) {
  if (!contact || !isContactNotificationMuted(contact)) return 'off';
  if (contact.notifyMutedManual) return 'manual';
  return 'timed';
}

function formatMuteExpiry(ts) {
  if (typeof ts !== 'number') return '';
  return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

function formatMessageTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const main = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ms = String(Math.floor(ts % 1000)).padStart(3, '0');
  return `${main}.${ms}`;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function selfDeliveryLabel(m) {
  if (m.from !== 'self' || !m.messageId) return { text: '', pending: false };
  if (m.deliveryStatus === 'scheduled') return { text: 'Scheduled', pending: false };
  if (m.deliveryStatus === 'delivered') return { text: 'Delivered', pending: false };
  if (m.deliveryStatus === 'blocked') return { text: 'Blockiert', pending: false };
  if (m.deliveryStatus === 'pending') return { text: 'Sending', pending: true };
  return { text: '', pending: false };
}

/** Ausgehende Nachrichten gesperrt: eigener Block, Block durch Peer oder gelöschter Chat. */
function contactOutgoingBlocked(contact) {
  return Boolean(contact?.blocked || contact?.blockedByPeer || contact?.chatDeletedByPeer);
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function downloadJsonFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadBase64AsFile(fileName, base64) {
  const bin = atob(base64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function PeerAvatar({ pictureUrl, name, size = 36, className = '' }) {
  const initial = (name || '?')[0].toUpperCase();
  const dim = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (pictureUrl) {
    return (
      <img
        src={pictureUrl}
        alt=""
        className={`peer-avatar-img ${className}`}
        style={dim}
      />
    );
  }
  return (
    <div className={`list-item-avatar peer-avatar-fallback ${className}`} style={dim}>
      {initial}
    </div>
  );
}

const MAX_CHAT_FILE_SIZE_MB = 8;
const MAX_CHAT_FILE_SIZE_BYTES = MAX_CHAT_FILE_SIZE_MB * 1024 * 1024;
const CHAT_BATCH_SIZE = 24;

const CHAT_LIST_WIDTH_DEFAULT = 300;
const CHAT_LIST_WIDTH_MIN = 220;
const CHAT_LIST_WIDTH_MAX = 560;

const COMPOSER_TEXTAREA_MIN_HEIGHT = 40;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 400;

function getComposerTextareaMaxHeight() {
  if (typeof window === 'undefined') return COMPOSER_TEXTAREA_MAX_HEIGHT;
  return Math.min(COMPOSER_TEXTAREA_MAX_HEIGHT, Math.floor(window.innerHeight * 0.45));
}

function normalizeChatMarkdown(text) {
  return String(text || '').replace(/(?<!\n)\n(?!\n)/g, '  \n');
}

function getMessagePreviewText(message) {
  if (!message) return '';
  if (message.kind === 'sticker') return 'Sticker';
  if (message.kind === 'file') return `📎 ${message.fileName || message.content || 'Anhang'}`;
  if (message.kind === 'contact-share') {
    const name = message.sharedContact?.displayName || message.sharedContact?.name || 'Kontakt';
    return `Kontakt: ${name}`;
  }
  if (message.kind === 'poker-invite') return `Poker: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'uno-invite') return `UNO: ${message.tableName || 'Einladung'}`;
  const content = String(message.content || '').trim();
  if (!content) return 'Nachricht';
  return content.length > 120 ? `${content.slice(0, 117)}…` : content;
}

function buildForwardPayload(message) {
  if (!message) return { kind: 'chat', content: '' };
  if (message.kind === 'sticker' && message.fileData) {
    return {
      kind: 'sticker',
      content: message.content || 'Sticker',
      stickerId: message.stickerId,
      packId: message.packId,
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      fileData: message.fileData,
    };
  }
  if (message.kind === 'file' && message.fileData) {
    return {
      kind: 'file',
      content: message.content || message.fileName || 'Anhang',
      fileName: message.fileName,
      fileSize: message.fileSize,
      fileType: message.fileType,
      fileData: message.fileData,
    };
  }
  const preview = getMessagePreviewText(message);
  return { kind: 'chat', content: `↪ Weitergeleitet:\n${preview}` };
}

function getLastPreview(message) {
  if (!message) return 'No messages';
  if (message.kind === 'sticker') return `${message.from === 'self' ? 'Du: ' : ''}Sticker`;
  if (message.kind === 'file') return `File: ${message.fileName || message.content || 'Attachment'}`;
  if (message.kind === 'contact-share') {
    const name = message.sharedContact?.displayName || message.sharedContact?.name || 'Kontakt';
    return `${message.from === 'self' ? 'Du: ' : ''}Kontakt: ${name}`;
  }
  if (message.kind === 'poker-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}Poker: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'uno-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}UNO: ${message.tableName || 'Einladung'}`;
  }
  return (message.from === 'self' ? 'You: ' : '') + (message.content || 'Message');
}

function formatUnreadBadgeCount(n) {
  if (n <= 0) return '';
  if (n >= 10) return '9+';
  return String(n);
}

function peerProfileAddress(chat) {
  const saved = chat.contact?.address;
  if (saved) return saved;
  const p = chat.peer;
  if (p?.address != null && p?.port != null) return `${p.address}:${p.port}`;
  if (typeof p?.address === 'string') return p.address;
  return '';
}

function countUnreadPeerMessages(peerId, lastViewedTs, messagesByPeer, lastMessageMeta) {
  const bound = typeof lastViewedTs === 'number' ? lastViewedTs : 0;
  const arr = messagesByPeer[peerId] || [];
  let n = 0;
  for (const m of arr) {
    if (m.from !== 'self' && typeof m.timestamp === 'number' && m.timestamp > bound) n += 1;
  }
  if (
    n === 0
    && arr.length === 0
    && lastMessageMeta
    && lastMessageMeta.from !== 'self'
    && typeof lastMessageMeta.timestamp === 'number'
    && lastMessageMeta.timestamp > bound
  ) {
    n = 1;
  }
  return n;
}

/** Gespeicherte Präferenz pro Kontakt (Standard: E2EE an, außer `e2eeEnabled: false`). */
function contactE2eePreferenceOn(contact) {
  return contact?.e2eeEnabled !== false;
}

/**
 * Reads file as base64 with progress (0–1). Optional fast path uses readAsDataURL (often faster on large files).
 */
function readFileAsBase64WithProgress(file, onProgress, useFastDataUrl) {
  if (useFastDataUrl) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onprogress = (e) => {
        if (e.lengthComputable && typeof onProgress === 'function' && e.total > 0) {
          onProgress(Math.min(1, e.loaded / e.total));
        }
      };
      reader.onload = () => {
        try {
          const result = reader.result;
          if (typeof result !== 'string') {
            reject(new Error('Invalid read result'));
            return;
          }
          const comma = result.indexOf(',');
          if (comma < 0) {
            reject(new Error('Invalid data URL'));
            return;
          }
          const base64 = result.slice(comma + 1);
          onProgress?.(1);
          resolve({ dataUrl: result, base64 });
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === 'function' && e.total > 0) {
        onProgress(Math.min(0.72, (e.loaded / e.total) * 0.72));
      }
    };
    reader.onload = () => {
      try {
        const buf = reader.result;
        if (!(buf instanceof ArrayBuffer)) {
          reject(new Error('Invalid read result'));
          return;
        }
        const bytes = new Uint8Array(buf);
        const chunkSize = 32768;
        let binary = '';
        const len = bytes.length;
        for (let offset = 0; offset < len; offset += chunkSize) {
          const slice = bytes.subarray(offset, Math.min(offset + chunkSize, len));
          binary += String.fromCharCode.apply(null, slice);
          if (typeof onProgress === 'function' && len > chunkSize && offset > 0 && offset % (chunkSize * 12) < chunkSize) {
            onProgress(0.72 + (offset / len) * 0.26);
          }
        }
        const base64 = btoa(binary);
        const mime = file.type || 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${base64}`;
        onProgress?.(1);
        resolve({ dataUrl, base64 });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

const EXT_TO_IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/** Browsers often omit `image/*` (empty type → octet-stream); pick a concrete image/* for data URLs. */
function imageMimeForFile(mime, fileName) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return m;
  if (m && m !== 'application/octet-stream') return '';
  const ext = extOf(fileName);
  return EXT_TO_IMAGE_MIME[ext] || '';
}

function getFileBlobUrl(message) {
  if (!message || message.kind !== 'file') return '';
  if (message.localPreviewUrl) return message.localPreviewUrl;
  if (!message.fileData) return '';
  const mime = message.fileType || 'application/octet-stream';
  const category = getFileCategory(mime, message.fileName);
  const type =
    category === 'image' ? imageMimeForFile(mime, message.fileName) || mime : mime;
  return `data:${type};base64,${message.fileData}`;
}

function getImageUrl(message) {
  if (!message) return '';

  if (message.kind === 'file') {
    const mime = message.fileType || 'application/octet-stream';
    const category = getFileCategory(mime, message.fileName);
    if (category !== 'image') return '';
    if (message.localPreviewUrl) return message.localPreviewUrl;
    if (!message.fileData) return '';
    const imageMime = imageMimeForFile(mime, message.fileName);
    if (!imageMime) return '';
    return `data:${imageMime};base64,${message.fileData}`;
  }

  const content = String(message.content || '').trim();
  if (!content) return '';
  if (content.startsWith('data:image/')) return content;
  if (/^https?:\/\/\S+\.(png|jpe?g|gif|webp|bmp|svg)(\?\S*)?$/i.test(content)) return content;
  return '';
}

function extOf(name) {
  const i = String(name || '').lastIndexOf('.');
  if (i <= 0) return '';
  return String(name).slice(i + 1).toLowerCase();
}

function getFileCategory(mime, fileName) {
  const m = String(mime || '').toLowerCase();
  const ext = extOf(fileName);

  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';

  if (!m || m === 'application/octet-stream') {
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'ogg', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus'].includes(ext)) return 'audio';
  }

  return 'other';
}

/** Bild-Only-Nachrichten: ohne Sprechblasen-Hintergrund, direkt im Verlauf */
function isBareMediaMessage(message) {
  if (!message) return false;
  if (message.kind === 'sticker') {
    return Boolean(message.fileData || message.localPreviewUrl);
  }
  if (message.kind === 'file') {
    const mime = message.fileType || 'application/octet-stream';
    if (getFileCategory(mime, message.fileName) !== 'image') return false;
    return Boolean(getImageUrl(message));
  }
  return Boolean(getImageUrl(message));
}

/** Rich-Embeds (Poker, Kontakt, …): ohne Sprechblasen-Karte */
function isChatEmbedMessage(message) {
  if (!message) return false;
  return message.kind === 'poker-invite' || message.kind === 'uno-invite' || message.kind === 'contact-share';
}

function FileTypeIcon({ mime, fileName, size = 22 }) {
  const m = String(mime || '').toLowerCase();
  const ext = extOf(fileName);
  const stroke = CHAT_ICON_STROKE;
  const common = { size, strokeWidth: stroke, 'aria-hidden': true };

  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
    return <FileImage {...common} />;
  }
  if (m.startsWith('video/')) return <Film {...common} />;
  if (m.startsWith('audio/')) return <Music {...common} />;
  if (m === 'application/pdf' || ext === 'pdf') return <FileType {...common} />;
  if (
    m.includes('zip') ||
    m.includes('rar') ||
    m.includes('7z') ||
    m.includes('tar') ||
    m.includes('gzip') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'].includes(ext)
  ) {
    return <Archive {...common} />;
  }
  if (m.includes('spreadsheet') || m.includes('excel') || ['xls', 'xlsx', 'csv', 'ods'].includes(ext)) {
    return <FileSpreadsheet {...common} />;
  }
  if (m.includes('presentation') || ['ppt', 'pptx', 'odp'].includes(ext)) {
    return <FileBarChart {...common} />;
  }
  if (m.startsWith('text/') || ['txt', 'md', 'rtf'].includes(ext)) {
    return <FileText {...common} />;
  }
  if (
    ['json', 'js', 'jsx', 'ts', 'tsx', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'rs', 'go', 'py', 'java', 'c', 'cpp', 'h'].includes(
      ext
    )
  ) {
    return <FileCode {...common} />;
  }
  return <File {...common} />;
}

function FileMessage({ message, bareLayout = false, onExpandImage, onSaveToDisk }) {
  const dataUrl = getFileBlobUrl(message);
  const mime = message.fileType || 'application/octet-stream';
  const category = getFileCategory(mime, message.fileName);
  const imageUrl = category === 'image' ? getImageUrl(message) : '';
  const hasPayload = Boolean(dataUrl && (message.fileData || message.localPreviewUrl));
  const showImagePreview = category === 'image' && !!imageUrl;
  const showIconRow =
    category === 'other' || (category === 'image' && !imageUrl) || ((category === 'video' || category === 'audio') && !hasPayload);
  const showMediaFooter = (category === 'video' || category === 'audio') && hasPayload;
  const showImageMeta = showImagePreview;

  const openImage = () => {
    if (!imageUrl) return;
    onExpandImage?.({
      src: imageUrl,
      alt: message.fileName || 'Bildanhang',
      defaultFilename: message.fileName || 'Bild',
      base64: message.fileData || '',
    });
  };

  const iconRowInner = (
    <>
      <div className="msg-file-icon-wrap">
        <FileTypeIcon mime={mime} fileName={message.fileName} />
      </div>
      <div className="msg-file-meta-block">
        <div className="msg-file-name" title={message.fileName || ''}>
          {message.fileName || 'Anhang'}
        </div>
        <div className="msg-file-size">{formatSize(message.fileSize || 0)}</div>
      </div>
    </>
  );

  if (bareLayout && showImagePreview) {
    return (
      <div className="msg-bare-media-stack">
        <button type="button" className="msg-bare-image-link" onClick={openImage}>
          <img src={imageUrl} alt={message.fileName || 'Bildanhang'} className="msg-file-image" loading="lazy" />
        </button>
        {(message.fileName || message.fileSize) && (
          <div className="msg-bare-media-caption">
            <span className="msg-bare-caption-name" title={message.fileName || ''}>
              {message.fileName || 'Bildanhang'}
              {message.fileSize ? ` · ${formatSize(message.fileSize)}` : ''}
            </span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={`msg-file msg-file--${category}`}>
      {showImagePreview && (
        <button type="button" className="msg-file-image-link" onClick={openImage}>
          <img src={imageUrl} alt={message.fileName || 'Bildanhang'} className="msg-file-image" loading="lazy" />
        </button>
      )}

      {category === 'video' && hasPayload && (
        <video src={dataUrl} controls playsInline className="msg-file-video" preload="metadata" />
      )}

      {category === 'audio' && hasPayload && (
        <audio src={dataUrl} controls className="msg-file-audio" preload="metadata" />
      )}

      {showIconRow &&
        (message.fileData ? (
          <button type="button" className="msg-file-row msg-file-save-trigger" onClick={() => onSaveToDisk?.(message)}>
            {iconRowInner}
          </button>
        ) : (
          <div className="msg-file-row">{iconRowInner}</div>
        ))}

      {showImageMeta && (
        <div className="msg-file-footer msg-file-footer--image">
          <div className="msg-file-meta-block msg-file-meta-block--grow">
            <div className="msg-file-name" title={message.fileName || ''}>
              {message.fileName || 'Anhang'}
            </div>
            <div className="msg-file-size">{formatSize(message.fileSize || 0)}</div>
          </div>
        </div>
      )}

      {showMediaFooter && (
        <div className="msg-file-footer">
          <div className="msg-file-meta-block msg-file-meta-block--grow">
            <div className="msg-file-name" title={message.fileName || ''}>
              {message.fileName || 'Anhang'}
            </div>
            <div className="msg-file-size">{formatSize(message.fileSize || 0)}</div>
          </div>
          {message.fileData && (
            <button
              type="button"
              className="btn btn-secondary btn-sm msg-file-save-inline"
              onClick={() => onSaveToDisk?.(message)}
            >
              Speichern unter…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MarkdownBody({ text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return (
    <div className="msg-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            src?.startsWith('data:') || src?.startsWith('blob:') ? (
              <img src={src} alt={alt || ''} className="msg-md-inline-img" loading="lazy" />
            ) : (
              <a href={src} target="_blank" rel="noopener noreferrer" className="msg-md-external-img-link">
                {alt || src || 'Image'}
              </a>
            ),
        }}
      >
        {normalizeChatMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}

function ContactShareMessage({ message, onConnect, isConnected }) {
  const shared = message.sharedContact || {};
  const name = shared.displayName || shared.name || shared.id || 'Kontakt';
  const address = (shared.address || '').trim();
  return (
    <div className="contact-share-card" role="group" aria-label="Geteilter Kontakt">
      <div className="contact-share-card-head">
        <PeerAvatar pictureUrl={shared.profilePicture} name={name} size={44} />
        <div className="min-w-0">
          <div className="contact-share-card-title">{name}</div>
          {shared.id && shared.id !== name ? (
            <div className="contact-share-card-meta font-mono text-xs">{shared.id}</div>
          ) : null}
          {shared.bio ? <div className="contact-share-card-bio">{shared.bio}</div> : null}
          {address ? <div className="contact-share-card-meta font-mono text-xs">{address}</div> : null}
        </div>
      </div>
      {address && !isConnected ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => onConnect?.(address, shared.id)}
        >
          Verbinden
        </button>
      ) : null}
    </div>
  );
}

function PokerInviteMessage({ message }) {
  const navigate = useNavigate();
  const tableName = message.tableName || 'Poker-Tisch';
  const settings = message.pokerSettings || {};
  const summary = message.pokerSettingsSummary || message.content || '';
  const smallBlind = Number(settings.smallBlind) || 10;
  const bigBlind = Number(settings.bigBlind) || 20;
  const maxPlayers = Number(settings.maxPlayers) || 6;
  const startingChips = Number(settings.startingChips) || 2000;

  const joinTable = () => {
    try {
      sessionStorage.setItem(
        'bt.poker.pendingJoin',
        JSON.stringify({
          hostPeerId: message.hostPeerId,
          tableId: message.tableId,
          tableName,
          pokerSettings: settings,
        })
      );
    } catch {
      /* ignore */
    }
    navigate(`/plugin/${encodeURIComponent('poker:table')}`);
    void window.bluetalk?.poker?.openGameWindow?.();
  };

  return (
    <div className="poker-invite-card" role="group" aria-label="Poker-Einladung">
      <div className="poker-invite-card-head">
        <span className="poker-invite-card-icon" aria-hidden>
          ♠
        </span>
        <div className="poker-invite-card-copy">
          <div className="poker-invite-card-kicker">Texas Hold&apos;em</div>
          <div className="poker-invite-card-title">{tableName}</div>
          {summary ? <div className="poker-invite-card-meta">{summary}</div> : null}
        </div>
      </div>
      <dl className="poker-invite-card-stats">
        <div>
          <dt>Blinds</dt>
          <dd>{smallBlind}/{bigBlind}</dd>
        </div>
        <div>
          <dt>Plätze</dt>
          <dd>max. {maxPlayers}</dd>
        </div>
        <div>
          <dt>Start</dt>
          <dd>{startingChips.toLocaleString('de-DE')} Chips</dd>
        </div>
      </dl>
      <p className="poker-invite-card-hint">Peer-to-Peer am Tisch — du musst mit dem Host verbunden sein.</p>
      <button
        type="button"
        className="poker-invite-card-btn"
        onClick={joinTable}
      >
        Tisch beitreten
      </button>
    </div>
  );
}

function UnoInviteMessage({ message }) {
  const navigate = useNavigate();
  const tableName = message.tableName || 'UNO-Tisch';
  const settings = message.unoSettings || {};
  const summary = message.unoSettingsSummary || message.content || '';
  const maxPlayers = Number(settings.maxPlayers) || 4;
  const gameMode = settings.gameMode === 'points'
    ? `Punkte bis ${Number(settings.targetScore) || 500}`
    : 'Einzelrunde';
  const houseRules = settings.houseRules === 'casual' ? 'Casual' : 'Offiziell';

  const joinGame = () => {
    try {
      sessionStorage.setItem(
        'bt.uno.pendingJoin',
        JSON.stringify({
          hostPeerId: message.hostPeerId,
          gameId: message.gameId,
          tableName,
          unoSettings: settings,
        })
      );
    } catch {
      /* ignore */
    }
    navigate(`/plugin/${encodeURIComponent('uno:game')}`);
    void window.bluetalk?.uno?.openGameWindow?.();
  };

  return (
    <div className="uno-invite-card" role="group" aria-label="UNO-Einladung">
      <div className="uno-invite-card-head">
        <span className="uno-invite-card-icon" aria-hidden>🎴</span>
        <div className="uno-invite-card-copy">
          <div className="uno-invite-card-kicker">UNO</div>
          <div className="uno-invite-card-title">{tableName}</div>
          {summary ? <div className="uno-invite-card-meta">{summary}</div> : null}
        </div>
      </div>
      <dl className="uno-invite-card-stats">
        <div>
          <dt>Plätze</dt>
          <dd>max. {maxPlayers}</dd>
        </div>
        <div>
          <dt>Modus</dt>
          <dd>{gameMode}</dd>
        </div>
        <div>
          <dt>Regeln</dt>
          <dd>{houseRules}</dd>
        </div>
      </dl>
      <p className="uno-invite-card-hint">Peer-to-Peer — du musst mit dem Host verbunden sein.</p>
      <p className="uno-invite-card-alpha" role="note">Alpha: Das UNO-Plugin kann noch Fehler haben und sich ändern.</p>
      <button type="button" className="uno-invite-card-btn" onClick={joinGame}>
        Spiel beitreten
      </button>
    </div>
  );
}

function MessageReplyQuote({ replyTo, isSelf }) {
  if (!replyTo) return null;
  return (
    <div className={`msg-reply-quote${isSelf ? ' msg-reply-quote--self' : ''}`}>
      <span className="msg-reply-quote-sender">{replyTo.sender || 'Nachricht'}</span>
      <span className="msg-reply-quote-text">{replyTo.preview || ''}</span>
    </div>
  );
}

function ContextMenuHoverSubmenu({ label, icon: Icon, children }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const hideTimerRef = useRef(null);
  const triggerRef = useRef(null);
  const flyoutRef = useRef(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const flyoutWidth = 272;
    const pad = 8;
    const overlap = 4;
    let left = r.right - overlap;
    if (left + flyoutWidth > window.innerWidth - pad) {
      left = r.left - flyoutWidth + overlap;
    }
    left = Math.min(left, window.innerWidth - flyoutWidth - pad);
    left = Math.max(pad, left);
    setPosition({ top: r.top, left });
  }, []);

  const showSubmenu = useCallback(() => {
    clearHideTimer();
    updatePosition();
    setOpen(true);
  }, [clearHideTimer, updatePosition]);

  const hideSubmenu = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => setOpen(false), 140);
  }, [clearHideTimer]);

  useLayoutEffect(() => {
    if (!open || !flyoutRef.current) return;
    const panel = flyoutRef.current;
    const pr = panel.getBoundingClientRect();
    const pad = 8;
    if (pr.bottom > window.innerHeight - pad) {
      setPosition((prev) => ({
        ...prev,
        top: Math.max(pad, prev.top - (pr.bottom - window.innerHeight + pad)),
      }));
    }
  }, [open, children]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  return (
    <>
      <div
        ref={triggerRef}
        className={[
          'chat-list-context-menu-item',
          'chat-list-context-menu-item--submenu-trigger',
          open && 'chat-list-context-menu-item--submenu-open',
        ]
          .filter(Boolean)
          .join(' ')}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseEnter={showSubmenu}
        onMouseLeave={hideSubmenu}
        onClick={(e) => {
          e.stopPropagation();
          if (open) hideSubmenu();
          else showSubmenu();
        }}
      >
        <Icon size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        {label}
        <ChevronRight size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden className="chat-list-context-menu-chevron" />
      </div>
      {open
        ? createPortal(
            <div
              ref={flyoutRef}
              className="chat-list-context-menu chat-list-context-menu-flyout-panel animate-scale"
              role="menu"
              style={{
                position: 'fixed',
                top: position.top,
                left: position.left,
                zIndex: 1260,
                minWidth: 260,
                maxHeight: 'min(420px, calc(100vh - 24px))',
                overflowY: 'auto',
              }}
              onMouseEnter={clearHideTimer}
              onMouseLeave={hideSubmenu}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {children}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function NotificationMuteMenuItems({ contact, contactId, onDone, applyNotificationMute }) {
  return (
    <>
      {isContactNotificationMuted(contact) ? (
        <button
          type="button"
          className="chat-list-context-menu-item"
          role="menuitem"
          onClick={() => {
            applyNotificationMute(contactId, 'off');
            onDone?.();
          }}
        >
          <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          Mitteilungen ein
        </button>
      ) : null}
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          applyNotificationMute(contactId, '1h');
          onDone?.();
        }}
      >
        <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        1 Std. Mitteilungen stumm
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          applyNotificationMute(contactId, '8h');
          onDone?.();
        }}
      >
        <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        8 Std. Mitteilungen stumm
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          applyNotificationMute(contactId, '24h');
          onDone?.();
        }}
      >
        <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        24 Std. Mitteilungen stumm
      </button>
      <button
        type="button"
        className="chat-list-context-menu-item"
        role="menuitem"
        onClick={() => {
          applyNotificationMute(contactId, 'manual');
          onDone?.();
        }}
      >
        <Bell size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        Mitteilungen stumm bis manuell ein
      </button>
      {notificationMuteSelectValue(contact) === 'timed' &&
      typeof contact?.notifyMutedUntil === 'number' ? (
        <div className="chat-header-peer-menu-hint text-xs text-muted">
          Stumm bis {formatMuteExpiry(contact.notifyMutedUntil)}
        </div>
      ) : null}
    </>
  );
}

function ChatMessage({ message, onExpandImage }) {
  const imageUrl = getImageUrl(message);
  if (imageUrl) {
    const open = () => {
      const base64 = imageUrl.startsWith('data:') ? imageUrl.split(',')[1] || '' : '';
      onExpandImage?.({
        src: imageUrl,
        alt: 'Geteiltes Bild',
        defaultFilename: 'Bild',
        base64,
      });
    };

    return (
      <>
        <MessageReplyQuote replyTo={message.replyTo} isSelf={message.from === 'self'} />
        <button type="button" className="msg-inline-image-link" onClick={open}>
          <img src={imageUrl} alt="Geteiltes Bild" className="msg-inline-image" />
        </button>
      </>
    );
  }

  return (
    <>
      <MessageReplyQuote replyTo={message.replyTo} isSelf={message.from === 'self'} />
      <MarkdownBody text={message.content} />
    </>
  );
}

function MediaLightbox({ open, src, alt, canSave, onClose, onSave }) {
  if (!open) return null;
  return (
    <div
      className="media-lightbox-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Medienvorschau"
    >
      <div
        className="media-lightbox-toolbar"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {canSave ? (
          <button
            type="button"
            className="media-lightbox-save"
            onClick={(e) => {
              e.stopPropagation();
              onSave();
            }}
          >
            <Save size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden className="media-lightbox-save-icon" />
            <span>Speichern unter…</span>
          </button>
        ) : (
          <span className="media-lightbox-toolbar-spacer" aria-hidden />
        )}
        <button
          type="button"
          className="btn btn-ghost btn-icon media-lightbox-close"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Schließen"
        >
          <X size={22} strokeWidth={CHAT_ICON_STROKE} />
        </button>
      </div>
      <div className="media-lightbox-stage" onClick={(e) => e.stopPropagation()}>
        <img src={src} alt={alt} className="media-lightbox-img" />
      </div>
    </div>
  );
}

export default function ChatsPage() {
  const { toast } = useToast();
  const {
    peers,
    contacts,
    chatMeta,
    loadedChats,
    messages,
    settings,
    peerReadReceipts,
    chatLastViewedPeerTs,
    markPeerChatViewed,
    sendMessage,
    sendReadReceipt,
    loadChatMessages,
    connectToAddress,
    setContactNickname,
    setChatPinned,
    setContactE2eeEnabled,
    setContactBlocked,
    setContactNotificationMute,
    deleteChat,
    deleteMessage,
    updateSettings,
  } = useApp();

  const location = useLocation();
  const navigate = useNavigate();

  const [selectedPeerId, setSelectedPeerId] = useState(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [warning, setWarning] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [showConnect, setShowConnect] = useState(false);
  const [connectAddress, setConnectAddress] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [showNickname, setShowNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTargetPeerId, setDeleteTargetPeerId] = useState(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [listContextMenu, setListContextMenu] = useState(null);

  const [pendingFile, setPendingFile] = useState(null);
  /** null | { stage: 'reading' | 'sending', percent: number, detail: string } */
  const [fileTransfer, setFileTransfer] = useState(null);
  const [mediaLightbox, setMediaLightbox] = useState(null);
  const [showPeerProfile, setShowPeerProfile] = useState(false);
  const [chatActionsMenuOpen, setChatActionsMenuOpen] = useState(false);
  const [chatMenuPosition, setChatMenuPosition] = useState({ top: 0, left: 0 });
  const chatActionsMenuBtnRef = useRef(null);
  const chatActionsMenuPanelRef = useRef(null);

  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [stickerPickerOpen, setStickerPickerOpen] = useState(false);
  const [attachMenuPosition, setAttachMenuPosition] = useState({ bottom: 0, left: 0 });
  const attachMenuBtnRef = useRef(null);
  const attachMenuPanelRef = useRef(null);
  const [composerAttachments, setComposerAttachments] = useState(() => pluginRuntime.listComposerAttachments());

  const [messageContextMenu, setMessageContextMenu] = useState(null);
  const messageContextMenuRef = useRef(null);
  const [replyToMessage, setReplyToMessage] = useState(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState(() => new Set());
  const [forwardDialog, setForwardDialog] = useState(null);
  const [forwardingMessages, setForwardingMessages] = useState(false);

  const resizableUi = getEffectiveFlag(settings, 'resizableUi');
  const storedChatList = settings.uiResize?.chatList;
  const chatListCommitted =
    typeof storedChatList === 'number'
      ? Math.min(CHAT_LIST_WIDTH_MAX, Math.max(CHAT_LIST_WIDTH_MIN, storedChatList))
      : CHAT_LIST_WIDTH_DEFAULT;
  const [chatListPreview, setChatListPreview] = useState(null);
  const chatListDragRef = useRef(chatListCommitted);
  useEffect(() => {
    chatListDragRef.current = chatListCommitted;
  }, [chatListCommitted]);
  const chatListWidthPx = resizableUi ? chatListPreview ?? chatListCommitted : undefined;

  const onChatListResizeBegin = useCallback(() => {
    chatListDragRef.current = chatListPreview ?? chatListCommitted;
  }, [chatListPreview, chatListCommitted]);

  const onChatListResizeDelta = useCallback((dx) => {
    chatListDragRef.current = Math.min(
      CHAT_LIST_WIDTH_MAX,
      Math.max(CHAT_LIST_WIDTH_MIN, chatListDragRef.current + dx)
    );
    setChatListPreview(chatListDragRef.current);
  }, []);

  const commitChatListWidth = useCallback(() => {
    const w = chatListDragRef.current;
    if (w !== chatListCommitted) {
      updateSettings({ uiResize: { chatList: w } });
    }
    setChatListPreview(null);
  }, [chatListCommitted, updateSettings]);

  const resetChatListWidth = useCallback(() => {
    setChatListPreview(null);
    updateSettings({ uiResize: { chatList: CHAT_LIST_WIDTH_DEFAULT } });
  }, [updateSettings]);

  const pendingFileRef = useRef(null);
  useEffect(() => {
    pendingFileRef.current = pendingFile;
  }, [pendingFile]);

  useEffect(() => () => {
    const p = pendingFileRef.current;
    if (p?.objectUrl) {
      try {
        URL.revokeObjectURL(p.objectUrl);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const clearPendingFile = useCallback(() => {
    setPendingFile((prev) => {
      if (prev?.objectUrl) {
        try {
          URL.revokeObjectURL(prev.objectUrl);
        } catch {
          /* ignore */
        }
      }
      return null;
    });
  }, []);

  const endRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const textareaRef = useRef(null);
  const lastReadSentRef = useRef({});
  const listContextMenuRef = useRef(null);

  const readingFile = fileTransfer?.stage === 'reading';
  const sendingFile = fileTransfer?.stage === 'sending';

  const contactById = useMemo(() => {
    const map = new Map();
    for (const c of contacts) {
      if (c?.id) map.set(c.id, c);
    }
    return map;
  }, [contacts]);

  const peerById = useMemo(() => {
    const map = new Map();
    for (const p of peers) {
      if (p?.id) map.set(p.id, p);
    }
    return map;
  }, [peers]);

  const resolveContact = useCallback(
    (peerId) => (peerId ? contactById.get(peerId) ?? null : null),
    [contactById]
  );

  const chatList = useMemo(() => {
    const ids = new Set([
      ...contacts.map((c) => c.id),
      ...peers.map((p) => p.id),
      ...Object.keys(chatMeta || {}),
    ]);
    ids.delete('self');

    const list = [];
    for (const id of ids) {
      const peer = peerById.get(id) || null;
      const contact = contactById.get(id) || null;
      const meta = chatMeta[id] || null;
      const baseName = contact?.name || peer?.name || id;
      const profilePicture = contact?.profilePicture || peer?.profilePicture || '';
      const bio = contact?.bio ?? peer?.bio ?? '';

      list.push({
        id,
        peer,
        contact,
        displayName: contact?.nickname || baseName,
        baseName,
        profilePicture,
        bio,
        offline: !peer,
        pinned: Boolean(contact?.pinned),
        e2eePlaintextBadge: contact?.e2eeEnabled === false,
        lastMessage: meta?.lastMessage || null,
        messageCount: meta?.count || 0,
      });
    }

    return list.sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      const aTs = a.lastMessage?.timestamp || a.contact?.addedAt || 0;
      const bTs = b.lastMessage?.timestamp || b.contact?.addedAt || 0;
      return bTs - aTs;
    });
  }, [chatMeta, contactById, contacts, peerById, peers]);

  const mainChatList = useMemo(
    () =>
      chatList.filter((chat) => {
        if (chat.contact?.pendingMessageRequest === true) return false;
        if (
          chat.messageCount === 0
          && !chat.contact?.hasOutgoing
          && !chat.contact?.blocked
          && !chat.contact?.blockedByPeer
        ) {
          return false;
        }
        return true;
      }),
    [chatList]
  );

  const filtered = useMemo(
    () => mainChatList.filter((chat) =>
      `${chat.displayName} ${chat.baseName} ${chat.id}`.toLowerCase().includes(search.toLowerCase())
    ),
    [mainChatList, search]
  );

  const selectedPeer = useMemo(
    () => chatList.find((c) => c.id === selectedPeerId) || null,
    [chatList, selectedPeerId]
  );

  const selectedContact = useMemo(
    () => (selectedPeer ? resolveContact(selectedPeer.id) : null),
    [selectedPeer, resolveContact]
  );

  const peerPendingDelete = useMemo(
    () => (deleteTargetPeerId ? chatList.find((c) => c.id === deleteTargetPeerId) || null : null),
    [chatList, deleteTargetPeerId]
  );

  const closeListContextMenu = useCallback(() => setListContextMenu(null), []);

  const openPeerFromNav = location.state?.openPeerId;
  useEffect(() => {
    if (!openPeerFromNav) return;
    setSelectedPeerId(openPeerFromNav);
    navigate('.', { replace: true, state: {} });
  }, [openPeerFromNav, navigate]);

  useEffect(() => {
    if (openPeerFromNav) return;
    if (selectedPeerId != null) return;
    const first = mainChatList[0];
    if (first) setSelectedPeerId(first.id);
  }, [openPeerFromNav, selectedPeerId, mainChatList]);

  useEffect(() => {
    setChatActionsMenuOpen(false);
    setAttachMenuOpen(false);
    setMessageContextMenu(null);
    setReplyToMessage(null);
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, [selectedPeerId]);

  useEffect(() => {
    const off = pluginRuntime.onComposerAttachmentsChanged((items) => {
      setComposerAttachments(items);
    });
    setComposerAttachments(pluginRuntime.listComposerAttachments());
    return off;
  }, []);

  useLayoutEffect(() => {
    if (!chatActionsMenuOpen || !chatActionsMenuBtnRef.current) return;
    const r = chatActionsMenuBtnRef.current.getBoundingClientRect();
    const menuWidth = 288;
    const left = Math.min(Math.max(8, r.right - menuWidth), window.innerWidth - menuWidth - 8);
    setChatMenuPosition({ top: r.bottom + 6, left });
  }, [chatActionsMenuOpen]);

  const closeMessageContextMenu = useCallback(() => setMessageContextMenu(null), []);

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  }, []);

  const startSelectionMode = useCallback(() => {
    setChatActionsMenuOpen(false);
    setMessageContextMenu(null);
    setSelectionMode(true);
    setSelectedMessageIds(new Set());
  }, []);

  const toggleSelectedMessage = useCallback((messageId) => {
    if (!messageId) return;
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const openMessageContextMenu = useCallback((e, message) => {
    if (selectionMode) return;
    if (!message?.messageId) return;
    e.preventDefault();
    e.stopPropagation();
    const pad = 8;
    const mw = 220;
    const mh = 180;
    let x = e.clientX;
    let y = e.clientY;
    if (x + mw > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - mw - pad);
    if (y + mh > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - mh - pad);
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    setMessageContextMenu({ message, x, y });
  }, [selectionMode]);

  useEffect(() => {
    if (!messageContextMenu) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeMessageContextMenu();
    };
    document.addEventListener('keydown', onKey);
    let onDown = null;
    const id = window.setTimeout(() => {
      onDown = (e) => {
        if (messageContextMenuRef.current?.contains(e.target)) return;
        closeMessageContextMenu();
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [messageContextMenu, closeMessageContextMenu]);

  useEffect(() => {
    if (!selectionMode) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') exitSelectionMode();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selectionMode, exitSelectionMode]);

  useEffect(() => {
    if (!chatActionsMenuOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setChatActionsMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    let onDown = null;
    const id = window.setTimeout(() => {
      onDown = (e) => {
        const t = e.target;
        if (chatActionsMenuBtnRef.current?.contains(t)) return;
        if (chatActionsMenuPanelRef.current?.contains(t)) return;
        if (isContextMenuFlyoutTarget(t)) return;
        setChatActionsMenuOpen(false);
      };
      document.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [chatActionsMenuOpen]);

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

  const msgs = selectedPeer ? messages[selectedPeer.id] || [] : [];
  const readUpToId = selectedPeer ? peerReadReceipts[selectedPeer.id] : null;
  const hasMoreMessages = selectedPeer ? selectedPeer.messageCount > msgs.length : false;
  const newestTimestamp = msgs[msgs.length - 1]?.timestamp || 0;

  const showOfflineComposerReconnect = Boolean(
    selectedPeer &&
      !selectedPeer.peer &&
      !selectedPeer.contact?.blocked
  );
  const offlineReconnectAddress = useMemo(() => {
    if (!selectedPeer || selectedPeer.peer) return '';
    return (peerProfileAddress(selectedPeer) || '').trim();
  }, [selectedPeer]);

  useEffect(() => {
    if (!showOfflineComposerReconnect || !offlineReconnectAddress) return undefined;
    let cancelled = false;
    let busy = false;
    const attempt = async () => {
      if (cancelled || busy) return;
      busy = true;
      try {
        await connectToAddress(offlineReconnectAddress);
      } catch {
        /* Peer weiter offline — kein Toast */
      } finally {
        if (!cancelled) {
          busy = false;
        }
      }
    };
    void attempt();
    window.addEventListener('online', attempt);
    return () => {
      cancelled = true;
      window.removeEventListener('online', attempt);
    };
  }, [showOfflineComposerReconnect, offlineReconnectAddress, connectToAddress]);

  const closeAttachMenu = useCallback(() => {
    setAttachMenuOpen(false);
    setStickerPickerOpen(false);
  }, []);

  const openStickerPicker = useCallback(() => {
    setAttachMenuOpen(false);
    setStickerPickerOpen(true);
  }, []);

  const composerDisabled = Boolean(
    !selectedPeer
      || contactOutgoingBlocked(selectedPeer?.contact)
      || showOfflineComposerReconnect
  );

  const sendSticker = useCallback(async (payload) => {
    if (!selectedPeer || composerDisabled) return;
    setFileTransfer({ stage: 'sending', percent: 60, detail: 'Sticker wird gesendet…' });
    try {
      const mime = payload.fileType || 'image/png';
      const withPreview = {
        ...payload,
        localPreviewUrl: payload.fileData ? `data:${mime};base64,${payload.fileData}` : undefined,
      };
      const ok = await sendMessage(selectedPeer.id, withPreview);
      if (!ok) {
        toast({ variant: 'error', title: 'Sticker nicht gesendet' });
      }
    } finally {
      setFileTransfer(null);
    }
  }, [selectedPeer, composerDisabled, sendMessage, toast]);

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

  const connectFromSharedContact = useCallback(async (address, peerId) => {
    if (!address?.trim()) return;
    try {
      const peerInfo = await connectToAddress(address.trim());
      if (peerId) setSelectedPeerId(peerId);
      else if (peerInfo?.id) setSelectedPeerId(peerInfo.id);
      toast({ variant: 'success', title: 'Verbunden' });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Verbindung fehlgeschlagen',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  }, [connectToAddress, toast]);

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

  useEffect(() => {
    if (selectedPeerId && !chatList.find((chat) => chat.id === selectedPeerId)) {
      setSelectedPeerId(null);
    }
  }, [chatList, selectedPeerId]);

  useEffect(() => {
    setShowPeerProfile(false);
  }, [selectedPeerId]);

  useEffect(() => {
    if (!showPeerProfile) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setShowPeerProfile(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showPeerProfile]);

  useEffect(() => {
    let cancelled = false;

    async function ensureMessages() {
      if (!selectedPeerId) return;
      if (loadedChats[selectedPeerId]) return;
      if (!(chatMeta[selectedPeerId]?.count > 0)) return;

      setLoadingMessages(true);
      try {
        await loadChatMessages(selectedPeerId, { reset: true, limit: CHAT_BATCH_SIZE });
      } catch (e) {
        if (!cancelled) {
          toast({
            variant: 'error',
            title: 'Could not load messages',
            message: e?.message || 'Check storage permissions or try again.',
          });
        }
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    }

    ensureMessages();
    return () => {
      cancelled = true;
    };
  }, [chatMeta, loadChatMessages, loadedChats, selectedPeerId, toast]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [newestTimestamp, selectedPeerId]);

  const showUnreadListBadges = getEffectiveFlag(settings, 'chatUnreadListBadges');
  const contactNotificationMuteOn = getEffectiveFlag(settings, 'contactNotificationMute');

  useEffect(() => {
    if (!showUnreadListBadges || !selectedPeerId) return;
    const peerMsgs = messages[selectedPeerId] || [];
    const upTo = peerMsgs.reduce((acc, m) => {
      if (m.from !== 'self' && typeof m.timestamp === 'number') return Math.max(acc, m.timestamp);
      return acc;
    }, 0);
    if (upTo > 0) markPeerChatViewed(selectedPeerId, upTo);
  }, [showUnreadListBadges, selectedPeerId, messages, markPeerChatViewed]);

  useEffect(() => {
    if (!selectedPeerId || !settings.sendReadReceipts) return;
    const peerMsgs = msgs.filter((m) => m.from !== 'self');
    const last = peerMsgs[peerMsgs.length - 1];
    if (!last?.messageId) return;
    if (lastReadSentRef.current[selectedPeerId] === last.messageId) return;
    lastReadSentRef.current[selectedPeerId] = last.messageId;
    void sendReadReceipt(selectedPeerId, last.messageId);
  }, [selectedPeerId, msgs, settings.sendReadReceipts, sendReadReceipt]);

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = getComposerTextareaMaxHeight();
    el.style.height = `${Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(el.scrollHeight, max))}px`;
  }, []);

  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  useEffect(() => {
    const onResize = () => adjustTextareaHeight();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [adjustTextareaHeight]);

  useEffect(() => {
    if (!mediaLightbox) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setMediaLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mediaLightbox]);

  useEffect(() => {
    if (!listContextMenu) return;
    const onKey = (e) => {
      if (e.key === 'Escape') closeListContextMenu();
    };
    const onPointerDown = (e) => {
      if (listContextMenuRef.current?.contains(e.target)) return;
      if (isContextMenuFlyoutTarget(e.target)) return;
      closeListContextMenu();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('blur', closeListContextMenu);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('blur', closeListContextMenu);
    };
  }, [listContextMenu, closeListContextMenu]);

  useEffect(() => {
    if (showDeleteConfirm && deleteTargetPeerId && !peerPendingDelete) {
      setShowDeleteConfirm(false);
      setDeleteTargetPeerId(null);
    }
  }, [showDeleteConfirm, deleteTargetPeerId, peerPendingDelete]);

  const saveAttachmentToDisk = async (fileName, base64) => {
    if (!base64) return;
    const name = fileName || 'download';

    if (window.bluetalk?.file?.saveAs) {
      try {
        const res = await window.bluetalk.file.saveAs({
          defaultFilename: name,
          base64,
        });
        if (res?.ok) {
          toast({ variant: 'success', title: 'Datei gespeichert' });
          return;
        }
        if (res && !res.canceled && res.error) {
          toast({ variant: 'error', title: 'Speichern fehlgeschlagen', message: res.error });
          return;
        }
        if (res?.canceled) return;
      } catch (e) {
        const msg = e?.message || '';
        if (!/no handler registered|ERR_HANDLER_NOT_REGISTERED/i.test(msg)) {
          toast({ variant: 'error', title: 'Speichern fehlgeschlagen', message: msg });
          return;
        }
        /* Main-Prozess oft veraltet (Dev ohne vollständigen Neustart): Fallback-Download */
      }
    }

    try {
      downloadBase64AsFile(name, base64);
      toast({
        variant: 'success',
        title: 'Download gestartet',
        message: window.bluetalk?.file?.saveAs
          ? 'Vollständigen Electron-Neustart ausführen, damit „Speichern unter“ wieder den Systemdialog nutzt.'
          : undefined,
      });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Download fehlgeschlagen',
        message: e?.message || 'Unbekannter Fehler.',
      });
    }
  };

  const saveFileMessage = (message) => {
    if (!message?.fileData) return;
    saveAttachmentToDisk(message.fileName || 'download', message.fileData);
  };

  const handleDeleteMessage = async (peerId, messageId) => {
    if (!peerId || !messageId) return;
    const ok = await deleteMessage(peerId, messageId);
    if (ok) {
      toast({ variant: 'success', title: 'Nachricht gelöscht' });
    } else {
      toast({ variant: 'error', title: 'Nachricht konnte nicht gelöscht werden' });
    }
  };

  const handleReplyToMessage = useCallback((message) => {
    if (!message) return;
    setReplyToMessage(message);
    closeMessageContextMenu();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [closeMessageContextMenu]);

  const openForwardDialog = useCallback((items) => {
    const list = Array.isArray(items) ? items.filter((m) => m?.messageId) : [];
    if (!list.length || !selectedPeer) return;
    closeMessageContextMenu();
    exitSelectionMode();
    setForwardDialog({ messages: list, sourcePeerId: selectedPeer.id });
  }, [selectedPeer, closeMessageContextMenu, exitSelectionMode]);

  const forwardableChats = useMemo(
    () =>
      mainChatList.filter(
        (chat) =>
          chat.id !== selectedPeer?.id
          && !chat.contact?.blocked
          && !chat.contact?.blockedByPeer
      ),
    [mainChatList, selectedPeer?.id]
  );

  const confirmForwardToPeer = async (targetPeerId) => {
    if (!forwardDialog?.messages?.length || !targetPeerId || forwardingMessages) return;
    setForwardingMessages(true);
    try {
      let sent = 0;
      for (const message of forwardDialog.messages) {
        const ok = await sendMessage(targetPeerId, buildForwardPayload(message));
        if (ok) sent += 1;
      }
      setForwardDialog(null);
      if (sent === forwardDialog.messages.length) {
        toast({
          variant: 'success',
          title: sent === 1 ? 'Nachricht weitergeleitet' : `${sent} Nachrichten weitergeleitet`,
        });
      } else if (sent > 0) {
        toast({
          variant: 'warning',
          title: 'Teilweise weitergeleitet',
          message: `${sent} von ${forwardDialog.messages.length} Nachrichten gesendet.`,
        });
      } else {
        toast({ variant: 'error', title: 'Weiterleitung fehlgeschlagen' });
      }
    } finally {
      setForwardingMessages(false);
    }
  };

  const deleteSelectedMessages = async () => {
    if (!selectedPeer || selectedMessageIds.size === 0) return;
    const ids = [...selectedMessageIds];
    let deleted = 0;
    for (const messageId of ids) {
      const ok = await deleteMessage(selectedPeer.id, messageId);
      if (ok) deleted += 1;
    }
    exitSelectionMode();
    if (deleted === ids.length) {
      toast({
        variant: 'success',
        title: deleted === 1 ? 'Nachricht gelöscht' : `${deleted} Nachrichten gelöscht`,
      });
    } else if (deleted > 0) {
      toast({
        variant: 'warning',
        title: 'Teilweise gelöscht',
        message: `${deleted} von ${ids.length} Nachrichten entfernt.`,
      });
    } else {
      toast({ variant: 'error', title: 'Löschen fehlgeschlagen' });
    }
  };

  const forwardSelectedMessages = () => {
    if (!selectedPeer || selectedMessageIds.size === 0) return;
    const selected = msgs.filter((m) => m.messageId && selectedMessageIds.has(m.messageId));
    openForwardDialog(selected);
  };

  const selectedCount = selectedMessageIds.size;

  const send = () => {
    if (!selectedPeer) return;
    if (contactOutgoingBlocked(selectedPeer.contact)) return;
    if (showOfflineComposerReconnect) return;
    if (!input.trim() && !pendingFile) return;
    if (sendingFile) return;

    setWarning('');
    const peerId = selectedPeer.id;

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
          preview: getMessagePreviewText(replyToMessage),
          timestamp: replyToMessage.timestamp,
        };
        setReplyToMessage(null);
      }
      sendMessage(peerId, payload).then((ok) => {
        if (!ok) {
          toast({ variant: 'error', title: 'Message not sent', message: 'Peer is probably offline.' });
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
      }).then((ok) => {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
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

  const loadOlderMessages = async () => {
    if (!selectedPeer) return;
    setLoadingMore(true);
    try {
      await loadChatMessages(selectedPeer.id, { limit: CHAT_BATCH_SIZE });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Could not load older messages',
        message: e?.message || 'Try again in a moment.',
      });
    } finally {
      setLoadingMore(false);
    }
  };

  const handleFilePicked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (file.size > MAX_CHAT_FILE_SIZE_BYTES) {
      const msg = `Max file size in chat is ${MAX_CHAT_FILE_SIZE_MB} MB.`;
      setWarning(msg);
      toast({ variant: 'warning', title: 'File too large', message: msg });
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setFileTransfer({ stage: 'reading', percent: 0, detail: 'Reading file…' });
    setWarning('');
    try {
      const data = await readFileAsBase64WithProgress(
        file,
        (p) => {
          setFileTransfer({
            stage: 'reading',
            percent: Math.min(100, Math.round(p * 100)),
            detail: 'Reading file…',
          });
        },
        true
      );
      setPendingFile((prev) => {
        if (prev?.objectUrl) {
          try {
            URL.revokeObjectURL(prev.objectUrl);
          } catch {
            /* ignore */
          }
        }
        return {
          name: file.name,
          size: file.size,
          type: file.type || 'application/octet-stream',
          objectUrl,
          base64: data.base64,
        };
      });
    } catch {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      const msg = 'Could not read file.';
      setWarning(msg);
      toast({ variant: 'error', title: 'File error', message: msg });
    } finally {
      setFileTransfer(null);
    }
  };

  const handleConnect = async () => {
    if (!connectAddress.trim()) return;
    setConnecting(true);
    setWarning('');
    try {
      let dial = connectAddress.trim();
      if (window.bluetalk?.peer?.normalizeAddress) {
        const norm = await window.bluetalk.peer.normalizeAddress(dial);
        if (norm?.ok && norm.normalized) {
          dial = norm.normalized;
        }
      }
      const peerInfo = await connectToAddress(dial);
      setSelectedPeerId(peerInfo.id);
      setShowConnect(false);
      setConnectAddress('');
    } catch (err) {
      const msg = err.message || 'Connection failed';
      setWarning(msg);
      toast({ variant: 'error', title: 'Connection failed', message: msg });
    } finally {
      setConnecting(false);
    }
  };

  const openNicknameDialog = () => {
    if (!selectedPeer) return;
    setNicknameInput(selectedPeer.contact?.nickname || '');
    setShowNickname(true);
    setChatActionsMenuOpen(false);
  };

  const saveNickname = () => {
    if (!selectedPeer) return;
    setContactNickname(selectedPeer.id, nicknameInput);
    setShowNickname(false);
  };

  const togglePinnedState = () => {
    if (!selectedPeer) return;
    setChatPinned(selectedPeer.id, !selectedPeer.pinned);
    setChatActionsMenuOpen(false);
  };

  const confirmDeleteChat = async () => {
    if (!deleteTargetPeerId) return;
    setDeletingChat(true);
    try {
      await deleteChat(deleteTargetPeerId);
      if (selectedPeerId === deleteTargetPeerId) {
        setSelectedPeerId(null);
      }
      setWarning('');
      setPendingFile(null);
      setShowDeleteConfirm(false);
      setDeleteTargetPeerId(null);
    } finally {
      setDeletingChat(false);
    }
  };

  const exportPeerChat = async (chat) => {
    if (!chat?.id || !window.bluetalk) return;
    try {
      const total = chat.messageCount || 0;
      const batch = await window.bluetalk.messages.getBatch(chat.id, {
        skip: 0,
        limit: Math.max(total, 1),
      });
      const safeName = (chat.displayName || chat.id).replace(/[^\w\-]+/g, '_').slice(0, 48);
      downloadJsonFile(`bluetalk-${safeName}-${Date.now()}.json`, {
        exportedAt: new Date().toISOString(),
        peerId: chat.id,
        displayName: chat.displayName,
        messages: batch.messages || [],
        messageCount: batch.total || 0,
      });
      toast({ variant: 'success', title: 'Chat exportiert', message: 'Der Verlauf wurde als JSON gespeichert.' });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Export fehlgeschlagen',
        message: err?.message || 'Unbekannter Fehler.',
      });
    }
  };

  const openChatListContextMenu = (e, chat) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPeerId(chat.id);
    const pad = 8;
    const mw = 232;
    const mh = 280;
    let x = e.clientX;
    let y = e.clientY;
    if (x + mw > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - mw - pad);
    if (y + mh > window.innerHeight - pad) y = Math.max(pad, window.innerHeight - mh - pad);
    if (x < pad) x = pad;
    if (y < pad) y = pad;
    setListContextMenu({ chat, x, y });
  };

  const openDeleteForPeer = (peerId) => {
    setDeleteTargetPeerId(peerId);
    setShowDeleteConfirm(true);
    closeListContextMenu();
    setChatActionsMenuOpen(false);
  };

  const openNicknameForChat = (chat) => {
    setSelectedPeerId(chat.id);
    setNicknameInput(chat.contact?.nickname || '');
    setShowNickname(true);
    closeListContextMenu();
  };

  const copyPeerIdFromMenu = async (peerId) => {
    try {
      await navigator.clipboard.writeText(peerId);
      toast({ variant: 'success', title: 'Peer-ID kopiert' });
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen' });
    }
    closeListContextMenu();
  };

  const copyToClipboard = async (text, successTitle) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ variant: 'success', title: successTitle });
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen' });
    }
  };

  const applyNotificationMute = useCallback(
    (contactId, mode) => {
      if (!contactId) return;
      if (mode === 'off') {
        setContactNotificationMute(contactId, { clear: true });
        toast({
          variant: 'success',
          title: 'Mitteilungen ein',
          message: 'Neue Nachrichten erscheinen wieder in Windows-Mitteilungen.',
        });
        return;
      }
      if (mode === 'manual') {
        setContactNotificationMute(contactId, { manual: true });
        toast({
          variant: 'success',
          title: 'Stumm bis Aufheben',
          message: 'Mitteilungen bleiben aus, bis du „Mitteilungen ein“ wählst.',
        });
        return;
      }
      const ms = mode === '1h' ? MUTE_1H_MS : mode === '8h' ? MUTE_8H_MS : MUTE_24H_MS;
      setContactNotificationMute(contactId, { until: Date.now() + ms });
      toast({
        variant: 'success',
        title: mode === '1h' ? 'Stumm (1 Std.)' : mode === '8h' ? 'Stumm (8 Std.)' : 'Stumm (24 Std.)',
        message: 'Nur Windows-Mitteilungen sind betroffen; Chat und Nachrichten bleiben normal.',
      });
    },
    [setContactNotificationMute, toast]
  );

  return (
    <div className="page">
      <MediaLightbox
        open={Boolean(mediaLightbox)}
        src={mediaLightbox?.src || ''}
        alt={mediaLightbox?.alt || ''}
        canSave={Boolean(mediaLightbox?.base64)}
        onClose={() => setMediaLightbox(null)}
        onSave={() => {
          if (!mediaLightbox?.base64) return;
          saveAttachmentToDisk(mediaLightbox.defaultFilename || 'Bild', mediaLightbox.base64);
        }}
      />
      <div className="split-layout">
        <div
          className={`split-list${resizableUi ? ' split-list--resizable' : ''}`}
          style={chatListWidthPx != null ? { width: chatListWidthPx, flexShrink: 0 } : undefined}
        >
          <div className="split-list-header">
            <h2>Chats</h2>
          </div>
          <div className="split-list-search-wrap">
            <div className="search-bar">
              <Search size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              <input
                className="input"
                placeholder="Search..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="split-list-body">
            {filtered.length === 0 && (
              <div className="empty-state split-list-empty-state">
                <p>No chats yet. Use New in the sidebar for peers without a conversation, or connect below.</p>
              </div>
            )}
            {filtered.map((chat) => {
              const chatContact = resolveContact(chat.id);
              const unreadCount = showUnreadListBadges
                ? countUnreadPeerMessages(
                    chat.id,
                    chatLastViewedPeerTs[chat.id],
                    messages,
                    chat.lastMessage
                  )
                : 0;
              return (
              <div
                key={chat.id}
                  className={`list-item ${selectedPeer?.id === chat.id ? 'active' : ''}${chat.contact?.blocked ? ' list-item--blocked' : ''}${chat.contact?.blockedByPeer ? ' list-item--blocked-by-peer' : ''}${showUnreadListBadges && unreadCount > 0 ? ' list-item--has-unread' : ''}`}
                onClick={() => setSelectedPeerId(chat.id)}
                onContextMenu={(e) => openChatListContextMenu(e, chat)}
              >
                <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
                <div className="list-item-info">
                  <div className="list-item-name-row">
                    <div className="list-item-name">{chat.displayName}</div>
                    {chat.pinned && (
                      <span className="chat-pin-badge" title="Angehefteter Chat">
                        <Pin size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                      </span>
                    )}
                    {chat.e2eePlaintextBadge && (
                      <span className="chat-pin-badge" title="Ausgehend ohne E2EE (Klartext)">
                        <Unlock size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                      </span>
                    )}
                    {contactNotificationMuteOn && isContactNotificationMuted(chatContact) && (
                      <span className="chat-pin-badge" title="Mitteilungen stumm">
                        <BellOff size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                      </span>
                    )}
                  </div>
                  <div className="list-item-sub">{getLastPreview(chat.lastMessage)}</div>
                </div>
                <div className="chat-list-meta">
                  {chat.lastMessage && <span className="list-item-meta">{formatTime(chat.lastMessage.timestamp)}</span>}
                  <div className="chat-list-meta-row">
                    {showUnreadListBadges && unreadCount > 0 && (
                      <>
                        <span className="chat-unread-dot" title="Ungelesene Nachrichten" aria-hidden />
                        <span
                          className="chat-unread-badge"
                          title={`${unreadCount} ungelesen`}
                          aria-label={`${unreadCount} ungelesene Nachrichten`}
                        >
                          {formatUnreadBadgeCount(unreadCount)}
                        </span>
                      </>
                    )}
                    <span className={chat.offline ? 'offline-dot' : 'online-dot'} />
                  </div>
                </div>
              </div>
            );
            })}
          </div>
        </div>
        {resizableUi ? (
          <VerticalResizeHandle
            onBegin={onChatListResizeBegin}
            onDelta={onChatListResizeDelta}
            onCommit={commitChatListWidth}
            onDoubleClick={resetChatListWidth}
          />
        ) : null}

        <div className={`split-detail${resizableUi ? ' split-detail--resizable' : ''}`}>
          {!selectedPeer ? (
            <div className="chat-empty">
              <div className="empty-state">
                <p>Select a conversation to start messaging</p>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowConnect(true)}>
                  Connect to peer
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                className={`chat-header${selectedPeer.contact?.blocked ? ' chat-header--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' chat-header--blocked-by-peer' : ''}`}
              >
                <button
                  type="button"
                  className="chat-header-profile-btn"
                  onClick={() => setShowPeerProfile(true)}
                  aria-haspopup="dialog"
                  aria-expanded={showPeerProfile}
                  title="Profil anzeigen"
                >
                  <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <div className="font-medium truncate" style={{ fontSize: 14 }}>{selectedPeer.displayName}</div>
                    <div className="text-sm text-muted chat-header-meta">
                      <span>
                        {selectedPeer.contact?.blocked
                          ? 'Blockiert'
                          : selectedPeer.contact?.blockedByPeer
                            ? 'Du wurdest blockiert'
                            : selectedPeer.contact?.chatDeletedByPeer
                              ? 'Chat gelöscht'
                              : selectedPeer.offline
                                ? 'Offline'
                                : 'Online'}
                        {selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname
                          ? ` · ${selectedPeer.baseName}`
                          : ''}
                        {!contactE2eePreferenceOn(selectedPeer.contact) ? ' · Klartext (ausgehend)' : ''}
                        {contactNotificationMuteOn && isContactNotificationMuted(selectedContact)
                          ? ' · Mitteilungen stumm'
                          : ''}
                      </span>
                      {selectedPeer.bio ? (
                        <span className="chat-header-bio" title={selectedPeer.bio}>
                          {selectedPeer.bio}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
                <div className="chat-header-actions">
                  {selectionMode ? (
                    <div className="chat-selection-bar">
                      <span className="chat-selection-count">
                        {selectedCount === 0 ? 'Nachrichten auswählen' : `${selectedCount} ausgewählt`}
                      </span>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={selectedCount === 0}
                        onClick={forwardSelectedMessages}
                      >
                        <Forward size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Weiterleiten
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={selectedCount === 0}
                        onClick={() => void deleteSelectedMessages()}
                      >
                        <Trash2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Löschen
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={exitSelectionMode}
                      >
                        Aus
                      </button>
                    </div>
                  ) : (
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    ref={chatActionsMenuBtnRef}
                    aria-label="Chat-Aktionen"
                    aria-expanded={chatActionsMenuOpen}
                    aria-haspopup="menu"
                    title="Chat-Aktionen"
                    onClick={() => setChatActionsMenuOpen((o) => !o)}
                  >
                    <MoreVertical size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  </button>
                  )}
                  {chatActionsMenuOpen && !selectionMode &&
                    createPortal(
                      <div
                        ref={chatActionsMenuPanelRef}
                        className="chat-list-context-menu chat-header-peer-menu animate-scale"
                        role="menu"
                        style={{
                          position: 'fixed',
                          top: chatMenuPosition.top,
                          left: chatMenuPosition.left,
                          zIndex: 1250,
                          maxHeight: 'min(420px, calc(100vh - 24px))',
                          overflowY: 'auto',
                        }}
                      >
                      <button
                        type="button"
                        className="chat-list-context-menu-item"
                        role="menuitem"
                        onClick={() => {
                          if (!selectedPeer) return;
                          const on = contactE2eePreferenceOn(selectedPeer.contact);
                          const next = !on;
                          setContactE2eeEnabled(selectedPeer.id, next);
                          toast({
                            variant: 'success',
                            title: next ? 'E2EE aktiv' : 'E2EE aus',
                            message: next
                              ? 'Ausgehende Nachrichten werden wieder verschlüsselt, sobald eine Sitzung besteht.'
                              : 'Ausgehende Nachrichten gehen unverschlüsselt; eingehende E2EE-Nachrichten werden weiter entschlüsselt.',
                          });
                          setChatActionsMenuOpen(false);
                        }}
                      >
                        {contactE2eePreferenceOn(selectedPeer.contact) ? (
                          <Unlock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        ) : (
                          <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        )}
                        {contactE2eePreferenceOn(selectedPeer.contact)
                          ? 'E2EE deaktivieren (Klartext)'
                          : 'E2EE aktivieren'}
                      </button>
                      {contactNotificationMuteOn && !selectedContact?.blocked ? (
                        <>
                          <ContextMenuHoverSubmenu
                            label="Mitteilungen"
                            icon={isContactNotificationMuted(selectedContact) ? BellOff : Bell}
                          >
                            <NotificationMuteMenuItems
                              contact={selectedContact}
                              contactId={selectedPeer.id}
                              applyNotificationMute={applyNotificationMute}
                              onDone={() => setChatActionsMenuOpen(false)}
                            />
                          </ContextMenuHoverSubmenu>
                          <div className="chat-list-context-menu-sep" role="separator" />
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="chat-list-context-menu-item"
                        role="menuitem"
                        onClick={() => {
                          if (!selectedPeer) return;
                          const next = !selectedPeer.contact?.blocked;
                          setContactBlocked(selectedPeer.id, next);
                          toast({
                            variant: 'success',
                            title: next ? 'Contact blocked' : 'Contact unblocked',
                            message: next
                              ? 'They no longer appear in your chat list and cannot message you.'
                              : 'You can chat with them again from New connections or by reconnecting.',
                          });
                          setChatActionsMenuOpen(false);
                        }}
                      >
                        <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        {selectedPeer.contact?.blocked ? 'Entblocken' : 'Blockieren'}
                      </button>
                      <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={openNicknameDialog}>
                        <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Spitzname…
                      </button>
                      <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={togglePinnedState}>
                        {selectedPeer.pinned ? (
                          <PinOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        ) : (
                          <Pin size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        )}
                        {selectedPeer.pinned ? 'Chat lösen' : 'Chat anheften'}
                      </button>
                      <button
                        type="button"
                        className="chat-list-context-menu-item"
                        role="menuitem"
                        onClick={startSelectionMode}
                      >
                        <CheckSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Auswahl
                      </button>
                      <button
                        type="button"
                        className="chat-list-context-menu-item"
                        role="menuitem"
                        onClick={() => {
                          void copyPeerIdFromMenu(selectedPeer.id);
                          setChatActionsMenuOpen(false);
                        }}
                      >
                        <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Peer-ID kopieren
                      </button>
                      <div className="chat-list-context-menu-sep" role="separator" />
                      <button
                        type="button"
                        className="chat-list-context-menu-item chat-list-context-menu-item--danger"
                        role="menuitem"
                        onClick={() => openDeleteForPeer(selectedPeer.id)}
                      >
                        <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Chat löschen…
                      </button>
                      </div>,
                      document.body
                    )}
                </div>
              </div>

              <div className="chat-messages">
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
                          onClick={() => void exportPeerChat(selectedPeer)}
                        >
                          <Save size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                          Exportieren
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => openDeleteForPeer(selectedPeer.id)}
                        >
                          <Trash2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                          Chat löschen
                        </button>
                      </div>
                    </div>
                  )}
                {contactNotificationMuteOn &&
                  !selectedContact?.blocked &&
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
                {!selectedPeer.contact?.blocked && !contactE2eePreferenceOn(selectedPeer.contact) && (
                  <div className="chat-notice-muted" role="status">
                    Ausgehende Nachrichten in diesem Chat sind unverschlüsselt. Eingehende verschlüsselte Nachrichten
                    werden weiterhin entschlüsselt.
                  </div>
                )}
                {hasMoreMessages && (
                  <div className="chat-load-more">
                    <button className="btn btn-secondary btn-sm" onClick={loadOlderMessages} disabled={loadingMore}>
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
                  const isSelf = m.from === 'self';
                  const bubbleName = isSelf ? (settings.displayName || 'You') : (m.sender || selectedPeer.displayName);
                  const bubblePic = isSelf ? settings.profilePicture : selectedPeer.profilePicture;
                  const bareMedia = isBareMediaMessage(m);
                  const embedMessage = isChatEmbedMessage(m);
                  const outsideBubble = bareMedia || embedMessage;
                  const delivery = selfDeliveryLabel(m);
                  const seen = isSelf && readUpToId && m.messageId && readUpToId === m.messageId ? 'Seen' : '';
                  const isSelected = Boolean(m.messageId && selectedMessageIds.has(m.messageId));
                  return (
                    <div
                      key={m.messageId || `${m.timestamp || i}-${m.from || 'msg'}-${i}`}
                      className={[
                        'msg-row',
                        isSelf ? 'msg-row-self' : 'msg-row-other',
                        outsideBubble && 'msg-row--bare',
                        embedMessage && 'msg-row--embed',
                        selectionMode && 'msg-row--selectable',
                        isSelected && 'msg-row--selected',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      onClick={
                        selectionMode && m.messageId
                          ? () => toggleSelectedMessage(m.messageId)
                          : undefined
                      }
                    >
                      {selectionMode && m.messageId ? (
                        <label className="msg-select-check" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelectedMessage(m.messageId)}
                            aria-label="Nachricht auswählen"
                          />
                        </label>
                      ) : null}
                      {!selectionMode ? (
                        <PeerAvatar pictureUrl={bubblePic} name={bubbleName} size={28} className="msg-avatar" />
                      ) : null}
                      <div
                        className={['msg', isSelf ? 'msg-self' : 'msg-other', bareMedia && 'msg--bare-media', embedMessage && 'msg--embed', 'animate-in']
                          .filter(Boolean)
                          .join(' ')}
                        onContextMenu={selectionMode ? undefined : (e) => openMessageContextMenu(e, m)}
                      >
                        {!isSelf && !selectionMode && <div className="msg-sender">{m.sender || m.from}</div>}
                        {m.replyTo && m.kind !== 'chat' ? (
                          <MessageReplyQuote replyTo={m.replyTo} isSelf={isSelf} />
                        ) : null}
                        {m.kind === 'file' ? (
                          <FileMessage
                            message={m}
                            bareLayout={bareMedia}
                            onExpandImage={setMediaLightbox}
                            onSaveToDisk={saveFileMessage}
                          />
                        ) : m.kind === 'sticker' ? (
                          <StickerMessage message={m} onExpandImage={setMediaLightbox} />
                        ) : m.kind === 'poker-invite' ? (
                          <PokerInviteMessage message={m} />
                        ) : m.kind === 'uno-invite' ? (
                          <UnoInviteMessage message={m} />
                        ) : m.kind === 'contact-share' ? (
                          <ContactShareMessage
                            message={m}
                            isConnected={Boolean(peers.find((p) => p.id === (m.sharedContact?.id || m.from)))}
                            onConnect={connectFromSharedContact}
                          />
                        ) : (
                          <ChatMessage message={m} onExpandImage={setMediaLightbox} />
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
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              <div className="chat-composer-stack">
                {showOfflineComposerReconnect && (
                  <div
                    className="chat-offline-reconnect-overlay"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="chat-offline-reconnect-overlay-inner">
                      <span className="chat-offline-reconnect-dot" aria-hidden />
                      <span className="chat-offline-reconnect-text">
                        {offlineReconnectAddress
                          ? 'Verbindung wird wiederhergestellt …'
                          : 'Offline — keine gespeicherte Adresse für diesen Peer.'}
                      </span>
                    </div>
                  </div>
                )}

                {replyToMessage && (
                  <div className="chat-reply-bar">
                    <div className="chat-reply-bar-body">
                      <span className="chat-reply-bar-label">
                        Antwort an{' '}
                        {replyToMessage.from === 'self'
                          ? settings.displayName || 'Du'
                          : replyToMessage.sender || selectedPeer.displayName}
                      </span>
                      <span className="chat-reply-bar-preview">{getMessagePreviewText(replyToMessage)}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon chat-reply-bar-close"
                      onClick={() => setReplyToMessage(null)}
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
                        <button
                          type="button"
                          className="chat-list-context-menu-item"
                          role="menuitem"
                          onClick={() => openStickerPicker()}
                        >
                          <Smile size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                          Sticker
                        </button>
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
                        <button
                          type="button"
                          className="chat-list-context-menu-item"
                          role="menuitem"
                          onClick={() => void shareOwnContact()}
                        >
                          <UserRound size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                          Kontakt teilen
                        </button>
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
                  <textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        send();
                      }
                    }}
                    placeholder={
                      selectedPeer.contact?.blocked
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
                    onClick={send}
                    disabled={
                      sendingFile
                      || readingFile
                      || (!input.trim() && !pendingFile)
                      || composerDisabled
                    }
                    style={{ height: 40, width: 40 }}
                    title="Nachricht senden"
                  >
                    <SendHorizontal size={17} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {showConnect && (
        <div className="modal-overlay" onClick={() => setShowConnect(false)}>
          <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ margin: 0 }}>Connect to Peer</h3>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShowConnect(false)} aria-label="Schließen">
                <X size={16} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <div className="input-group">
              <label>Address or IP</label>
              <input
                className="input font-mono"
                placeholder="e.g. 192.168.1.42 or 192.168.1.42:8080"
                value={connectAddress}
                onChange={(e) => setConnectAddress(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
                autoFocus
              />
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowConnect(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleConnect} disabled={!connectAddress.trim() || connecting}>
                {connecting ? (
                  <span className="spinner-label">
                    <span className="spinner spinner--sm spinner--accent" />
                    <span>Connecting</span>
                  </span>
                ) : 'Connect'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPeerProfile && selectedPeer && (
        <div className="modal-overlay" onClick={() => setShowPeerProfile(false)} role="presentation">
          <div
            className={`modal animate-scale peer-profile-modal${selectedPeer.contact?.blocked ? ' peer-profile-modal--blocked' : ''}${selectedPeer.contact?.blockedByPeer ? ' peer-profile-modal--blocked-by-peer' : ''}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="peer-profile-title"
          >
            <div className="peer-profile-modal-toolbar">
              <h2 id="peer-profile-title" className="peer-profile-modal-title">
                Profil
              </h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => setShowPeerProfile(false)}
                aria-label="Schließen"
              >
                <X size={18} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <div className="peer-profile-modal-body">
              <div className="peer-profile-modal-hero">
                <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={72} />
                <div className="peer-profile-modal-name">{selectedPeer.displayName}</div>
                {selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname ? (
                  <div className="text-sm text-muted">{selectedPeer.baseName}</div>
                ) : null}
              </div>
              <div className="peer-profile-field">
                <span className="peer-profile-field-label">Status</span>
                <span>
                  {selectedPeer.contact?.blocked
                    ? 'Blockiert'
                    : selectedPeer.contact?.blockedByPeer
                      ? 'Hat dich blockiert'
                      : selectedPeer.contact?.chatDeletedByPeer
                        ? 'Hat den Chat gelöscht'
                        : selectedPeer.offline
                          ? 'Offline'
                          : 'Online'}
                  {!contactE2eePreferenceOn(selectedPeer.contact) ? ' · Ausgehend ohne E2EE' : ''}
                </span>
              </div>
              <div className="peer-profile-field">
                <span className="peer-profile-field-label">Peer-ID</span>
                <div className="peer-profile-id-row">
                  <span className="peer-profile-id-text">{selectedPeer.id}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon btn-sm"
                    title="Peer-ID kopieren"
                    aria-label="Peer-ID kopieren"
                    onClick={() => copyToClipboard(selectedPeer.id, 'Peer-ID kopiert')}
                  >
                    <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  </button>
                </div>
              </div>
              {peerProfileAddress(selectedPeer) ? (
                <div className="peer-profile-field">
                  <span className="peer-profile-field-label">Adresse</span>
                  <div className="peer-profile-id-row">
                    <span className="peer-profile-id-text">{peerProfileAddress(selectedPeer)}</span>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon btn-sm"
                      title="Adresse kopieren"
                      aria-label="Adresse kopieren"
                      onClick={() =>
                        copyToClipboard(peerProfileAddress(selectedPeer), 'Adresse kopiert')
                      }
                    >
                      <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    </button>
                  </div>
                </div>
              ) : null}
              {selectedPeer.bio ? (
                <div className="peer-profile-field peer-profile-field--bio">
                  <span className="peer-profile-field-label">Info</span>
                  <p className="peer-profile-bio">{selectedPeer.bio}</p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {showNickname && selectedPeer && (
        <div className="modal-overlay" onClick={() => setShowNickname(false)}>
          <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ margin: 0 }}>Set Nickname</h3>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setShowNickname(false)} aria-label="Schließen">
                <X size={16} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <div className="input-group">
              <label>Nickname</label>
              <input
                className="input"
                placeholder={`Current: ${selectedPeer.baseName}`}
                value={nicknameInput}
                onChange={(e) => setNicknameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveNickname()}
                autoFocus
              />
              <span className="text-xs text-muted">Leave empty to clear the nickname.</span>
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setShowNickname(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveNickname}>Save</button>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && peerPendingDelete && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (deletingChat) return;
            setShowDeleteConfirm(false);
            setDeleteTargetPeerId(null);
          }}
        >
          <div className="modal modal-danger animate-scale" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ margin: 0 }}>Delete chat?</h3>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  if (deletingChat) return;
                  setShowDeleteConfirm(false);
                  setDeleteTargetPeerId(null);
                }}
                disabled={deletingChat}
                aria-label="Schließen"
              >
                <X size={16} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <p className="text-muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
              This removes the conversation with <strong>{peerPendingDelete.displayName}</strong> and all messages stored on this device. This cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteTargetPeerId(null);
                }}
                disabled={deletingChat}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={confirmDeleteChat}
                disabled={deletingChat}
              >
                {deletingChat ? (
                  <span className="spinner-label">
                    <span className="spinner spinner--sm spinner--accent" />
                    <span>Deleting</span>
                  </span>
                ) : 'Delete chat'}
              </button>
            </div>
          </div>
        </div>
      )}

      {listContextMenu && (
        <div
          ref={listContextMenuRef}
          className="chat-list-context-menu"
          role="menu"
          style={{ left: listContextMenu.x, top: listContextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => {
              setSelectedPeerId(listContextMenu.chat.id);
              closeListContextMenu();
            }}
          >
            <MessageSquare size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Chat öffnen
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => {
              setChatPinned(listContextMenu.chat.id, !listContextMenu.chat.pinned);
              closeListContextMenu();
            }}
          >
            {listContextMenu.chat.pinned ? (
              <PinOff size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            ) : (
              <Pin size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            )}
            {listContextMenu.chat.pinned ? 'Chat lösen' : 'Chat anheften'}
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => {
              const id = listContextMenu.chat.id;
              const on = contactE2eePreferenceOn(listContextMenu.chat.contact);
              setContactE2eeEnabled(id, !on);
              toast({
                variant: 'success',
                title: !on ? 'E2EE aktiv' : 'E2EE aus',
              });
              closeListContextMenu();
            }}
          >
            {contactE2eePreferenceOn(listContextMenu.chat.contact) ? (
              <Unlock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            ) : (
              <Lock size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            )}
            {contactE2eePreferenceOn(listContextMenu.chat.contact)
              ? 'E2EE deaktivieren (Klartext)'
              : 'E2EE aktivieren'}
          </button>
          {contactNotificationMuteOn && !resolveContact(listContextMenu.chat.id)?.blocked ? (
            <>
              <ContextMenuHoverSubmenu
                label="Mitteilungen"
                icon={isContactNotificationMuted(resolveContact(listContextMenu.chat.id)) ? BellOff : Bell}
              >
                <NotificationMuteMenuItems
                  contact={resolveContact(listContextMenu.chat.id)}
                  contactId={listContextMenu.chat.id}
                  applyNotificationMute={applyNotificationMute}
                  onDone={closeListContextMenu}
                />
              </ContextMenuHoverSubmenu>
              <div className="chat-list-context-menu-sep" role="separator" />
            </>
          ) : null}
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => openNicknameForChat(listContextMenu.chat)}
          >
            <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Spitzname…
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => copyPeerIdFromMenu(listContextMenu.chat.id)}
          >
            <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Peer-ID kopieren
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => {
              const id = listContextMenu.chat.id;
              const blocked = !listContextMenu.chat.contact?.blocked;
              setContactBlocked(id, blocked);
              toast({
                variant: 'success',
                title: blocked ? 'Contact blocked' : 'Contact unblocked',
              });
              closeListContextMenu();
            }}
          >
            <Ban size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            {listContextMenu.chat.contact?.blocked ? 'Unblock' : 'Block'}
          </button>
          <div className="chat-list-context-menu-sep" role="separator" />
          <button
            type="button"
            className="chat-list-context-menu-item chat-list-context-menu-item--danger"
            role="menuitem"
            onClick={() => openDeleteForPeer(listContextMenu.chat.id)}
          >
            <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Chat löschen…
          </button>
        </div>
      )}

      {messageContextMenu && (
        <div
          ref={messageContextMenuRef}
          className="chat-list-context-menu msg-context-menu"
          role="menu"
          style={{ left: messageContextMenu.x, top: messageContextMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => handleReplyToMessage(messageContextMenu.message)}
          >
            <Reply size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Antworten
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => openForwardDialog([messageContextMenu.message])}
          >
            <Forward size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Weiterleiten
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item chat-list-context-menu-item--danger"
            role="menuitem"
            onClick={() => {
              if (!selectedPeer) return;
              void handleDeleteMessage(selectedPeer.id, messageContextMenu.message.messageId);
              closeMessageContextMenu();
            }}
          >
            <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Löschen
          </button>
          <div className="chat-list-context-menu-sep" role="separator" />
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={closeMessageContextMenu}
          >
            <X size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            Aus
          </button>
        </div>
      )}

      {forwardDialog && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (forwardingMessages) return;
            setForwardDialog(null);
          }}
        >
          <div className="modal animate-scale forward-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ margin: 0 }}>
                {forwardDialog.messages.length === 1 ? 'Nachricht weiterleiten' : `${forwardDialog.messages.length} Nachrichten weiterleiten`}
              </h3>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  if (forwardingMessages) return;
                  setForwardDialog(null);
                }}
                aria-label="Schließen"
                disabled={forwardingMessages}
              >
                <X size={16} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <p className="text-muted" style={{ margin: '0 0 12px', lineHeight: 1.5 }}>
              Wähle einen Chat als Ziel.
            </p>
            <div className="forward-dialog-list">
              {forwardableChats.length === 0 ? (
                <div className="empty-state" style={{ padding: '12px 0' }}>
                  <p>Keine weiteren Chats verfügbar.</p>
                </div>
              ) : (
                forwardableChats.map((chat) => (
                  <button
                    key={chat.id}
                    type="button"
                    className="forward-dialog-item"
                    disabled={forwardingMessages}
                    onClick={() => void confirmForwardToPeer(chat.id)}
                  >
                    <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={32} />
                    <div className="forward-dialog-item-info">
                      <div className="forward-dialog-item-name">{chat.displayName}</div>
                      <div className="forward-dialog-item-sub">{getLastPreview(chat.lastMessage)}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => setForwardDialog(null)}
                disabled={forwardingMessages}
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
