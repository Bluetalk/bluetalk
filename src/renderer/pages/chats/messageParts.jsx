// Extracted from Chats.jsx — presentational/pure chat modules (behaviour unchanged).
import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  Archive,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType,
  Film,
  Music,
  FileBarChart,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { normalizeChatMarkdown } from '../../utils/normalizeChatMarkdown.js';
import { canJoinGameViaPresence, formatGamePresenceLabel, isPresenceStale } from '../../../shared/game-presence.js';
import { useToast } from '../../components/ToastProvider';
import { useApp } from '../../App';
import {
  CHAT_ICON_STROKE,
  formatSize,
  PeerAvatar,
  getFileBlobUrl,
  getImageUrl,
  extOf,
  getFileCategory,
} from './messageHelpers.jsx';

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

// Stable module-level references so ReactMarkdown does not treat the plugin
// list as new props on every render.
const MARKDOWN_REMARK_PLUGINS = [remarkGfm, remarkMath];
const MARKDOWN_REHYPE_PLUGINS = [rehypeKatex];
const MARKDOWN_COMPONENTS = {
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
};

// Memoised: KaTeX/highlight parsing is the single most expensive per-message
// cost, so re-run it only when the text or className actually changes.
const MarkdownBody = React.memo(function MarkdownBody({ text, className = '' }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return (
    <div className={`msg-markdown${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
        components={MARKDOWN_COMPONENTS}
      >
        {normalizeChatMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});

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


function GamePresenceBanner({ peerId, presence }) {
  const { gameInviteKeys, joinGameFromPresence } = useApp();
  const navigate = useNavigate();
  const { toast } = useToast();

  if (!presence || isPresenceStale(presence)) return null;
  const label = formatGamePresenceLabel(presence);
  const canJoin = canJoinGameViaPresence({ presence, gameInvites: gameInviteKeys, hostPeerId: peerId });
  const accessLabel = presence.lobbyAccess === 'public' ? 'Öffentliche Lobby' : 'Nur auf Einladung';

  const handleJoin = async () => {
    if (!canJoin) {
      toast({
        variant: 'warning',
        title: 'Beitritt nicht möglich',
        message: presence.lobbyAccess === 'invite'
          ? 'Diese Lobby ist nur auf Einladung — zuerst die Chat-Einladung annehmen.'
          : 'Die Lobby ist derzeit nicht beitrittsfähig.',
      });
      return;
    }
    const result = await joinGameFromPresence(presence, peerId);
    if (result?.ok) {
      navigate('/games');
      toast({ variant: 'success', title: 'Spiel beitreten', message: 'Verbindung zur Lobby wird hergestellt…' });
    } else {
      toast({
        variant: 'warning',
        title: 'Beitritt nicht möglich',
        message: result?.message || 'Verbindung zur Lobby konnte nicht hergestellt werden.',
      });
    }
  };

  return (
    <div className="game-presence-banner" role="status">
      <div className="game-presence-banner-copy">
        <span className="game-presence-banner-icon" aria-hidden>
          {presence.game === 'poker' ? '♠' : presence.game === 'connect-four' ? '🔴' : presence.game === 'chess' ? '♟' : presence.game === 'tic-tac-toe' ? '✕' : '🎴'}
        </span>
        <div>
          <div className="game-presence-banner-title">{label}</div>
          <div className="game-presence-banner-meta">
            {accessLabel}
            {typeof presence.playerCount === 'number' && typeof presence.maxPlayers === 'number'
              ? ` · ${presence.playerCount}/${presence.maxPlayers} Spieler`
              : ''}
          </div>
        </div>
      </div>
      {presence.joinable ? (
        <button
          type="button"
          className={`game-presence-banner-btn${canJoin ? '' : ' game-presence-banner-btn--inactive'}`}
          onClick={handleJoin}
          disabled={!canJoin}
        >
          {canJoin ? 'Beitreten' : 'Nur auf Einladung'}
        </button>
      ) : null}
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


export {
  FileTypeIcon,
  FileMessage,
  MARKDOWN_REMARK_PLUGINS,
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_COMPONENTS,
  MarkdownBody,
  ContactShareMessage,
  GamePresenceBanner,
  MessageReplyQuote,
};
