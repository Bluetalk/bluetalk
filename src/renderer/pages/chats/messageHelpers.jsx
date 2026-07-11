// Extracted from Chats.jsx — presentational/pure chat modules (behaviour unchanged).
import React from 'react';
import {
  File,
  FileImage,
  FileText,
  Film,
  MessageSquare,
  Music,
  Plus,
  Plug,
  Smile,
} from 'lucide-react';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import { AI_THINKING_DEFAULT_MODE_ID, isValidThinkingMode, normalizeAgentMode, resolveAgentPersonality } from '../../aiChatConstants';

const CHAT_ICON_STROKE = 1.75;
const MAX_AVATAR_BYTES = 380 * 1024;

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Kein Bild'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      reject(new Error(`Bild unter ${Math.round(MAX_AVATAR_BYTES / 1024)} KB verwenden`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Lesen fehlgeschlagen'));
    reader.readAsDataURL(file);
  });
}

function collectSubagentsByPeer(messages, aiChatProgress) {
  const result = {};

  const upsert = (peerId, seg) => {
    if (!peerId || seg?.type !== 'subagent') return;
    const id = typeof seg.id === 'string' ? seg.id : '';
    if (!id) return;
    if (!result[peerId]) result[peerId] = [];
    const idx = result[peerId].findIndex((entry) => entry.id === id);
    if (idx >= 0) result[peerId][idx] = { ...result[peerId][idx], ...seg };
    else result[peerId].push({ ...seg });
  };

  if (messages && typeof messages === 'object') {
    for (const [peerId, peerMessages] of Object.entries(messages)) {
      if (!Array.isArray(peerMessages)) continue;
      for (const msg of peerMessages) {
        if (!Array.isArray(msg?.segments)) continue;
        for (const seg of msg.segments) upsert(peerId, seg);
      }
    }
  }

  if (aiChatProgress?.peerId && Array.isArray(aiChatProgress.segments)) {
    for (const seg of aiChatProgress.segments) upsert(aiChatProgress.peerId, seg);
  }

  return result;
}

function subagentStatusLabel(status) {
  if (status === 'running') return 'läuft';
  if (status === 'error') return 'Fehler';
  if (status === 'done') return 'fertig';
  return 'Sub-Agent';
}

function normalizeAiAgent(agent) {
  const personality = resolveAgentPersonality(agent);
  return {
    id: agent.id,
    name: String(agent.name || 'KI-Assistent').trim() || 'KI-Assistent',
    profilePicture: typeof agent.profilePicture === 'string' ? agent.profilePicture : '',
    bio: typeof agent.bio === 'string' ? agent.bio.slice(0, 500) : '',
    personality: personality.personalityId,
    personalityCustom: personality.personalityCustom,
    agentMode: normalizeAgentMode(agent.agentMode),
    agentWorkDir: typeof agent.agentWorkDir === 'string' ? agent.agentWorkDir.trim() : '',
    thinkingMode: isValidThinkingMode(agent.thinkingMode) ? agent.thinkingMode : AI_THINKING_DEFAULT_MODE_ID,
    allowBluetalkMessaging: Boolean(agent.allowBluetalkMessaging),
    createdAt: Number(agent.createdAt) || Date.now(),
  };
}

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

function formatGenTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
}

