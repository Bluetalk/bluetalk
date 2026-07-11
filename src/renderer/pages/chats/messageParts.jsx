// Extracted from Chats.jsx — presentational/pure chat modules (behaviour unchanged).
import React, { useCallback } from 'react';
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
import { canJoinGameViaPresence, formatGamePresenceLabel, isInviteSessionActive, isPresenceStale } from '../../../shared/game-presence.js';
import { useToast } from '../../components/ToastProvider';
import { pluginRuntime } from '../../plugins/pluginRuntime';
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

function stripOrphanThinkingTags(text) {
  return String(text || '')
    .replace(/<\/?(?:redacted_thinking|think|redacted_reasoning)>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitThinkingText(rawText) {
  const raw = String(rawText || '');
  if (!raw) return { thinking: '', content: '' };

  let content = '';
  let thinking = '';
  let cursor = 0;
  const openRe = /<(?:redacted_thinking|think|redacted_reasoning)>/ig;
  let match = openRe.exec(raw);

  while (match) {
    content += raw.slice(cursor, match.index);
    const bodyStart = openRe.lastIndex;
    const closeRe = /<\/(?:redacted_thinking|think|redacted_reasoning)>/ig;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(raw);
    if (!close) {
      thinking += `${thinking ? '\n\n' : ''}${raw.slice(bodyStart)}`;
      cursor = raw.length;
      break;
    }
    thinking += `${thinking ? '\n\n' : ''}${raw.slice(bodyStart, close.index)}`;
    cursor = closeRe.lastIndex;
    openRe.lastIndex = cursor;
    match = openRe.exec(raw);
  }

  content += raw.slice(cursor);
  return {
    thinking: thinking.trim(),
    content: stripOrphanThinkingTags(content),
  };
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

function useGameJoinRequest() {
  const { toast } = useToast();
  return useCallback(async (game, pending) => {
    const response = await pluginRuntime.invokePluginCommand(game, 'join', pending);
    const result = response?.ok
      ? (response.result?.ok === false ? response.result : { ok: true })
      : {
        ok: false,
        message: response?.error === 'not_active'
          ? 'Aktiviere dieses Spiel zuerst unter Erweiterungen.'
          : response?.error === 'unknown_command'
            ? 'Das Spiele-Plugin ist veraltet. Bitte stelle es unter Erweiterungen auf Standard zurück.'
            : response?.error || 'Beitritt fehlgeschlagen.',
      };
    if (!result.ok) {
      toast({
        variant: 'warning',
        title: 'Beitritt nicht möglich',
        message: result.message || 'Beitritt fehlgeschlagen.',
      });
    }
    return result;
  }, [toast]);
}

function PokerInviteMessage({ message }) {
  const navigate = useNavigate();
  const requestGameJoin = useGameJoinRequest();
  const { peers, peerGamePresence } = useApp();
  const tableName = message.tableName || 'Poker-Tisch';
  const settings = message.pokerSettings || {};
  const summary = message.pokerSettingsSummary || message.content || '';
  const smallBlind = Number(settings.smallBlind) || 10;
  const bigBlind = Number(settings.bigBlind) || 20;
  const maxPlayers = Number(settings.maxPlayers) || 6;
  const startingChips = Number(settings.startingChips) || 2000;
  const hostPeerId = message.hostPeerId || message.from;
  const tableId = message.tableId;
  const hostPresence = hostPeerId ? peerGamePresence?.[hostPeerId] : null;
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const inviteActive = isInviteSessionActive({
    presence: hostPresence,
    hostPeerId,
    sessionId: tableId,
    game: 'poker',
    hostOnline,
  }) && !isPresenceStale(hostPresence);

  const joinTable = async () => {
    if (!inviteActive) return;
    const result = await requestGameJoin('poker', {
      hostPeerId,
      tableId: message.tableId,
      tableName,
      pokerSettings: settings,
    });
    if (result.ok) {
      navigate('/games');
    }
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
      <p className="poker-invite-card-hint">
        {inviteActive
          ? 'Peer-to-Peer am Tisch — du musst mit dem Host verbunden sein.'
          : 'Diese Einladung ist nicht mehr aktiv (Tisch geschlossen, voll oder Hand läuft).'}
      </p>
      <button
        type="button"
        className={`poker-invite-card-btn${inviteActive ? '' : ' poker-invite-card-btn--inactive'}`}
        onClick={joinTable}
        disabled={!inviteActive}
      >
        {inviteActive ? 'Tisch beitreten' : 'Einladung abgelaufen'}
      </button>
    </div>
  );
}

function UnoInviteMessage({ message }) {
  const navigate = useNavigate();
  const requestGameJoin = useGameJoinRequest();
  const { peers, peerGamePresence } = useApp();
  const tableName = message.tableName || 'UNO-Tisch';
  const settings = message.unoSettings || {};
  const summary = message.unoSettingsSummary || message.content || '';
  const maxPlayers = Number(settings.maxPlayers) || 4;
  const gameMode = settings.gameMode === 'points'
    ? `Punkte bis ${Number(settings.targetScore) || 500}`
    : 'Einzelrunde';
  const houseRules = settings.houseRules === 'casual' ? 'Casual' : 'Offiziell';
  const hostPeerId = message.hostPeerId || message.from;
  const gameId = message.gameId;
  const hostPresence = hostPeerId ? peerGamePresence?.[hostPeerId] : null;
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const inviteActive = isInviteSessionActive({
    presence: hostPresence,
    hostPeerId,
    sessionId: gameId,
    game: 'uno',
    hostOnline,
  }) && !isPresenceStale(hostPresence);

  const joinGame = async () => {
    if (!inviteActive) return;
    const result = await requestGameJoin('uno', {
      hostPeerId,
      gameId: message.gameId,
      tableName,
      unoSettings: settings,
    });
    if (result.ok) {
      navigate('/games');
    }
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
      <p className="uno-invite-card-hint">
        {inviteActive
          ? 'Peer-to-Peer — du musst mit dem Host verbunden sein.'
          : 'Diese Einladung ist nicht mehr aktiv (Spiel geschlossen, voll oder läuft bereits).'}
      </p>
      <p className="uno-invite-card-alpha" role="note">Alpha: Das UNO-Plugin kann noch Fehler haben und sich ändern.</p>
      <button
        type="button"
        className={`uno-invite-card-btn${inviteActive ? '' : ' uno-invite-card-btn--inactive'}`}
        onClick={joinGame}
        disabled={!inviteActive}
      >
        {inviteActive ? 'Spiel beitreten' : 'Einladung abgelaufen'}
      </button>
    </div>
  );
}

function ConnectFourInviteMessage({ message }) {
  const navigate = useNavigate();
  const requestGameJoin = useGameJoinRequest();
  const { peers, peerGamePresence } = useApp();
  const tableName = message.tableName || 'Vier-gewinnt-Tisch';
  const settings = message.connectFourSettings || {};
  const summary = message.connectFourSettingsSummary || message.content || '';
  const hostPeerId = message.hostPeerId || message.from;
  const gameId = message.gameId;
  const hostPresence = hostPeerId ? peerGamePresence?.[hostPeerId] : null;
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const inviteActive = isInviteSessionActive({
    presence: hostPresence,
    hostPeerId,
    sessionId: gameId,
    game: 'connect-four',
    hostOnline,
  }) && !isPresenceStale(hostPresence);

  const joinGame = async () => {
    if (!inviteActive) return;
    const result = await requestGameJoin('connect-four', {
      hostPeerId,
      gameId: message.gameId,
      tableName,
      connectFourSettings: settings,
    });
    if (result.ok) {
      navigate('/games');
    }
  };

  return (
    <div className="connect-four-invite-card" role="group" aria-label="Vier-gewinnt-Einladung">
      <div className="connect-four-invite-card-head">
        <span className="connect-four-invite-card-icon" aria-hidden>🔴</span>
        <div className="connect-four-invite-card-copy">
          <div className="connect-four-invite-card-kicker">Vier gewinnt</div>
          <div className="connect-four-invite-card-title">{tableName}</div>
          {summary ? <div className="connect-four-invite-card-meta">{summary}</div> : null}
        </div>
      </div>
      <dl className="connect-four-invite-card-stats">
        <div>
          <dt>Spieler</dt>
          <dd>2</dd>
        </div>
        <div>
          <dt>Modus</dt>
          <dd>Peer-to-Peer</dd>
        </div>
        <div>
          <dt>Ziel</dt>
          <dd>4 in einer Reihe</dd>
        </div>
      </dl>
      <p className="connect-four-invite-card-hint">
        {inviteActive
          ? 'Peer-to-Peer — du musst mit dem Host verbunden sein.'
          : 'Diese Einladung ist nicht mehr aktiv (Spiel geschlossen, voll oder läuft bereits).'}
      </p>
      <button
        type="button"
        className={`connect-four-invite-card-btn${inviteActive ? '' : ' connect-four-invite-card-btn--inactive'}`}
        onClick={joinGame}
        disabled={!inviteActive}
      >
        {inviteActive ? 'Spiel beitreten' : 'Einladung abgelaufen'}
      </button>
    </div>
  );
}

function ChessInviteMessage({ message }) {
  const navigate = useNavigate();
  const requestGameJoin = useGameJoinRequest();
  const { peers, peerGamePresence } = useApp();
  const tableName = message.tableName || 'Schach-Partie';
  const settings = message.chessSettings || {};
  const summary = message.chessSettingsSummary || message.content || '';
  const timeControlSec = Number(settings.timeControlSec) || 0;
  const timeLabel = timeControlSec > 0 ? `${Math.round(timeControlSec / 60)} Min./Spieler` : 'Unbegrenzt';
  const hostPeerId = message.hostPeerId || message.from;
  const gameId = message.gameId;
  const hostPresence = hostPeerId ? peerGamePresence?.[hostPeerId] : null;
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const inviteActive = isInviteSessionActive({
    presence: hostPresence,
    hostPeerId,
    sessionId: gameId,
    game: 'chess',
    hostOnline,
  }) && !isPresenceStale(hostPresence);

  const joinGame = async () => {
    if (!inviteActive) return;
    const result = await requestGameJoin('chess', {
      hostPeerId,
      gameId: message.gameId,
      tableName,
      chessSettings: settings,
    });
    if (result.ok) {
      navigate('/games');
    }
  };

  return (
    <div className="chess-invite-card" role="group" aria-label="Schach-Einladung">
      <div className="chess-invite-card-head">
        <span className="chess-invite-card-icon" aria-hidden>♟</span>
        <div className="chess-invite-card-copy">
          <div className="chess-invite-card-kicker">Schach</div>
          <div className="chess-invite-card-title">{tableName}</div>
          {summary ? <div className="chess-invite-card-meta">{summary}</div> : null}
        </div>
      </div>
      <dl className="chess-invite-card-stats">
        <div>
          <dt>Spieler</dt>
          <dd>2</dd>
        </div>
        <div>
          <dt>Zeit</dt>
          <dd>{timeLabel}</dd>
        </div>
        <div>
          <dt>Modus</dt>
          <dd>Peer-to-Peer</dd>
        </div>
      </dl>
      <p className="chess-invite-card-hint">
        {inviteActive
          ? 'Peer-to-Peer — du musst mit dem Host verbunden sein.'
          : 'Diese Einladung ist nicht mehr aktiv (Partie geschlossen, voll oder läuft bereits).'}
      </p>
      <button
        type="button"
        className={`chess-invite-card-btn${inviteActive ? '' : ' chess-invite-card-btn--inactive'}`}
        onClick={joinGame}
        disabled={!inviteActive}
      >
        {inviteActive ? 'Partie beitreten' : 'Einladung abgelaufen'}
      </button>
    </div>
  );
}

function TicTacToeInviteMessage({ message }) {
  const navigate = useNavigate();
  const requestGameJoin = useGameJoinRequest();
  const { peers, peerGamePresence } = useApp();
  const tableName = message.tableName || 'Tic-Tac-Toe';
  const settings = message.ticTacToeSettings || {};
  const summary = message.ticTacToeSettingsSummary || message.content || '';
  const boardSize = Number(settings.boardSize) || 3;
  const winLength = Number(settings.winLength) || 3;
  const maxPlayers = Number(settings.maxPlayers) || 2;
  const hostPeerId = message.hostPeerId || message.from;
  const gameId = message.gameId;
  const hostPresence = hostPeerId ? peerGamePresence?.[hostPeerId] : null;
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const inviteActive = isInviteSessionActive({
    presence: hostPresence,
    hostPeerId,
    sessionId: gameId,
    game: 'tic-tac-toe',
    hostOnline,
  }) && !isPresenceStale(hostPresence);

  const joinGame = async () => {
    if (!inviteActive) return;
    const result = await requestGameJoin('tic-tac-toe', {
      hostPeerId,
      gameId: message.gameId,
      tableName,
      ticTacToeSettings: settings,
    });
    if (result.ok) {
      navigate('/games');
    }
  };

  return (
    <div className="ttt-invite-card" role="group" aria-label="Tic-Tac-Toe-Einladung">
      <div className="ttt-invite-card-head">
        <span className="ttt-invite-card-icon" aria-hidden>✕</span>
        <div className="ttt-invite-card-copy">
          <div className="ttt-invite-card-kicker">Tic-Tac-Toe</div>
          <div className="ttt-invite-card-title">{tableName}</div>
          {summary ? <div className="ttt-invite-card-meta">{summary}</div> : null}
        </div>
      </div>
      <dl className="ttt-invite-card-stats">
        <div>
          <dt>Feld</dt>
          <dd>{boardSize}×{boardSize}</dd>
        </div>
        <div>
          <dt>Gewinn</dt>
          <dd>{winLength} in einer Reihe</dd>
        </div>
        <div>
          <dt>Spieler</dt>
          <dd>max. {maxPlayers}</dd>
        </div>
      </dl>
      <p className="ttt-invite-card-hint">
        {inviteActive
          ? 'Peer-to-Peer — du musst mit dem Host verbunden sein.'
          : 'Diese Einladung ist nicht mehr aktiv (Spiel geschlossen, voll oder läuft bereits).'}
      </p>
      <button
        type="button"
        className={`ttt-invite-card-btn${inviteActive ? '' : ' ttt-invite-card-btn--inactive'}`}
        onClick={joinGame}
        disabled={!inviteActive}
      >
        {inviteActive ? 'Spiel beitreten' : 'Einladung abgelaufen'}
      </button>
    </div>
  );
}

function LiveDocsInviteMessage({ message }) {
  const { peers } = useApp();
  const { toast } = useToast();
  const fileName = message.fileName || message.tableName || 'Dokument';
  const hostPeerId = message.hostPeerId || message.from;
  const roomId = message.roomId;
  const isSelf = message.from === 'self';
  const hostOnline = Boolean(peers?.some((peer) => peer?.id === hostPeerId));
  const canJoin = Boolean(roomId && hostPeerId && !isSelf && hostOnline);

  const join = async () => {
    if (!canJoin) return;
    const res = await pluginRuntime.invokePluginCommand('live-docs', 'joinInvite', { roomId, hostPeerId, fileName });
    if (!res?.ok) {
      toast({
        variant: 'warning',
        title: 'Dokumente',
        message: res?.error === 'not_active'
          ? 'Die Erweiterung „Dokumente“ ist nicht aktiv — zuerst aktivieren.'
          : 'Beitritt nicht möglich.',
      });
    }
  };

  const hint = isSelf
    ? 'Einladung im Chat gesendet — der Kontakt kann hier mitschreiben.'
    : hostOnline
      ? 'Peer-to-Peer — du musst mit dem Host verbunden sein.'
      : 'Der Host ist gerade offline — sobald ihr verbunden seid, kannst du beitreten.';

  return (
    <div className="live-docs-invite-card" role="group" aria-label="Dokument-Einladung">
      <div className="live-docs-invite-card-head">
        <span className="live-docs-invite-card-icon" aria-hidden>📝</span>
        <div className="live-docs-invite-card-copy">
          <div className="live-docs-invite-card-kicker">Live Dokument</div>
          <div className="live-docs-invite-card-title">{fileName}</div>
          <div className="live-docs-invite-card-meta">Gemeinsam in Echtzeit bearbeiten</div>
        </div>
      </div>
      <p className="live-docs-invite-card-hint">{hint}</p>
      {!isSelf ? (
        <button
          type="button"
          className={`live-docs-invite-card-btn${canJoin ? '' : ' live-docs-invite-card-btn--inactive'}`}
          onClick={join}
          disabled={!canJoin}
        >
          {canJoin ? 'Mitschreiben' : 'Host offline'}
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
  stripOrphanThinkingTags,
  splitThinkingText,
  ContactShareMessage,
  useGameJoinRequest,
  PokerInviteMessage,
  UnoInviteMessage,
  ConnectFourInviteMessage,
  ChessInviteMessage,
  TicTacToeInviteMessage,
  LiveDocsInviteMessage,
  GamePresenceBanner,
  MessageReplyQuote,
};
