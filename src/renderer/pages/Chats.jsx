import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeChatMarkdown } from '../utils/normalizeChatMarkdown.js';
import {
  filterToolEventsForDisplay,
  groupConsecutiveToolSegments,
  isRunCommandRunning,
  toolEventsFromSegment,
} from '../utils/agentSegments.js';
import {
  Archive,
  Ban,
  Bot,
  Copy,
  Eraser,
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
  Users,
  X,
  MoreVertical,
  Reply,
  Forward,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Square,
} from 'lucide-react';
import { useApp } from '../App';
import {
  canJoinGameViaPresence,
  formatGamePresenceLabel,
  gameInviteKey,
  isInviteSessionActive,
  isPresenceStale,
} from '../../shared/game-presence.js';
import {
  formatUserPresenceLabel,
  isPeerDoNotDisturb,
} from '../../shared/user-presence.js';
import { useToast } from '../components/ToastProvider';
import StickerPicker from '../components/StickerPicker';
import StickerMessage from '../components/StickerMessage';
import VerticalResizeHandle from '../components/VerticalResizeHandle';
import { CreateGroupModal, GroupInfoModal } from '../components/GroupChatDialogs';
import { isContactNotificationMuted } from '../contactNotificationMute';
import { pluginRuntime } from '../plugins/pluginRuntime';
import { normalizeAttachmentFileType } from '../utils/attachmentImage';
import {
  AI_AGENT_DEFAULT_MODE_ID,
  AI_CHAT_PEER_ID,
  AI_CLOUD_MODELS,
  AI_MODEL_TIERS,
  AI_PERSONALITY_CUSTOM_MAX_CHARS,
  AI_PERSONALITY_PRESETS,
  AI_THINKING_DEFAULT_MODE_ID,
  isAiChatPeerId,
  isModelTierVisible,
  isValidThinkingMode,
  modelSupportsVision,
  normalizeAgentMode,
  resolveAgentPersonality,
} from '../aiChatConstants';
import groupChat from '../../shared/group-chat.js';

const { getGroupMember, isActiveGroupMember, isGroupChatId } = groupChat;

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