function selfDeliveryLabel(m) {
  if (m.from !== 'self' || !m.messageId) return { text: '', pending: false };
  const summary = m.groupDeliverySummary;
  if (m.deliveryStatus === 'partial') {
    return { text: `Teilweise zugestellt · ${summary?.delivered || 0}/${summary?.total || 0}`, pending: false };
  }
  if (m.deliveryStatus === 'scheduled') {
    return { text: summary?.total ? `Vorgemerkt · ${summary.offline || 0} offline` : 'Vorgemerkt', pending: false };
  }
  if (m.deliveryStatus === 'delivered') {
    return { text: summary?.total ? `Zugestellt · ${summary.delivered}/${summary.total}` : 'Delivered', pending: false };
  }
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

function getMessagePreviewText(message, debugMode = false) {
  if (!message) return '';
  if (message.kind === 'sticker') return 'Sticker';
  if (message.kind === 'file') return `📎 ${message.fileName || message.content || 'Anhang'}`;
  if (message.kind === 'contact-share') {
    const name = message.sharedContact?.displayName || message.sharedContact?.name || 'Kontakt';
    return `Kontakt: ${name}`;
  }
  if (message.kind === 'poker-invite') return `Poker: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'uno-invite') {
    if (!debugMode) {
      const content = String(message.content || message.unoSettingsSummary || '').trim();
      return content || 'Nachricht';
    }
    return `UNO: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'connect-four-invite') return `Vier gewinnt: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'chess-invite') return `Schach: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'tic-tac-toe-invite') return `Tic-Tac-Toe: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'live-docs-invite') return `Dokument: ${message.fileName || message.tableName || 'Einladung'}`;
  const content = String(message.content || '').trim();
  if (!content) return 'Nachricht';
  return content.length > 120 ? `${content.slice(0, 117)}…` : content;
}

function getMessageCopyText(message, debugMode = false) {
  if (!message) return '';
  if (message.kind === 'sticker') return '';
  if (message.kind === 'file') {
    return [message.fileName, message.content].filter(Boolean).join('\n').trim();
  }
  if (message.kind === 'contact-share') {
    const contact = message.sharedContact || {};
    const name = contact.displayName || contact.name || 'Kontakt';
    const id = contact.id || '';
    return id ? `${name}\n${id}` : name;
  }
  if (message.kind === 'poker-invite') {
    return String(message.pokerSettingsSummary || message.content || `Poker: ${message.tableName || 'Einladung'}`).trim();
  }
  if (message.kind === 'uno-invite') {
    if (!debugMode) {
      return String(message.content || message.unoSettingsSummary || '').trim();
    }
    return String(message.unoSettingsSummary || message.content || `UNO: ${message.tableName || 'Einladung'}`).trim();
  }
  if (message.kind === 'connect-four-invite') {
    return String(message.connectFourSettingsSummary || message.content || `Vier gewinnt: ${message.tableName || 'Einladung'}`).trim();
  }
  if (message.kind === 'chess-invite') {
    return String(message.chessSettingsSummary || message.content || `Schach: ${message.tableName || 'Einladung'}`).trim();
  }
  if (message.kind === 'tic-tac-toe-invite') {
    return String(message.ticTacToeSettingsSummary || message.content || `Tic-Tac-Toe: ${message.tableName || 'Einladung'}`).trim();
  }
  if (message.kind === 'live-docs-invite') {
    return String(message.content || `Dokument: ${message.fileName || message.tableName || 'Einladung'}`).trim();
  }
  const segments = Array.isArray(message.segments) ? message.segments : null;
  if (segments?.length) {
    const answers = segments
      .filter((seg) => seg.type === 'answer' && String(seg.text || '').trim())
      .map((seg) => String(seg.text).trim());
    if (answers.length) return answers.join('\n\n');
  }
  const split = splitThinkingText(message.content);
  return String(split.content || message.content || '').trim();
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

function getLastPreview(message, debugMode = false) {
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
    if (!debugMode) {
      const content = String(message.content || message.unoSettingsSummary || '').trim();
      return (message.from === 'self' ? 'Du: ' : '') + (content || 'Nachricht');
    }
    return `${message.from === 'self' ? 'Du: ' : ''}UNO: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'connect-four-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}Vier gewinnt: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'chess-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}Schach: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'tic-tac-toe-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}Tic-Tac-Toe: ${message.tableName || 'Einladung'}`;
  }
  if (message.kind === 'live-docs-invite') {
    return `${message.from === 'self' ? 'Du: ' : ''}Dokument: ${message.fileName || message.tableName || 'Einladung'}`;
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
function isChatEmbedMessage(message, debugMode = false) {
  if (!message) return false;
  if (message.kind === 'uno-invite') return debugMode;
  return message.kind === 'poker-invite' || message.kind === 'connect-four-invite' || message.kind === 'chess-invite' || message.kind === 'tic-tac-toe-invite' || message.kind === 'live-docs-invite' || message.kind === 'contact-share';
}


export {
  CHAT_ICON_STROKE,
  MAX_AVATAR_BYTES,
  readImageDataUrl,
  collectSubagentsByPeer,
  subagentStatusLabel,
  normalizeAiAgent,
  resolveLucideIcon,
  MUTE_1H_MS,
  MUTE_8H_MS,
  MUTE_24H_MS,
  isContextMenuFlyoutTarget,
  notificationMuteSelectValue,
  formatMuteExpiry,
  formatMessageTime,
  formatTime,
  formatGenTime,
  selfDeliveryLabel,
  contactOutgoingBlocked,
  formatSize,
  downloadJsonFile,
  downloadBase64AsFile,
  PeerAvatar,
  MAX_CHAT_FILE_SIZE_MB,
  MAX_CHAT_FILE_SIZE_BYTES,
  CHAT_BATCH_SIZE,
  CHAT_LIST_WIDTH_DEFAULT,
  CHAT_LIST_WIDTH_MIN,
  CHAT_LIST_WIDTH_MAX,
  COMPOSER_TEXTAREA_MIN_HEIGHT,
  COMPOSER_TEXTAREA_MAX_HEIGHT,
  getComposerTextareaMaxHeight,
  getMessagePreviewText,
  getMessageCopyText,
  buildForwardPayload,
  getLastPreview,
  formatUnreadBadgeCount,
  peerProfileAddress,
  countUnreadPeerMessages,
  contactE2eePreferenceOn,
  readFileAsBase64WithProgress,
  EXT_TO_IMAGE_MIME,
  imageMimeForFile,
  getFileBlobUrl,
  getImageUrl,
  extOf,
  getFileCategory,
  isBareMediaMessage,
  isChatEmbedMessage,
};