function MarkdownBody({ text, className = '' }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  return (
    <div className={`msg-markdown${className ? ` ${className}` : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
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

function AiChatModelPicker({ ollamaState, disabled, onSelectTier, onSelectCloudModel, onOpenCloudSettings, debugMode = false }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectedTierId = ollamaState?.selectedModelTier || '';
  const selectedCloudModelId = ollamaState?.selectedCloudModelId || '';
  const activeTier = AI_MODEL_TIERS[selectedTierId];
  const activeCloudModel = selectedTierId === 'cloud' ? AI_CLOUD_MODELS[selectedCloudModelId] : null;
  const activeLabel = activeCloudModel?.label || activeTier?.label || ollamaState?.activeModel || 'Modell';

  const availableOptions = useMemo(() => {
    const localOptions = Object.values(AI_MODEL_TIERS)
      .filter((tier) => tier.local && isModelTierVisible(tier, debugMode) && ollamaState?.modelStatus?.[tier.id] === 'ready')
      .map((tier) => ({
        key: `local:${tier.id}`,
        kind: 'local',
        tierId: tier.id,
        label: tier.label,
        model: tier.model,
        beta: Boolean(tier.beta),
      }));
    const cloudOptions = ollamaState?.cloudAuth
      ? Object.values(AI_CLOUD_MODELS).map((cloudModel) => ({
        key: `cloud:${cloudModel.id}`,
        kind: 'cloud',
        cloudModelId: cloudModel.id,
        label: cloudModel.label,
        model: cloudModel.model,
      }))
      : [];
    return { localOptions, cloudOptions };
  }, [ollamaState, debugMode]);

  const hasOptions = availableOptions.localOptions.length > 0 || availableOptions.cloudOptions.length > 0;

  const handleSelect = (option) => {
    setOpen(false);
    if (option.kind === 'cloud') {
      onSelectCloudModel?.(option.cloudModelId);
      return;
    }
    if (option.tierId !== selectedTierId) onSelectTier(option.tierId);
  };

  const isOptionActive = (option) => {
    if (option.kind === 'cloud') {
      return selectedTierId === 'cloud' && selectedCloudModelId === option.cloudModelId;
    }
    return selectedTierId === option.tierId;
  };

  return (
    <div className={`ai-chat-model-picker${open ? ' ai-chat-model-picker--open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className="ai-chat-model-picker-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Modell wechseln"
      >
        <span className="ai-chat-model-picker-label">{activeLabel}</span>
        <ChevronDown size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden className="ai-chat-model-picker-chevron" />
      </button>
      {open ? (
        <div className="ai-chat-model-picker-menu animate-scale" role="listbox" aria-label="Modell wählen">
          {!hasOptions ? (
            <div className="ai-chat-model-picker-empty text-sm text-muted">Keine Modelle bereit</div>
          ) : (
            <>
              {availableOptions.localOptions.length > 0 ? (
                <>
                  <div className="ai-chat-model-picker-group-label">Lokal</div>
                  {availableOptions.localOptions.map((option) => {
                    const isActive = isOptionActive(option);
                    return (
                      <button
                        key={option.key}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={`ai-chat-model-picker-option${isActive ? ' ai-chat-model-picker-option--active' : ''}`}
                        onClick={() => handleSelect(option)}
                      >
                        <span className="ai-chat-model-picker-option-label">
                          {option.label}
                          {option.beta ? <span className="badge badge-muted" style={{ marginLeft: 6 }}>Beta</span> : null}
                        </span>
                        <span className="ai-chat-model-picker-option-model text-muted">{option.model}</span>
                      </button>
                    );
                  })}
                </>
              ) : null}
              {availableOptions.cloudOptions.length > 0 ? (
                <>
                  <div className="ai-chat-model-picker-group-label">Cloud</div>
                  {availableOptions.cloudOptions.map((option) => {
                    const isActive = isOptionActive(option);
                    return (
                      <button
                        key={option.key}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        className={`ai-chat-model-picker-option${isActive ? ' ai-chat-model-picker-option--active' : ''}`}
                        onClick={() => handleSelect(option)}
                      >
                        <span className="ai-chat-model-picker-option-label">{option.label}</span>
                        <span className="ai-chat-model-picker-option-model text-muted">{option.model}</span>
                      </button>
                    );
                  })}
                </>
              ) : null}
            </>
          )}
          {!ollamaState?.cloudAuth ? (
            <button
              type="button"
              className="ai-chat-model-picker-cloud-link text-sm"
              onClick={() => {
                setOpen(false);
                onOpenCloudSettings?.();
              }}
            >
              Ollama Cloud in Einstellungen aktivieren
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AiThinkingBlock({ thinking, live = false, defaultOpen = false }) {
  const text = String(thinking || '').trim();
  if (!text) return null;

  return (
    <details className={`msg-thinking${live ? ' msg-thinking--live' : ''}`} open={live || defaultOpen}>
      <summary>Denkprozess</summary>
      <div className="msg-thinking-body">
        <MarkdownBody text={text} className="msg-markdown--thinking" />
      </div>
    </details>
  );
}

function summarizeToolResult(result, max = 240) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  if (typeof result.content === 'string') parts.push(result.content);
  if (typeof result.stdout === 'string') parts.push(result.stdout);
  if (typeof result.stderr === 'string' && result.stderr) parts.push(`stderr: ${result.stderr}`);
  if (typeof result.exitCode === 'number' && result.exitCode !== 0) parts.push(`exit ${result.exitCode}`);
  if (Array.isArray(result.entries)) {
    parts.push(result.entries.map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}`).join('  '));
  }
  if (typeof result.answer === 'string' && result.answer) parts.push(`Antwort: ${result.answer}`);
  if (typeof result.question === 'string' && result.question && !result.answer) {
    parts.push(`Frage: ${result.question}`);
  }
  if (typeof result.error === 'string' && result.error) parts.push(`Fehler: ${result.error}`);
  if (result.result && typeof result.result === 'object') parts.push(JSON.stringify(result.result));
  const joined = parts.filter(Boolean).join(' · ').trim();
  if (joined.length <= max) return joined;
  return `${joined.slice(0, max)}…`;
}

const TOOL_LABELS = {
  read_file: 'Liest',
  extract_file: 'Extrahiert',
  write_file: 'Schreibt',
  list_files: 'Listet',
  search_files: 'Sucht',
  grep_files: 'Grep',
  edit_file: 'Bearbeitet',
  run_command: 'Führt aus',
  read_bluetalk_messages: 'Liest Chat',
  send_bluetalk_message: 'Sendet',
  send_bluetalk_reply: 'Antwortet',
  list_bluetalk_contacts: 'Kontakte',
  list_bluetalk_peers: 'Online-Peers',
  list_bluetalk_chats: 'Chats',
  get_bluetalk_contact: 'Kontakt-Info',
  get_bluetalk_self: 'Eigene Info',
  list_bluetalk_plugins: 'Plugins',
  connect_bluetalk_peer: 'Verbindet',
  ask_user: 'Rückfrage',
  spawn_subagent: 'Sub-Agent',
  bluetalk_command: 'BlueTalk',
};

function toolArgPreview(name, args) {
  try {
    const a = typeof args === 'string' ? JSON.parse(args) : (args || {});
    if (name === 'read_file' || name === 'write_file' || name === 'extract_file') return a.path || '';
    if (name === 'list_files' || name === 'search_files' || name === 'grep_files') return a.path || a.pattern || '.';
    if (name === 'run_command') return a.command || a.cmd || '';
    if (name === 'read_bluetalk_messages' || name === 'send_bluetalk_message' || name === 'send_bluetalk_reply') return a.peer_id || '';
    if (name === 'connect_bluetalk_peer') return a.address || '';
    if (name === 'get_bluetalk_contact') return a.peer_id || '';
    if (name === 'list_bluetalk_contacts' || name === 'list_bluetalk_chats') return a.query || '';
    if (name === 'ask_user') return a.question || '';
    if (name === 'spawn_subagent') return a.task || '';
    if (name === 'bluetalk_command') {
      const bits = [a.pluginId, a.commandId].filter(Boolean);
      return bits.join(' · ');
    }
  } catch {
    /* ignore */
  }
  return '';
}

function AgentToolLines({ events = [] }) {
  if (!Array.isArray(events) || !events.length) return null;
  return (
    <>
      {events.map((evt, idx) => {
        const name = String(evt?.name || 'tool');
        const label = TOOL_LABELS[name] || name;
        const arg = toolArgPreview(name, evt?.arguments);
        const running = isRunCommandRunning(evt);
        const ok = running ? true : evt?.result?.ok !== false;
        const resultText = running ? '' : summarizeToolResult(evt?.result);
        const shimmerClass = running ? ' msg-agent-tool-line-shimmer' : '';
        return (
          <div
            key={`${name}-${idx}`}
            className={`msg-agent-tool-line${ok ? '' : ' msg-agent-tool-line--error'}${running ? ' msg-agent-tool-line--running' : ''}`}
          >
            <span className="msg-agent-tool-line-dot" aria-hidden />
            <span className={`msg-agent-tool-line-label${shimmerClass}`}>{label}</span>
            {arg ? <span className={`msg-agent-tool-line-arg${shimmerClass}`}>{arg}</span> : null}
            {!ok ? <span className="msg-agent-tool-line-status">fehlgeschlagen</span> : null}
            {resultText ? <span className="msg-agent-tool-line-result">{resultText}</span> : null}
          </div>
        );
      })}
    </>
  );
}

function AgentToolEvents({ events = [], live = false, hideSubagentSpawn = false }) {
  const visibleEvents = filterToolEventsForDisplay(events, { hideSubagentSpawn });
  if (!visibleEvents.length) return null;

  const runningCommand = visibleEvents.some(isRunCommandRunning);
  const failed = visibleEvents.filter((evt) => evt?.result?.ok === false).length;
  const summaryText = runningCommand
    ? 'Führt aus · läuft'
    : failed
      ? `Tool-Aufrufe · ${visibleEvents.length} (${failed} fehlgeschlagen)`
      : `Tool-Aufrufe · ${visibleEvents.length}`;

  return (
    <details className={`msg-agent-tools${live ? ' msg-agent-tools--live' : ''}`} open={live}>
      <summary>
        <span className="msg-agent-tools-summary-text">{summaryText}</span>
        {live ? <span className="msg-agent-tools-live-badge">läuft</span> : null}
      </summary>
      <div className="msg-agent-tools-body">
        <AgentToolLines events={visibleEvents} />
      </div>
    </details>
  );
}

/** Rendert einen laufenden oder abgeschlossenen Sub-Agenten als ausklappbaren Block. */
function SubAgentBlock({ segment, live = false, onOpen }) {
  const running = segment?.status === 'running';
  const taskPreview = String(segment?.task || '').trim();
  const displayTask = taskPreview.length > 140 ? `${taskPreview.slice(0, 140)}…` : taskPreview;
  const statusLabel = running
    ? 'läuft'
    : segment?.status === 'error'
      ? 'Fehler'
      : 'fertig';

  if (onOpen) {
    return (
      <button
        type="button"
        className={`msg-subagent msg-subagent--open${live && running ? ' msg-subagent--live' : ''}`}
        onClick={() => onOpen(segment)}
      >
        <span className="msg-subagent-summary-text">Sub-Agent · {statusLabel}</span>
        {displayTask ? <span className="msg-subagent-task">{displayTask}</span> : null}
        {live && running ? <span className="msg-subagent-live-badge">läuft</span> : null}
        <ChevronRight size={14} strokeWidth={CHAT_ICON_STROKE} className="msg-subagent-open-icon" aria-hidden />
      </button>
    );
  }

  return (
    <details className={`msg-subagent${live && running ? ' msg-subagent--live' : ''}`} open={live && running}>
      <summary>
        <span className="msg-subagent-summary-text">Sub-Agent · {statusLabel}</span>
        {displayTask ? <span className="msg-subagent-task">{displayTask}</span> : null}
        {live && running ? <span className="msg-subagent-live-badge">läuft</span> : null}
      </summary>
      <div className="msg-subagent-body">
        {Array.isArray(segment?.segments) && segment.segments.length ? (
          <MessageSegments
            segments={segment.segments}
            content={segment.content}
            thinking={segment.thinking}
            toolEvents={segment.toolEvents}
            live={live && running}
            hideSubagentSpawn
          />
        ) : segment?.content ? (
          <MarkdownBody text={segment.content} className={live && running ? 'msg-markdown--live-answer' : undefined} />
        ) : segment?.error ? (
          <span className="msg-subagent-error">{segment.error}</span>
        ) : running ? (
          <span className="msg-subagent-wait">Sub-Agent arbeitet…</span>
        ) : null}
      </div>
    </details>
  );
}

function SubagentChatView({ segment, parentPeer, live = false, onBack }) {
  const endRef = useRef(null);
  const running = segment?.status === 'running';
  const taskPreview = String(segment?.task || '').trim();
  const hasOutput = Boolean(
    segment?.content
    || segment?.thinking
    || (Array.isArray(segment?.toolEvents) && segment.toolEvents.length)
    || (Array.isArray(segment?.segments) && segment.segments.length)
  );

  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ behavior: live && running ? 'auto' : 'smooth' });
  }, [
    segment?.content,
    segment?.segments?.length,
    live,
    running,
    segment?.content ? Math.floor(String(segment.content).length / 320) : 0,
  ]);

  return (
    <>
      <div className="chat-header chat-header--subagent">
        <button
          type="button"
          className="btn btn-ghost btn-icon chat-subagent-back"
          onClick={onBack}
          aria-label="Zurück zum Agent-Chat"
          title="Zurück zum Agent-Chat"
        >
          <ChevronLeft size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
        </button>
        <div className="ai-chat-list-avatar chat-subagent-header-icon" aria-hidden>
          <Bot size={18} strokeWidth={CHAT_ICON_STROKE} />
        </div>
        <div className="chat-subagent-header-body">
          <div className="font-medium truncate" style={{ fontSize: 14 }}>
            Sub-Agent · {subagentStatusLabel(segment?.status)}
          </div>
          <div className="text-sm text-muted chat-header-meta truncate">
            {parentPeer?.displayName || 'Sub-Agent'}
          </div>
        </div>
      </div>
      <div className="chat-messages chat-messages--ai">
        {taskPreview ? (
          <div className="msg-row msg-row-self">
            <div className="msg msg-subagent-prompt animate-in">
              <MarkdownBody text={taskPreview} />
            </div>
          </div>
        ) : null}
        <div className="msg-row msg-row-other msg-row--ai-agent">
          <div className={`msg msg--ai-agent${live && running ? ' msg--ai-agent-live' : ''} animate-in`}>
            {hasOutput ? (
              <MessageSegments
                segments={segment?.segments}
                content={segment?.content}
                thinking={segment?.thinking}
                toolEvents={segment?.toolEvents}
                live={live && running}
                hideSubagentSpawn
              />
            ) : running ? (
              <div className="spinner-label">
                <span className="spinner spinner--sm" />
                <span>Sub-Agent arbeitet…</span>
              </div>
            ) : segment?.error ? (
              <span className="msg-subagent-error">{segment.error}</span>
            ) : (
              <span className="text-muted">Kein Output für diesen Sub-Agenten.</span>
            )}
          </div>
        </div>
        <div ref={endRef} />
      </div>
    </>
  );
}

function buildAgentMessageLayout({ segments, content, thinking, toolEvents }) {
  const answers = [];
  const working = [];

  const hasSegments = Array.isArray(segments) && segments.length > 0;
  if (!hasSegments) {
    if (String(thinking || '').trim()) working.push({ type: 'thinking', text: String(thinking).trim() });
    const evts = filterToolEventsForDisplay(Array.isArray(toolEvents) ? toolEvents.filter(Boolean) : []);
    if (evts.length) working.push({ type: 'tool', events: evts });
    if (String(content || '').trim()) answers.push({ text: String(content).trim() });
    return { answers, working };
  }

  const displaySegments = groupConsecutiveToolSegments(segments);
  const hasAnswer = displaySegments.some((s) => s.type === 'answer' && String(s.text || '').trim());

  for (const seg of displaySegments) {
    if (seg.type === 'thinking' && String(seg.text || '').trim()) {
      working.push({ type: 'thinking', text: seg.text });
    } else if (seg.type === 'tool') {
      const events = filterToolEventsForDisplay(toolEventsFromSegment(seg));
      if (events.length) working.push({ type: 'tool', events });
    } else if (seg.type === 'subagent') {
      working.push({ type: 'subagent', segment: seg });
    } else if (seg.type === 'answer' && String(seg.text || '').trim()) {
      answers.push({ text: seg.text });
    }
  }

  if (!hasAnswer && String(content || '').trim()) {
    answers.push({ text: String(content).trim() });
  }

  return { answers, working };
}

function AgentWorkingBlock({ items = [], live = false, hideSubagentSpawn = false, onOpenSubagent }) {
  const sections = [];
  items.forEach((item, idx) => {
    const isLast = idx === items.length - 1;
    const itemLive = live && isLast;
    if (item.type === 'thinking') {
      sections.push(<AiThinkingBlock key={`w-thinking-${idx}`} thinking={item.text} live={itemLive} />);
      return;
    }
    if (item.type === 'tool') {
      sections.push(
        <AgentToolEvents
          key={`w-tool-${idx}`}
          events={item.events}
          live={itemLive}
          hideSubagentSpawn={hideSubagentSpawn}
        />
      );
      return;
    }
    if (item.type === 'subagent') {
      sections.push(
        <SubAgentBlock
          key={`w-sub-${item.segment?.id || idx}`}
          segment={item.segment}
          live={live && item.segment?.status === 'running'}
          onOpen={onOpenSubagent}
        />
      );
    }
  });

  if (!sections.length) return null;

  const running = live && items.some(
    (item) => item.type === 'subagent' && item.segment?.status === 'running'
  );

  return (
    <details className={`msg-working${live ? ' msg-working--live' : ''}`} open={live}>
      <summary>
        <span className="msg-working-summary-text">Working</span>
        {live || running ? <span className="msg-working-live-badge">läuft</span> : null}
      </summary>
      <div className="msg-working-body">{sections}</div>
    </details>
  );
}

/**
 * Rendert Working-Schritte zuerst, danach die Agent-Antwort.
 */
function MessageSegments({ segments, content, thinking, toolEvents, live = false, hideSubagentSpawn = false, onOpenSubagent }) {
  const { answers, working } = buildAgentMessageLayout({ segments, content, thinking, toolEvents });
  const hasSubagentItems = working.some((item) => item.type === 'subagent');

  return (
    <>
      <AgentWorkingBlock
        items={working}
        live={live}
        hideSubagentSpawn={hideSubagentSpawn || hasSubagentItems}
        onOpenSubagent={onOpenSubagent}
      />
      {answers.map((answer, idx) => (
        <MarkdownBody
          key={`answer-${idx}`}
          text={answer.text}
          className={live && idx === answers.length - 1 ? 'msg-markdown--live-answer' : undefined}
        />
      ))}
    </>
  );
}

// Memoisiert, damit die (teure) Markdown/KaTeX-Darstellung nicht bei jedem
// Tastendruck im Composer neu gerendert wird — Props müssen dafür stabil sein.
const ChatMessage = React.memo(function ChatMessage({ message, onExpandImage, onOpenSubagent }) {
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

  const split = splitThinkingText(message.content);
  const thinking = [message.thinking || '', split.thinking].filter(Boolean).join('\n\n');
  const content = split.content || message.content;
  const segments = Array.isArray(message.segments) ? message.segments : null;

  return (
    <>
      <MessageReplyQuote replyTo={message.replyTo} isSelf={message.from === 'self'} />
      {message.aiStopped && !content && !thinking && !(message.toolEvents?.length) && !segments ? (
        <span className="msg-ai-stopped-hint">Antwort wurde gestoppt.</span>
      ) : (
        <MessageSegments
          segments={segments}
          content={content}
          thinking={thinking}
          toolEvents={message.toolEvents}
          onOpenSubagent={onOpenSubagent}
        />
      )}
    </>
  );
});

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
    groups,
    ownPeerId,
    chatMeta,
    loadedChats,
    messages,
    aiChatProgress,
    isAiChatPending,
    settings,
    peerReadReceipts,
    chatLastViewedPeerTs,
    markPeerChatViewed,
    sendMessage,
    cancelAiChat,
    clearAiChatContext,
    sendReadReceipt,
    loadChatMessages,
    connectToAddress,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
    deleteGroupChat,
    setContactNickname,
    setChatPinned,
    setContactE2eeEnabled,
    setContactBlocked,
    setContactNotificationMute,
    deleteChat,
    deleteMessage,
    updateSettings,
    peerGamePresence,
    peerUserPresence,
  } = useApp();

  const debugMode = settings.debugMode ?? false;

  const location = useLocation();
  const navigate = useNavigate();

  const [selectedPeerId, setSelectedPeerId] = useState(null);
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [warning, setWarning] = useState('');
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [showConnect, setShowConnect] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [connectAddress, setConnectAddress] = useState('');
  const [connecting, setConnecting] = useState(false);

  const [showNickname, setShowNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTargetPeerId, setDeleteTargetPeerId] = useState(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [showClearContextConfirm, setShowClearContextConfirm] = useState(false);
  const [clearContextTargetPeerId, setClearContextTargetPeerId] = useState(null);
  const [clearingContext, setClearingContext] = useState(false);
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
  const [ollamaState, setOllamaState] = useState(null);
  const [aiAgents, setAiAgents] = useState([]);
  const [aiAgentsLoaded, setAiAgentsLoaded] = useState(false);
  const [aiProfileDraft, setAiProfileDraft] = useState({
    name: '',
    bio: '',
    profilePicture: '',
    personality: 'default',
    personalityCustom: '',
  });
  const [expandedAgentSubs, setExpandedAgentSubs] = useState(() => new Set());
  const [selectedSubagent, setSelectedSubagent] = useState(null);
  const aiProfileFileRef = useRef(null);

  const chatListCollapsed = settings.uiCollapse?.chatList === true;
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

  useEffect(() => {
    if (!window.bluetalk?.ollama) return undefined;

    let mounted = true;
    let unsubscribe = null;

    const loadOllama = async () => {
      const state = await window.bluetalk.ollama.getState();
      if (mounted) setOllamaState(state);
      unsubscribe = window.bluetalk.on('ollama:state', (nextState) => {
        if (mounted) setOllamaState(nextState);
      });
    };

    loadOllama();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  const refreshOllamaState = useCallback(async () => {
    if (!window.bluetalk?.ollama) return;
    const state = await window.bluetalk.ollama.getState();
    setOllamaState(state);
  }, []);

  const selectAiModelTier = useCallback(async (tierId) => {
    if (!window.bluetalk?.ollama?.selectModelTier) return;
    const result = await window.bluetalk.ollama.selectModelTier(tierId);
    if (result?.ok === false) {
      toast({
        variant: 'error',
        title: 'Modellwechsel fehlgeschlagen',
        message: result.error === 'cloud_auth_required'
          ? 'Melde dich zuerst bei Ollama Cloud in den Einstellungen an.'
          : (result.error || 'Das Modell konnte nicht gewechselt werden.'),
      });
    }
    await refreshOllamaState();
  }, [refreshOllamaState, toast]);

  const selectAiCloudModel = useCallback(async (cloudModelId) => {
    if (!window.bluetalk?.ollama?.selectCloudModel || !window.bluetalk?.ollama?.selectModelTier) return;
    const cloudResult = await window.bluetalk.ollama.selectCloudModel(cloudModelId);
    if (cloudResult?.ok === false) {
      toast({
        variant: 'error',
        title: 'Cloud-Modell fehlgeschlagen',
        message: cloudResult.error || 'Das Cloud-Modell konnte nicht gewählt werden.',
      });
      await refreshOllamaState();
      return;
    }
    const tierResult = await window.bluetalk.ollama.selectModelTier('cloud');
    if (tierResult?.ok === false) {
      toast({
        variant: 'error',
        title: 'Modellwechsel fehlgeschlagen',
        message: tierResult.error === 'cloud_auth_required'
          ? 'Melde dich zuerst bei Ollama Cloud in den Einstellungen an.'
          : (tierResult.error || 'Cloud konnte nicht aktiviert werden.'),
      });
    }
    await refreshOllamaState();
  }, [refreshOllamaState, toast]);

  const chatMetaRef = useRef(chatMeta);
  useEffect(() => {
    chatMetaRef.current = chatMeta;
  }, [chatMeta]);

  // chatMeta ändert sich bei jeder Nachricht in irgendeinem Chat. Für die
  // Agentenliste ist aber nur relevant, welche KI-Chat-Einträge existieren —
  // sonst würde jeder Tastendruck/jede Nachricht einen Store-Reload auslösen.
  const aiAgentMetaSignal = useMemo(() => {
    const ids = Object.keys(chatMeta || {}).filter((id) => isAiChatPeerId(id)).sort();
    const legacyHasMessages = (chatMeta?.[AI_CHAT_PEER_ID]?.count || 0) > 0;
    return `${legacyHasMessages ? '1' : '0'}:${ids.join('|')}`;
  }, [chatMeta]);

  useEffect(() => {
    if (!window.bluetalk?.store) {
      setAiAgentsLoaded(true);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const stored = await window.bluetalk.store.get('aiChat.agents', []);
      if (cancelled) return;
      const meta = chatMetaRef.current || {};
      const normalized = Array.isArray(stored)
        ? stored
            .filter((agent) => agent?.id && isAiChatPeerId(agent.id))
            .map(normalizeAiAgent)
        : [];

      if (normalized.length === 0 && meta[AI_CHAT_PEER_ID]?.count > 0) {
        const legacyAgent = {
          id: AI_CHAT_PEER_ID,
          name: 'KI-Assistent',
          createdAt: meta[AI_CHAT_PEER_ID]?.lastMessage?.timestamp || Date.now(),
        };
        await window.bluetalk.store.set('aiChat.agents', [legacyAgent]);
        if (!cancelled) {
          setAiAgents([legacyAgent]);
          setAiAgentsLoaded(true);
        }
        return;
      }

      // Identische Payloads nicht neu setzen — sonst invalidieren frische
      // Array-Referenzen unnötig das chatList-Memo.
      setAiAgents((prev) => (
        prev.length === normalized.length && JSON.stringify(prev) === JSON.stringify(normalized)
          ? prev
          : normalized
      ));
      setAiAgentsLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [aiAgentMetaSignal]);

  const updateAiAgent = useCallback(async (agentId, patch) => {
    setAiAgents((prev) => {
      const next = prev.map((agent) => {
        if (agent.id !== agentId) return agent;
        return normalizeAiAgent({ ...agent, ...patch });
      });
      if (window.bluetalk?.store) {
        void window.bluetalk.store.set('aiChat.agents', next);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!showPeerProfile || !selectedPeerId) return;
    const agent = aiAgents.find((entry) => entry.id === selectedPeerId);
    if (!agent) return;
    setAiProfileDraft({
      name: agent.name || '',
      bio: agent.bio || '',
      profilePicture: agent.profilePicture || '',
      personality: agent.personality || 'default',
      personalityCustom: agent.personalityCustom || '',
    });
  }, [showPeerProfile, selectedPeerId, aiAgents]);

  const chatListWidthPx = chatListPreview ?? chatListCommitted;

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

  const toggleChatListCollapse = useCallback(() => {
    updateSettings({ uiCollapse: { chatList: !chatListCollapsed } });
  }, [chatListCollapsed, updateSettings]);

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
  const chatMessagesRef = useRef(null);
  const keepChatPinnedRef = useRef(true);
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
    for (const id of [...ids]) {
      if (isAiChatPeerId(id) || isGroupChatId(id)) ids.delete(id);
    }

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
        gamePresence: peerGamePresence[id] && !isPresenceStale(peerGamePresence[id])
          ? peerGamePresence[id]
          : null,
        userPresence: peerUserPresence[id] || null,
      });
    }

    const sorted = list.sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      const aTs = a.lastMessage?.timestamp || a.contact?.addedAt || 0;
      const bTs = b.lastMessage?.timestamp || b.contact?.addedAt || 0;
      return bTs - aTs;
    });

    const aiEntries = aiAgents.map((agent) => {
      const aiMeta = chatMeta[agent.id] || null;
      return {
        id: agent.id,
        peer: null,
        contact: null,
        displayName: agent.name || 'KI-Assistent',
        baseName: agent.name || 'KI-Assistent',
        profilePicture: agent.profilePicture || '',
        bio: agent.bio || '',
        offline: false,
        pinned: false,
        isAiChat: true,
        isAgent: true,
        agentWorkDir: agent.agentWorkDir || '',
        e2eePlaintextBadge: false,
        lastMessage: aiMeta?.lastMessage || null,
        messageCount: aiMeta?.count || 0,
        createdAt: agent.createdAt || 0,
      };
    });

    const groupEntries = (groups || []).map((group) => {
      const groupMeta = chatMeta[group.id] || null;
      const activeMembers = group.members.filter((member) => member.state === 'active');
      const onlineMembers = activeMembers.filter((member) => member.peerId === ownPeerId || peerById.has(member.peerId));
      return {
        id: group.id,
        peer: null,
        contact: null,
        group,
        isGroup: true,
        displayName: group.name,
        baseName: group.name,
        profilePicture: group.image || '',
        bio: '',
        offline: onlineMembers.length <= 1,
        pinned: false,
        e2eePlaintextBadge: false,
        lastMessage: groupMeta?.lastMessage || null,
        messageCount: groupMeta?.count || 0,
        activeMemberCount: activeMembers.length,
        onlineMemberCount: onlineMembers.length,
        canSend: isActiveGroupMember(group, ownPeerId),
        createdAt: group.createdAt || 0,
      };
    });

    return [...aiEntries, ...groupEntries, ...sorted].sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
      const aTs = a.lastMessage?.timestamp || a.contact?.addedAt || a.createdAt || 0;
      const bTs = b.lastMessage?.timestamp || b.contact?.addedAt || b.createdAt || 0;
      return bTs - aTs;
    });
  }, [aiAgents, chatMeta, contactById, contacts, groups, ownPeerId, peerById, peers, peerGamePresence, peerUserPresence]);

  const mainChatList = useMemo(
    () =>
      chatList.filter((chat) => {
        if (chat.isAiChat || chat.isGroup) return true;
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

  const isAiChatSelected = Boolean(selectedPeer?.isAiChat || isAiChatPeerId(selectedPeer?.id));
  const isGroupSelected = Boolean(selectedPeer?.isGroup && selectedPeer.group);
  const aiChatSupportsVision = modelSupportsVision(
    ollamaState?.selectedModelTier,
    ollamaState?.selectedCloudModelId
  );
  const showAiComposerAttach = !isAiChatSelected || aiChatSupportsVision;
  const aiChatNeedsSetup = isAiChatSelected && !ollamaState?.setupComplete;
  const aiChatPending = isAiChatPending(selectedPeer?.id);
  const liveAiProgress = aiChatProgress?.peerId === selectedPeer?.id ? aiChatProgress : null;

  const selectedContact = useMemo(
    () => (selectedPeer ? resolveContact(selectedPeer.id) : null),
    [selectedPeer, resolveContact]
  );

  const peerPendingDelete = useMemo(
    () => (deleteTargetPeerId ? chatList.find((c) => c.id === deleteTargetPeerId) || null : null),
    [chatList, deleteTargetPeerId]
  );

  const peerPendingClear = useMemo(
    () => (clearContextTargetPeerId ? chatList.find((c) => c.id === clearContextTargetPeerId) || null : null),
    [chatList, clearContextTargetPeerId]
  );

  const subagentsByPeer = useMemo(
    () => collectSubagentsByPeer(messages, aiChatProgress),
    [messages, aiChatProgress]
  );

  const selectedSubagentSegment = useMemo(() => {
    if (!selectedSubagent) return null;
    const subs = subagentsByPeer[selectedSubagent.parentPeerId] || [];
    return subs.find((entry) => entry.id === selectedSubagent.subagentId) || null;
  }, [selectedSubagent, subagentsByPeer]);

  const openSubagentChat = useCallback((parentPeerId, subagentId) => {
    if (!parentPeerId || !subagentId) return;
    setExpandedAgentSubs((prev) => {
      const next = new Set(prev);
      next.add(parentPeerId);
      return next;
    });
    setSelectedPeerId(parentPeerId);
    setSelectedSubagent({ parentPeerId, subagentId });
  }, []);

  // Stabile Referenz für ChatMessage (React.memo) — eine Inline-Closure würde
  // das Memo bei jedem Render der Nachrichtenliste aushebeln.
  const openSubagentForSelectedChat = useCallback(
    (segment) => openSubagentChat(selectedPeerId, segment?.id),
    [openSubagentChat, selectedPeerId]
  );

  const closeSubagentChat = useCallback(() => {
    setSelectedSubagent(null);
  }, []);

  useEffect(() => {
    if (!selectedSubagent) return;
    if (!selectedSubagentSegment) setSelectedSubagent(null);
  }, [selectedSubagent, selectedSubagentSegment]);

  useEffect(() => {
    setExpandedAgentSubs((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const [peerId, subs] of Object.entries(subagentsByPeer)) {
        if (subs.some((seg) => seg.status === 'running') && !next.has(peerId)) {
          next.add(peerId);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [subagentsByPeer]);

  const toggleAgentSubsExpanded = useCallback((peerId, event) => {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    setExpandedAgentSubs((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  }, []);

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
    setSelectedSubagent((prev) => {
      if (!prev) return null;
      if (prev.parentPeerId === selectedPeerId) return prev;
      return null;
    });
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
    const mh = 220;
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
      !isAiChatSelected &&
      !isGroupSelected &&
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

  useEffect(() => {
    if (showAiComposerAttach) return;
    setAttachMenuOpen(false);
    if (pendingFile) clearPendingFile();
  }, [showAiComposerAttach, pendingFile, clearPendingFile]);

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
      || (!isGroupSelected && contactOutgoingBlocked(selectedPeer?.contact))
      || (isGroupSelected && !selectedPeer.canSend)
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
      const result = await sendMessage(selectedPeer.id, withPreview);
      // Gruppen-Sends liefern ein Objekt ({ ok, error }), Direkt-Sends ein Boolean.
      const ok = result === true || result?.ok === true;
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
      // KI-Agenten erst verwerfen, wenn die Agentenliste geladen ist — sonst
      // geht die Auswahl eines frisch erstellten Agenten (openPeerId aus der
      // Navigation) verloren, bevor er in chatList auftauchen kann.
      if (isAiChatPeerId(selectedPeerId) && !aiAgentsLoaded) return;
      setSelectedPeerId(null);
    }
  }, [chatList, selectedPeerId, aiAgentsLoaded]);

  useEffect(() => {
    setShowPeerProfile(false);
    setShowGroupInfo(false);
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
    keepChatPinnedRef.current = true;
    endRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [selectedPeerId]);

  const updateChatPinnedState = useCallback(() => {
    const el = chatMessagesRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    keepChatPinnedRef.current = distanceFromBottom < 96;
  }, []);

  useLayoutEffect(() => {
    if (!keepChatPinnedRef.current) return;
    endRef.current?.scrollIntoView({ behavior: aiChatProgress?.content ? 'auto' : 'smooth' });
  }, [
    newestTimestamp,
    selectedPeerId,
    aiChatProgress?.segments?.length,
    aiChatProgress?.content ? Math.floor(String(aiChatProgress.content).length / 320) : 0,
  ]);

  useEffect(() => {
    if (!selectedPeerId || isAiChatPeerId(selectedPeerId)) return;
    const peerMsgs = messages[selectedPeerId] || [];
    const upTo = peerMsgs.reduce((acc, m) => {
      if (m.from !== 'self' && typeof m.timestamp === 'number') return Math.max(acc, m.timestamp);
      return acc;
    }, 0);
    if (upTo > 0) markPeerChatViewed(selectedPeerId, upTo);
  }, [selectedPeerId, messages, markPeerChatViewed]);

  useEffect(() => {
    if (!selectedPeerId || isAiChatPeerId(selectedPeerId) || !settings.sendReadReceipts) return;
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

  useEffect(() => {
    if (showClearContextConfirm && clearContextTargetPeerId && !peerPendingClear) {
      setShowClearContextConfirm(false);
      setClearContextTargetPeerId(null);
    }
  }, [showClearContextConfirm, clearContextTargetPeerId, peerPendingClear]);

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
      setReplyToMessage(null);

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
        setReplyToMessage(null);
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

  const queuePendingFile = async (file) => {
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
          type: normalizeAttachmentFileType(file.name, file.type || 'application/octet-stream', data.base64),
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

  const handleFilePicked = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    await queuePendingFile(file);
  };

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
      if (isGroupChatId(deleteTargetPeerId)) {
        await deleteGroupChat(deleteTargetPeerId);
      } else {
        await deleteChat(deleteTargetPeerId);
        if (isAiChatPeerId(deleteTargetPeerId)) {
          setAiAgents((prev) => prev.filter((agent) => agent.id !== deleteTargetPeerId));
        }
      }
      if (selectedPeerId === deleteTargetPeerId) {
        setSelectedPeerId(null);
      }
      setShowGroupInfo(false);
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

  const openClearContextForPeer = (peerId) => {
    if (!isAiChatPeerId(peerId)) return;
    setClearContextTargetPeerId(peerId);
    setShowClearContextConfirm(true);
    closeListContextMenu();
    setChatActionsMenuOpen(false);
  };

  const confirmClearContext = async () => {
    if (!clearContextTargetPeerId) return;
    setClearingContext(true);
    try {
      await clearAiChatContext(clearContextTargetPeerId);
      toast({
        variant: 'success',
        title: 'Verlauf geleert',
        message: 'Chatverlauf und Agent-Kontext wurden zurückgesetzt.',
      });
      setWarning('');
      setShowClearContextConfirm(false);
      setClearContextTargetPeerId(null);
    } catch (err) {
      const msg = err?.message || 'Verlauf konnte nicht geleert werden.';
      setWarning(msg);
      toast({ variant: 'error', title: 'Fehler', message: msg });
    } finally {
      setClearingContext(false);
    }
  };

  const openNicknameForChat = (chat) => {
    setSelectedPeerId(chat.id);
    setNicknameInput(chat.contact?.nickname || '');
    setShowNickname(true);
    closeListContextMenu();
  };

  const openAiProfileEditor = (chat) => {
    if (chat?.id) setSelectedPeerId(chat.id);
    setShowPeerProfile(true);
    closeListContextMenu();
  };

  const saveAiProfile = async () => {
    if (!selectedPeer?.isAiChat) return;
    await updateAiAgent(selectedPeer.id, {
      name: aiProfileDraft.name.trim() || 'KI-Assistent',
      bio: aiProfileDraft.bio.slice(0, 500),
      profilePicture: aiProfileDraft.profilePicture || '',
      personality: aiProfileDraft.personality,
      personalityCustom: aiProfileDraft.personalityCustom.trim().slice(0, AI_PERSONALITY_CUSTOM_MAX_CHARS),
    });
    setShowPeerProfile(false);
    toast({ variant: 'success', title: 'Profil gespeichert' });
  };

  const onAiAvatarPick = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageDataUrl(file);
      setAiProfileDraft((prev) => ({ ...prev, profilePicture: dataUrl }));
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Profilbild',
        message: err?.message || 'Bild konnte nicht verwendet werden.',
      });
    }
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

  const renderChatListRow = useCallback((chat, { nested = false } = {}) => {
    const chatContact = resolveContact(chat.id);
    const unreadCount = !chat.isAiChat
      ? countUnreadPeerMessages(
          chat.id,
          chatLastViewedPeerTs[chat.id],
          messages,
          chat.lastMessage
        )
      : 0;
    const subagents = chat.isAgent ? (subagentsByPeer[chat.id] || []) : [];
    const hasSubagents = subagents.length > 0;
    const subagentsExpanded = hasSubagents && expandedAgentSubs.has(chat.id);
    const runningSubagentCount = subagents.filter((seg) => seg.status === 'running').length;
    const isParentActive = selectedPeer?.id === chat.id && selectedSubagent?.parentPeerId !== chat.id;

    return (
      <React.Fragment key={chat.id}>
        <div
          className={`list-item ${isParentActive ? 'active' : ''}${chat.contact?.blocked ? ' list-item--blocked' : ''}${chat.contact?.blockedByPeer ? ' list-item--blocked-by-peer' : ''}${unreadCount > 0 ? ' list-item--has-unread' : ''}${chat.isAiChat ? ' list-item--ai' : ''}${chat.isGroup ? ' list-item--group' : ''}${nested ? ' list-item--nested' : ''}${hasSubagents ? ' list-item--expandable' : ''}${subagentsExpanded ? ' list-item--expanded' : ''}`}
          onClick={() => {
            setSelectedSubagent(null);
            setSelectedPeerId(chat.id);
          }}
          onContextMenu={(e) => openChatListContextMenu(e, chat)}
        >
          {hasSubagents ? (
            <button
              type="button"
              className="list-item-expand-btn"
              aria-expanded={subagentsExpanded}
              aria-label={subagentsExpanded ? 'Sub-Agenten einklappen' : 'Sub-Agenten ausklappen'}
              title={subagentsExpanded ? 'Sub-Agenten einklappen' : 'Sub-Agenten ausklappen'}
              onClick={(e) => toggleAgentSubsExpanded(chat.id, e)}
            >
              <ChevronDown
                size={14}
                strokeWidth={CHAT_ICON_STROKE}
                aria-hidden
                className={`list-item-expand-chevron${subagentsExpanded ? '' : ' list-item-expand-chevron--collapsed'}`}
              />
            </button>
          ) : null}
          {chat.isGroup ? (
            chat.profilePicture ? (
              <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
            ) : (
              <div className="group-chat-list-avatar" aria-hidden><Users size={19} strokeWidth={CHAT_ICON_STROKE} /></div>
            )
          ) : chat.isAiChat ? (
            chat.profilePicture ? (
              <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
            ) : (
              <div className="ai-chat-list-avatar" aria-hidden>
                <Bot size={20} strokeWidth={CHAT_ICON_STROKE} />
              </div>
            )
          ) : (
            <PeerAvatar pictureUrl={chat.profilePicture} name={chat.displayName} size={36} />
          )}
          <div className="list-item-info">
            <div className="list-item-name-row">
              <div className="list-item-name">{chat.displayName}</div>
              {chat.isAgent ? (
                <span className="ai-agent-badge" title="Agent-Modus — kann Dateien, Befehle und BlueTalk-Werkzeuge nutzen">
                  Agent
                </span>
              ) : null}
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
              {isContactNotificationMuted(chatContact) && (
                <span className="chat-pin-badge" title="Mitteilungen stumm">
                  <BellOff size={12} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                </span>
              )}
            </div>
            <div className="list-item-sub">
              {chat.isGroup
                ? (chat.lastMessage
                  ? `${chat.lastMessage.from === 'self' ? 'Du' : (chat.lastMessage.sender || 'Mitglied')}: ${getLastPreview(chat.lastMessage, debugMode).replace(/^You: |^Du: /, '')}`
                  : `${chat.activeMemberCount} Mitglieder · Ende-zu-Ende-verschlüsselt`)
                : chat.isAiChat
                ? (isAiChatPending(chat.id)
                  ? (runningSubagentCount > 0
                    ? `${runningSubagentCount} Sub-Agent${runningSubagentCount === 1 ? '' : 'en'} aktiv…`
                    : 'Antwort wird erstellt…')
                  : (hasSubagents && !subagentsExpanded
                    ? `${subagents.length} Sub-Agent${subagents.length === 1 ? '' : 'en'}`
                    : (ollamaState?.setupComplete
                      ? 'Agent · bereit'
                      : 'Einrichtung nötig')))
                : chat.gamePresence
                  ? formatGamePresenceLabel(chat.gamePresence)
                  : getLastPreview(chat.lastMessage, debugMode)}
            </div>
          </div>
          <div className="chat-list-meta">
            {chat.lastMessage && <span className="list-item-meta">{formatTime(chat.lastMessage.timestamp)}</span>}
            <div className="chat-list-meta-row">
              {unreadCount > 0 && (
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
              {chat.isGroup ? (
                <span className="group-chat-list-badge" title={`${chat.activeMemberCount} Mitglieder`}><Users size={12} /> {chat.activeMemberCount}</span>
              ) : chat.isAiChat ? (
                isAiChatPending(chat.id) ? (
                  <span className="ai-chat-list-badge ai-chat-list-badge--pending" title="Antwort wird erstellt">
                    <span className="spinner spinner--sm" aria-hidden />
                  </span>
                ) : (
                  <span className="ai-chat-list-badge" title="KI-Chat">KI</span>
                )
              ) : (
                <>
                {chat.gamePresence ? (
                  <span className="game-presence-list-badge" title={formatGamePresenceLabel(chat.gamePresence)}>
                    {chat.gamePresence.game === 'poker' ? '♠' : chat.gamePresence.game === 'connect-four' ? '🔴' : chat.gamePresence.game === 'chess' ? '♟' : chat.gamePresence.game === 'tic-tac-toe' ? '✕' : '🎴'}
                  </span>
                ) : null}
                {!chat.offline && isPeerDoNotDisturb(chat.userPresence) ? (
                  <span className="dnd-dot" title="Nicht stören" />
                ) : (
                  <span className={chat.offline ? 'offline-dot' : 'online-dot'} />
                )}
                </>
              )}
            </div>
          </div>
        </div>
        {subagentsExpanded ? subagents.map((sub) => {
          const taskPreview = String(sub.task || '').trim();
          const shortTask = taskPreview.length > 72 ? `${taskPreview.slice(0, 72)}…` : taskPreview;
          const running = sub.status === 'running';
          const failed = sub.status === 'error';
          const isSubagentActive = selectedSubagent?.parentPeerId === chat.id && selectedSubagent?.subagentId === sub.id;
          return (
            <div
              key={`sub-${sub.id}`}
              className={`list-item list-item--subagent${isSubagentActive ? ' active' : ''}${running ? ' list-item--subagent-live' : ''}${failed ? ' list-item--subagent-error' : ''}`}
              aria-label={`Sub-Agent · ${subagentStatusLabel(sub.status)}`}
              role="button"
              tabIndex={0}
              onClick={() => openSubagentChat(chat.id, sub.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openSubagentChat(chat.id, sub.id);
                }
              }}
            >
              <div className="ai-chat-list-avatar list-item--subagent-icon" aria-hidden>
                <Bot size={16} strokeWidth={CHAT_ICON_STROKE} />
              </div>
              <div className="list-item-info">
                <div className="list-item-name-row">
                  <div className="list-item-name">Sub-Agent · {subagentStatusLabel(sub.status)}</div>
                  {running ? (
                    <span className="ai-chat-list-badge ai-chat-list-badge--pending" title="Sub-Agent läuft">
                      <span className="spinner spinner--sm" aria-hidden />
                    </span>
                  ) : null}
                </div>
                <div className="list-item-sub">
                  {shortTask || (running ? 'Teilaufgabe wird bearbeitet…' : (failed ? (sub.error || 'Fehlgeschlagen') : 'Abgeschlossen'))}
                </div>
              </div>
            </div>
          );
        }) : null}
      </React.Fragment>
    );
  }, [
    chatLastViewedPeerTs,
    debugMode,
    expandedAgentSubs,
    isAiChatPending,
    messages,
    ollamaState?.setupComplete,
    openChatListContextMenu,
    openSubagentChat,
    resolveContact,
    selectedPeer?.id,
    selectedSubagent,
    subagentsByPeer,
    toggleAgentSubsExpanded,
  ]);

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
      <CreateGroupModal
        open={showCreateGroup}
        contacts={contacts}
        peers={peers}
        onCreate={createGroupChat}
        onClose={(groupId) => {
          setShowCreateGroup(false);
          if (groupId) setSelectedPeerId(groupId);
        }}
      />
      <GroupInfoModal
        open={showGroupInfo && isGroupSelected}
        group={selectedPeer?.group || null}
        ownPeerId={ownPeerId}
        contacts={contacts}
        peers={peers}
        onUpdate={updateGroupChat}
        onLeave={leaveGroupChat}
        onDelete={deleteGroupChat}
        onClose={() => setShowGroupInfo(false)}
      />
      <div className="split-layout">
        {chatListCollapsed ? (
          <button
            type="button"
            className="panel-collapse-strip panel-collapse-strip--chat-list"
            onClick={toggleChatListCollapse}
            title="Chatliste einblenden"
            aria-label="Chatliste einblenden"
            aria-expanded={false}
          >
            <PanelLeftOpen size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          </button>
        ) : (
        <div
          className="split-list split-list--resizable"
          style={{ width: chatListWidthPx, flexShrink: 0 }}
        >
          <div className="split-list-header">
            <h2>Chats</h2>
            <div className="split-list-header-actions">
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => setShowCreateGroup(true)}
                title="Neue Gruppe"
                aria-label="Neue Gruppe"
              >
                <Users size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-icon btn-sm"
                onClick={toggleChatListCollapse}
                title="Chatliste einklappen"
                aria-label="Chatliste einklappen"
                aria-expanded
              >
                <PanelLeftClose size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
            </div>
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
            {filtered.map((chat) => renderChatListRow(chat))}
          </div>
        </div>
        )}
        {!chatListCollapsed ? (
          <VerticalResizeHandle
            onBegin={onChatListResizeBegin}
            onDelta={onChatListResizeDelta}
            onCommit={commitChatListWidth}
            onDoubleClick={resetChatListWidth}
          />
        ) : null}

        <div className="split-detail split-detail--resizable">
          {!selectedPeer ? (
            <div className="chat-empty">
              <div className="empty-state">
                <p>Select a conversation to start messaging</p>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowConnect(true)}>
                  Connect to peer
                </button>
              </div>
            </div>
          ) : selectedSubagentSegment ? (
            <SubagentChatView
              segment={selectedSubagentSegment}
              parentPeer={selectedPeer}
              live={aiChatProgress?.peerId === selectedPeer?.id}
              onBack={closeSubagentChat}
            />
          ) : aiChatNeedsSetup ? (
            <div className="ai-chat-setup-wrap">
              <div className="chat-header">
                <button
                  type="button"
                  className="chat-header-profile-btn"
                  onClick={() => setShowPeerProfile(true)}
                  aria-haspopup="dialog"
                  title="Profil bearbeiten"
                >
                  <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <div className="font-medium truncate" style={{ fontSize: 14 }}>{selectedPeer.displayName}</div>
                    <div className="text-sm text-muted chat-header-meta">Einrichtung ausstehend</div>
                  </div>
                </button>
              </div>
              <div className="ai-chat-setup-prompt animate-fade">
                <Bot size={40} strokeWidth={1.5} aria-hidden />
                <h3>KI-Chat noch nicht eingerichtet</h3>
                <p className="text-muted">
                  Ollama und ein Modell werden in den Einstellungen eingerichtet. Danach kannst du hier chatten.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => navigate('/settings/ai')}
                >
                  Zu den Einstellungen
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
                  onClick={() => isGroupSelected ? setShowGroupInfo(true) : setShowPeerProfile(true)}
                  aria-haspopup="dialog"
                  aria-expanded={isGroupSelected ? showGroupInfo : showPeerProfile}
                  title={isGroupSelected ? 'Gruppeninfo' : isAiChatSelected ? 'Profil bearbeiten' : 'Profil anzeigen'}
                >
                  <PeerAvatar pictureUrl={selectedPeer.profilePicture} name={selectedPeer.displayName} size={40} />
                  <div style={{ minWidth: 0 }}>
                    <div className="font-medium truncate" style={{ fontSize: 14 }}>{selectedPeer.displayName}</div>
                    <div className="text-sm text-muted chat-header-meta">
                      <span>
                        {isGroupSelected
                          ? `${selectedPeer.activeMemberCount} Mitglieder · ${Math.max(0, selectedPeer.onlineMemberCount - 1)} online · E2EE`
                          : isAiChatSelected
                          ? 'Online'
                          : selectedPeer.gamePresence
                            ? formatGamePresenceLabel(selectedPeer.gamePresence)
                            : !selectedPeer.offline && isPeerDoNotDisturb(selectedPeer.userPresence)
                              ? formatUserPresenceLabel(selectedPeer.userPresence)
                            : selectedPeer.contact?.blocked
                            ? 'Blockiert'
                            : selectedPeer.contact?.blockedByPeer
                              ? 'Du wurdest blockiert'
                              : selectedPeer.contact?.chatDeletedByPeer
                                ? 'Chat gelöscht'
                                : selectedPeer.offline
                                  ? 'Offline'
                                  : 'Online'}
                        {!isAiChatSelected && !isGroupSelected && selectedPeer.contact?.nickname && selectedPeer.baseName !== selectedPeer.contact.nickname
                          ? ` · ${selectedPeer.baseName}`
                          : ''}
                        {!isAiChatSelected && !contactE2eePreferenceOn(selectedPeer.contact) ? ' · Klartext (ausgehend)' : ''}
                        {!isAiChatSelected && isContactNotificationMuted(selectedContact)
                          ? ' · Mitteilungen stumm'
                          : ''}
                      </span>
                      {isAiChatSelected ? (
                        selectedPeer.bio ? (
                          <span className="chat-header-bio" title={selectedPeer.bio}>
                            {selectedPeer.bio}
                          </span>
                        ) : null
                      ) : selectedPeer.bio ? (
                        <span className="chat-header-bio" title={selectedPeer.bio}>
                          {selectedPeer.bio}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </button>
                {isGroupSelected && (
                  <div className="chat-header-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      onClick={() => setShowGroupInfo(true)}
                      title="Gruppeninfo"
                      aria-label="Gruppeninfo"
                    >
                      <Users size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    </button>
                  </div>
                )}
                {!isAiChatSelected && !isGroupSelected && (
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
                      {!selectedContact?.blocked ? (
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
                )}
                {isAiChatSelected && (
                  <div className="chat-header-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      aria-label="Profil bearbeiten"
                      title="Profil bearbeiten"
                      onClick={() => setShowPeerProfile(true)}
                    >
                      <Pencil size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    </button>
                    <AiChatModelPicker
                      ollamaState={ollamaState}
                      disabled={aiChatPending}
                      debugMode={debugMode}
                      onSelectTier={selectAiModelTier}
                      onSelectCloudModel={selectAiCloudModel}
                      onOpenCloudSettings={() => navigate('/settings/ai')}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      aria-label="Verlauf leeren"
                      title="Verlauf leeren"
                      disabled={aiChatPending || clearingContext}
                      onClick={() => openClearContextForPeer(selectedPeer.id)}
                    >
                      <Eraser size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-icon"
                      aria-label="KI-Chat löschen"
                      title="KI-Chat löschen"
                      onClick={() => openDeleteForPeer(selectedPeer.id)}
                    >
                      <Trash2 size={18} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    </button>
                  </div>
                )}
              </div>

              <div className={`chat-messages${isAiChatSelected ? ' chat-messages--ai' : ''}`} ref={chatMessagesRef} onScroll={updateChatPinnedState}>
                {false ? (
                  <div className="empty-state ai-chat-ready-placeholder">
                    <Bot size={36} strokeWidth={1.5} aria-hidden />
                    <p>KI-Chat ist eingerichtet. Die Chat-Unterhaltung wird als Nächstes implementiert.</p>
                  </div>
                ) : (
                <>
                {isGroupSelected && !selectedPeer.canSend ? (
                  <div className="chat-warning" role="status">
                    {getGroupMember(selectedPeer.group, ownPeerId)?.state === 'invited'
                      ? 'Dein Beitritt wird bestätigt. Danach kannst du in der Gruppe schreiben.'
                      : 'Du bist nicht mehr Mitglied dieser Gruppe. Der bisherige Verlauf bleibt auf diesem Gerät erhalten, neue Nachrichten werden nicht mehr zugestellt.'}
                  </div>
                ) : null}
                {!selectedPeer.contact?.blocked &&
                  !selectedPeer.contact?.blockedByPeer &&
                  selectedPeer.gamePresence ? (
                    <GamePresenceBanner
                      peerId={selectedPeer.id}
                      presence={selectedPeer.gamePresence}
                    />
                  ) : null}
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
                {!selectedContact?.blocked &&
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
                  const senderContact = isGroupSelected && !isSelf ? contactById.get(m.senderPeerId || m.from) : null;
                  const bubblePic = isSelf
                    ? settings.profilePicture
                    : isGroupSelected
                      ? (senderContact?.profilePicture || '')
                      : selectedPeer.profilePicture;
                  const bareMedia = isBareMediaMessage(m);
                  const embedMessage = isChatEmbedMessage(m, debugMode);
                  const isAiAgentMessage = isAiChatSelected && !isSelf;
                  const outsideBubble = bareMedia || embedMessage;
                  const delivery = selfDeliveryLabel(m);
                  const seen = isSelf && readUpToId && m.messageId && readUpToId === m.messageId ? 'Seen' : '';
                  const isSelected = Boolean(m.messageId && selectedMessageIds.has(m.messageId));
                  const aiStats = !isSelf && m.aiStats && typeof m.aiStats === 'object' ? m.aiStats : null;
                  return (
                    <div
                      key={m.messageId || `${m.timestamp || i}-${m.from || 'msg'}-${i}`}
                      className={[
                        'msg-row',
                        isSelf ? 'msg-row-self' : 'msg-row-other',
                        outsideBubble && 'msg-row--bare',
                        isAiAgentMessage && 'msg-row--ai-agent',
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
                      {!selectionMode && !isAiAgentMessage ? (
                        <PeerAvatar pictureUrl={bubblePic} name={bubbleName} size={28} className="msg-avatar" />
                      ) : null}
                      <div
                        className={['msg', isSelf ? 'msg-self' : isAiAgentMessage ? 'msg--ai-agent' : 'msg-other', bareMedia && 'msg--bare-media', embedMessage && 'msg--embed', 'animate-in']
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
                        ) : m.kind === 'connect-four-invite' ? (
                          <ConnectFourInviteMessage message={m} />
                        ) : m.kind === 'chess-invite' ? (
                          <ChessInviteMessage message={m} />
                        ) : m.kind === 'tic-tac-toe-invite' ? (
                          <TicTacToeInviteMessage message={m} />
                        ) : m.kind === 'live-docs-invite' ? (
                          <LiveDocsInviteMessage message={m} />
                        ) : m.kind === 'uno-invite' && debugMode ? (
                          <UnoInviteMessage message={m} />
                        ) : m.kind === 'uno-invite' ? (
                          <ChatMessage
                            message={m}
                            onExpandImage={setMediaLightbox}
                            onOpenSubagent={isAiChatSelected ? openSubagentForSelectedChat : undefined}
                          />
                        ) : m.kind === 'contact-share' ? (
                          <ContactShareMessage
                            message={m}
                            isConnected={Boolean(peers.find((p) => p.id === (m.sharedContact?.id || m.from)))}
                            onConnect={connectFromSharedContact}
                          />
                        ) : (
                          <ChatMessage
                            message={m}
                            onExpandImage={setMediaLightbox}
                            onOpenSubagent={isAiChatSelected ? openSubagentForSelectedChat : undefined}
                          />
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
                          {aiStats?.tps > 0 ? (
                            <span className="msg-ai-stat">{aiStats.tps.toFixed(1)} t/s</span>
                          ) : null}
                          {aiStats?.genTimeMs > 0 ? (
                            <span className="msg-ai-stat">gen {formatGenTime(aiStats.genTimeMs)}</span>
                          ) : null}
                          {m.aiStopped ? (
                            <span className="msg-ai-stat msg-ai-stat--stopped">Gestoppt</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {isAiChatSelected && aiChatPending ? (
                  <div className="msg-row msg-row-other msg-row--ai-agent msg-row--ai-agent-live">
                    <div className="msg msg--ai-agent msg--ai-agent-live animate-in">
      {(() => {
        const split = splitThinkingText(liveAiProgress?.content || '');
        const thinking = [liveAiProgress?.thinking || '', split.thinking].filter(Boolean).join('\n\n');
        const content = split.content || liveAiProgress?.content || '';
        const toolEvents = Array.isArray(liveAiProgress?.toolEvents) ? liveAiProgress.toolEvents : [];
        const segments = Array.isArray(liveAiProgress?.segments) ? liveAiProgress.segments : null;
        const hasAnything = thinking || content || toolEvents.length || (segments && segments.length);
        return (
          <>
      <MessageSegments
        segments={segments}
        content={content}
        thinking={thinking}
        toolEvents={toolEvents}
        live
        onOpenSubagent={(segment) => openSubagentChat(selectedPeer.id, segment.id)}
      />
      {!hasAnything ? (
        <div className="spinner-label">
          <span className="spinner spinner--sm" />
          <span>Antwort wird erstellt...</span>
        </div>
      ) : null}
          </>
        );
      })()}
                      <div className="msg-meta msg-ai-live-meta">
                        {typeof liveAiProgress?.tps === 'number' && liveAiProgress.tps > 0 ? (
                          <span className="msg-ai-stat">{liveAiProgress.tps.toFixed(1)} t/s</span>
                        ) : null}
                        {typeof liveAiProgress?.genTimeMs === 'number' && liveAiProgress.genTimeMs > 0 ? (
                          <span className="msg-ai-stat">gen {formatGenTime(liveAiProgress.genTimeMs)}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ) : null}
                <div ref={endRef} />
                </>
                )}
              </div>

              {selectedPeer && (
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
                      <span className="chat-reply-bar-preview">{getMessagePreviewText(replyToMessage, debugMode)}</span>
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
                  {showAiComposerAttach ? (
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
              )}
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

      {showPeerProfile && selectedPeer && selectedPeer.isAiChat && (
        <div className="modal-overlay" onClick={() => setShowPeerProfile(false)} role="presentation">
          <div
            className="modal animate-scale peer-profile-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ai-profile-title"
          >
            <div className="peer-profile-modal-toolbar">
              <h2 id="ai-profile-title" className="peer-profile-modal-title">
                KI-Profil
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
              <div className="profile-menu-avatar-row">
                {aiProfileDraft.profilePicture ? (
                  <img src={aiProfileDraft.profilePicture} alt="" className="profile-menu-preview" />
                ) : (
                  <div className="profile-menu-preview profile-menu-preview-placeholder ai-chat-list-avatar">
                    <Bot size={28} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  </div>
                )}
                <div className="profile-menu-avatar-actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => aiProfileFileRef.current?.click()}
                  >
                    Bild ändern
                  </button>
                  {aiProfileDraft.profilePicture ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setAiProfileDraft((prev) => ({ ...prev, profilePicture: '' }))}
                    >
                      Entfernen
                    </button>
                  ) : null}
                </div>
                <input
                  ref={aiProfileFileRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={onAiAvatarPick}
                />
              </div>
              <div className="input-group">
                <label htmlFor="ai-profile-name">Name</label>
                <input
                  id="ai-profile-name"
                  className="input"
                  value={aiProfileDraft.name}
                  onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, name: e.target.value }))}
                  maxLength={64}
                  autoFocus
                />
              </div>
              <div className="input-group">
                <label htmlFor="ai-profile-bio">Info</label>
                <textarea
                  id="ai-profile-bio"
                  className="input profile-menu-bio"
                  rows={3}
                  maxLength={500}
                  placeholder="Kurze Beschreibung für diesen KI-Assistenten"
                  value={aiProfileDraft.bio}
                  onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, bio: e.target.value }))}
                />
              </div>
              <div className="input-group">
                <span className="input-group-label">Persönlichkeit</span>
                <div className="ai-personality-grid" role="radiogroup" aria-label="Persönlichkeit">
                  {Object.values(AI_PERSONALITY_PRESETS).map((preset) => {
                    const selected = aiProfileDraft.personality === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`ai-personality-option${selected ? ' ai-personality-option--selected' : ''}`}
                        onClick={() => setAiProfileDraft((prev) => ({ ...prev, personality: preset.id }))}
                        role="radio"
                        aria-checked={selected}
                      >
                        <span className="ai-personality-option-label">{preset.label}</span>
                        <span className="ai-personality-option-desc">{preset.description}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="input-group">
                <label htmlFor="ai-profile-personality-custom">Eigene Anweisungen (optional)</label>
                <textarea
                  id="ai-profile-personality-custom"
                  className="input profile-menu-bio"
                  rows={3}
                  maxLength={AI_PERSONALITY_CUSTOM_MAX_CHARS}
                  placeholder="z. B. „Antworte immer mit einem Witz am Ende.“"
                  value={aiProfileDraft.personalityCustom}
                  onChange={(e) => setAiProfileDraft((prev) => ({ ...prev, personalityCustom: e.target.value }))}
                />
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShowPeerProfile(false)}>
                Abbrechen
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void saveAiProfile()}>
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}

      {showPeerProfile && selectedPeer && !selectedPeer.isAiChat && (
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

      {showClearContextConfirm && peerPendingClear && (
        <div
          className="modal-overlay"
          onClick={() => {
            if (clearingContext) return;
            setShowClearContextConfirm(false);
            setClearContextTargetPeerId(null);
          }}
        >
          <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <h3 style={{ margin: 0 }}>Verlauf leeren?</h3>
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => {
                  if (clearingContext) return;
                  setShowClearContextConfirm(false);
                  setClearContextTargetPeerId(null);
                }}
                disabled={clearingContext}
                aria-label="Schließen"
              >
                <X size={16} strokeWidth={CHAT_ICON_STROKE} />
              </button>
            </div>
            <p className="text-muted" style={{ margin: '0 0 16px', lineHeight: 1.5 }}>
              Der gesamte Chatverlauf und der Agent-Kontext (inkl. Erinnerungen) von{' '}
              <strong>{peerPendingClear.displayName}</strong> werden gelöscht. Der KI-Agent bleibt erhalten.
              Dies kann nicht rückgängig gemacht werden.
            </p>
            <div className="modal-actions">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setShowClearContextConfirm(false);
                  setClearContextTargetPeerId(null);
                }}
                disabled={clearingContext}
              >
                Abbrechen
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void confirmClearContext()}
                disabled={clearingContext}
              >
                {clearingContext ? (
                  <span className="spinner-label">
                    <span className="spinner spinner--sm spinner--accent" />
                    <span>Leere…</span>
                  </span>
                ) : 'Verlauf leeren'}
              </button>
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
              <h3 style={{ margin: 0 }}>
                {isGroupChatId(deleteTargetPeerId) ? 'Gruppe löschen?' : 'Chat löschen?'}
              </h3>
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
              {isGroupChatId(deleteTargetPeerId) ? (
                <>
                  {peerPendingDelete?.canSend
                    ? <>Du verlässt <strong>{peerPendingDelete.displayName}</strong> und entfernst alle Nachrichten auf diesem Gerät. Das kann nicht rückgängig gemacht werden.</>
                    : <>Die Gruppe <strong>{peerPendingDelete.displayName}</strong> und alle Nachrichten auf diesem Gerät werden entfernt. Das kann nicht rückgängig gemacht werden.</>}
                </>
              ) : (
                <>Der Chat mit <strong>{peerPendingDelete.displayName}</strong> und alle Nachrichten auf diesem Gerät werden entfernt. Das kann nicht rückgängig gemacht werden.</>
              )}
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
                Abbrechen
              </button>
              <button
                className="btn btn-danger"
                onClick={confirmDeleteChat}
                disabled={deletingChat}
              >
                {deletingChat ? (
                  <span className="spinner-label">
                    <span className="spinner spinner--sm spinner--accent" />
                    <span>Wird gelöscht…</span>
                  </span>
                ) : (isGroupChatId(deleteTargetPeerId) ? 'Gruppe löschen' : 'Chat löschen')}
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
          {listContextMenu.chat.isAiChat ? (
            <>
              <button
                type="button"
                className="chat-list-context-menu-item"
                role="menuitem"
                onClick={() => openAiProfileEditor(listContextMenu.chat)}
              >
                <Pencil size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Profil bearbeiten…
              </button>
              <button
                type="button"
                className="chat-list-context-menu-item"
                role="menuitem"
                onClick={() => openClearContextForPeer(listContextMenu.chat.id)}
              >
                <Eraser size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Verlauf leeren…
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
            </>
          ) : listContextMenu.chat.isGroup ? (
            <>
              <button
                type="button"
                className="chat-list-context-menu-item"
                role="menuitem"
                onClick={() => {
                  setSelectedPeerId(listContextMenu.chat.id);
                  setShowGroupInfo(true);
                  closeListContextMenu();
                }}
              >
                <Users size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Gruppeninfo
              </button>
              <div className="chat-list-context-menu-sep" role="separator" />
              <button
                type="button"
                className="chat-list-context-menu-item chat-list-context-menu-item--danger"
                role="menuitem"
                onClick={() => openDeleteForPeer(listContextMenu.chat.id)}
              >
                <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Gruppe löschen…
              </button>
            </>
          ) : (
            <>
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
          {!resolveContact(listContextMenu.chat.id)?.blocked ? (
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
            </>
          )}
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
          {getMessageCopyText(messageContextMenu.message, debugMode) ? (
            <button
              type="button"
              className="chat-list-context-menu-item"
              role="menuitem"
              onClick={() => {
                void copyToClipboard(
                  getMessageCopyText(messageContextMenu.message, debugMode),
                  'Nachricht kopiert'
                );
                closeMessageContextMenu();
              }}
            >
              <Copy size={15} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Kopieren
            </button>
          ) : null}
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
                      <div className="forward-dialog-item-sub">{getLastPreview(chat.lastMessage, debugMode)}</div>
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
