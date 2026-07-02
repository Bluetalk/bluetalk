import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Download,
  FileText,
  FolderOpen,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  LogOut,
  Maximize2,
  Minus,
  Pilcrow,
  Redo2,
  RemoveFormatting,
  SquareStack,
  Strikethrough,
  Underline,
  Undo2,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { parseDocxHtml, buildDocxFromHtml } from '../../shared/docx-lite.js';
import './DocsEditorPage.css';

const SEND_DEBOUNCE_MS = 250;
const IN_FLIGHT_TIMEOUT_MS = 3000;
const CURSOR_THROTTLE_MS = 80;
const CURSOR_STALE_MS = 12000;

/**
 * Kleinster zusammenhängender Unterschied zwischen zwei Strings
 * (gemeinsames Präfix/Suffix). null, wenn identisch.
 */
function diffRegion(a, b) {
  if (a === b) return null;
  const aLen = a.length;
  const bLen = b.length;
  let prefix = 0;
  const maxPrefix = Math.min(aLen, bLen);
  while (prefix < maxPrefix && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(aLen, bLen) - prefix;
  while (suffix < maxSuffix && a.charCodeAt(aLen - 1 - suffix) === b.charCodeAt(bLen - 1 - suffix)) suffix++;
  return {
    pos: prefix,
    del: aLen - prefix - suffix,
    ins: b.slice(prefix, bLen - suffix),
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

// ---------- HTML-Sanitizer (kanonische Form für den Sync) ----------
//
// Rebuild statt In-place-Filter: parst Fremd-HTML in ein <template> und
// serialisiert nur eine feste Whitelist neu. Das liefert (a) XSS-Sicherheit
// für von Peers empfangenes HTML und (b) eine deterministische, idempotente
// „kanonische" Form — beide Seiten diffen denselben String.

const ALLOWED_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'span', 'a', 'br']);
const TAG_ALIASES = { b: 'strong', i: 'em', strike: 's', del: 's', ins: 'u', div: 'p' };
const BLOCK_ALIGN_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'li']);

function escapeHtmlText(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeHref(value) {
  const v = String(value || '').trim();
  return /^(https?:|mailto:)/i.test(v) ? v.replace(/"/g, '%22') : '';
}

function safeStyle(el, tag) {
  const parts = [];
  const align = (el.style.textAlign || '').toLowerCase();
  if (BLOCK_ALIGN_TAGS.has(tag) && ['center', 'right', 'justify'].includes(align)) {
    parts.push(`text-align:${align}`);
  }
  if (tag === 'span') {
    const color = el.style.color;
    const bg = el.style.backgroundColor;
    if (color) parts.push(`color:${color}`);
    if (bg) parts.push(`background-color:${bg}`);
  }
  return parts.join(';');
}

function sanitizeChildren(parent) {
  let out = '';
  parent.childNodes.forEach((node) => {
    out += sanitizeNode(node);
  });
  return out;
}

function sanitizeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtmlText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const raw = node.tagName.toLowerCase();
  const tag = TAG_ALIASES[raw] || raw;
  if (tag === 'br') return '<br>';
  if (!ALLOWED_TAGS.has(tag)) return sanitizeChildren(node); // unbekanntes Tag entpacken
  const inner = sanitizeChildren(node);
  let attrs = '';
  const style = safeStyle(node, tag);
  if (style) attrs += ` style="${style}"`;
  if (tag === 'a') {
    const href = safeHref(node.getAttribute('href'));
    if (href) attrs += ` href="${href}"`;
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  return sanitizeChildren(tpl.content);
}

function textToHtml(text) {
  const lines = String(text ?? '').split('\n');
  return lines.map((line) => (line ? `<p>${escapeHtmlText(line)}</p>` : '<p><br></p>')).join('') || '<p><br></p>';
}

// ---------- Caret ⇄ Textoffset (gerenderter Text) ----------

function caretToIndex(root, node, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return root.textContent.length;
  }
  return range.cloneContents().textContent.length;
}

function indexToCaret(root, index) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let remaining = Math.max(0, index);
  let node;
  let last = null;
  while ((node = walker.nextNode())) {
    last = node;
    const len = node.nodeValue.length;
    if (remaining <= len) return { node, offset: remaining };
    remaining -= len;
  }
  if (last) return { node: last, offset: last.nodeValue.length };
  return { node: root, offset: 0 };
}

function captureCaret(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  return {
    start: caretToIndex(root, range.startContainer, range.startOffset),
    end: caretToIndex(root, range.endContainer, range.endOffset),
  };
}

function restoreCaret(root, caret) {
  if (!caret) return;
  try {
    const start = indexToCaret(root, caret.start);
    const end = indexToCaret(root, caret.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    /* Auswahl nicht wiederherstellbar — egal */
  }
}

function rangeFromOffsets(root, start, end) {
  try {
    const s = indexToCaret(root, start);
    const e = indexToCaret(root, end);
    const range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  } catch {
    return null;
  }
}

/** Stabile, gut unterscheidbare Farbe aus einer peerId. */
function colorForPeer(peerId) {
  let hash = 0;
  const str = String(peerId || '');
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 72%, 45%)`;
}

function useDocsWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    const bridge = window.bluetalk?.docs;
    if (!bridge?.isWindowMaximized || !bridge?.onWindowMaximizedChange) return undefined;
    let cancelled = false;
    void bridge.isWindowMaximized().then((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    const off = bridge.onWindowMaximizedChange((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);
  return isMaximized;
}

const EMPTY_FMT = { bold: false, italic: false, underline: false, strike: false, block: 'p', ul: false, ol: false, align: 'left' };

export default function DocsEditorPage() {
  const isMaximized = useDocsWindowMaximized();
  const [chrome, setChrome] = useState(null);
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const [fmt, setFmt] = useState(EMPTY_FMT);

  const editorRef = useRef(null);
  const wrapRef = useRef(null);
  const scrollRef = useRef(null);
  const cursorLayerRef = useRef(null);
  const fileInputRef = useRef(null);
  const payloadRef = useRef(null);
  const shadowRef = useRef({ html: '', revision: -1 });
  const inFlightRef = useRef({ active: false, at: 0 });
  const sendTimerRef = useRef(null);
  const chromeKeyRef = useRef('');
  const fileNameDraftRef = useRef(null);
  const remoteCursorsRef = useRef(new Map());
  const cursorSendRef = useRef({ last: 0, timer: null });

  const send = useCallback((payload) => {
    window.bluetalk?.docs?.sendAction?.(payload);
  }, []);

  const readLocalHtml = useCallback(() => {
    const ed = editorRef.current;
    return ed ? sanitizeHtml(ed.innerHTML) : '';
  }, []);

  const updateCounts = useCallback(() => {
    const text = editorRef.current?.textContent ?? '';
    setCounts((prev) => {
      const next = { words: countWords(text), chars: text.length };
      return prev.words === next.words && prev.chars === next.chars ? prev : next;
    });
  }, []);

  // ---------- Fremd-Cursor rendern ----------

  const renderRemoteCursors = useCallback(() => {
    const layer = cursorLayerRef.current;
    const ed = editorRef.current;
    const wrap = wrapRef.current;
    if (!layer || !ed || !wrap) return;
    layer.textContent = '';
    const wrapRect = wrap.getBoundingClientRect();
    for (const info of remoteCursorsRef.current.values()) {
      const caret = info.caret;
      if (!caret) continue;
      const range = rangeFromOffsets(ed, caret.start, caret.end);
      if (!range) continue;
      if (caret.end > caret.start) {
        for (const r of range.getClientRects()) {
          if (!r.width && !r.height) continue;
          const sel = document.createElement('div');
          sel.className = 'docs-remote-selection';
          sel.style.left = `${r.left - wrapRect.left}px`;
          sel.style.top = `${r.top - wrapRect.top}px`;
          sel.style.width = `${r.width}px`;
          sel.style.height = `${r.height}px`;
          sel.style.backgroundColor = info.color;
          layer.appendChild(sel);
        }
      }
      const caretRange = range.cloneRange();
      caretRange.collapse(false);
      const cr = caretRange.getBoundingClientRect();
      const dot = document.createElement('div');
      dot.className = 'docs-remote-caret';
      dot.style.left = `${cr.left - wrapRect.left}px`;
      dot.style.top = `${cr.top - wrapRect.top}px`;
      dot.style.height = `${cr.height || 18}px`;
      dot.style.backgroundColor = info.color;
      const label = document.createElement('span');
      label.className = 'docs-remote-label';
      label.textContent = info.name || 'Gast';
      label.style.backgroundColor = info.color;
      dot.appendChild(label);
      layer.appendChild(dot);
    }
  }, []);

  const setRemoteCursor = useCallback((payload) => {
    if (!payload?.peerId) return;
    const map = remoteCursorsRef.current;
    if (payload.gone || !payload.caret) {
      map.delete(payload.peerId);
    } else {
      map.set(payload.peerId, {
        caret: payload.caret,
        name: payload.name || 'Gast',
        color: colorForPeer(payload.peerId),
        at: Date.now(),
      });
    }
    renderRemoteCursors();
  }, [renderRemoteCursors]);

  const broadcastCaret = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || shadowRef.current.revision < 0) return; // nur in aktiver Sitzung
    const state = cursorSendRef.current;
    const now = Date.now();
    const flush = () => {
      state.last = Date.now();
      state.timer = null;
      const caret = captureCaret(editorRef.current);
      send({ type: 'cursor', caret });
    };
    if (now - state.last >= CURSOR_THROTTLE_MS) {
      flush();
    } else if (!state.timer) {
      state.timer = setTimeout(flush, CURSOR_THROTTLE_MS - (now - state.last));
    }
  }, [send]);

  const refreshFormatState = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !ed.contains(sel.anchorNode)) return;
    let block = 'p';
    try {
      const raw = String(document.queryCommandValue('formatBlock') || '').toLowerCase();
      if (['h1', 'h2', 'h3'].includes(raw)) block = raw;
    } catch { /* ignore */ }
    const q = (cmd) => {
      try { return document.queryCommandState(cmd); } catch { return false; }
    };
    setFmt({
      bold: q('bold'),
      italic: q('italic'),
      underline: q('underline'),
      strike: q('strikeThrough'),
      block,
      ul: q('insertUnorderedList'),
      ol: q('insertOrderedList'),
      align: q('justifyCenter') ? 'center' : q('justifyRight') ? 'right' : q('justifyFull') ? 'justify' : 'left',
    });
  }, []);

  // ---------- Sync-Engine (Diff gegen den zuletzt bestätigten Stand) ----------

  const sendTick = useCallback(() => {
    sendTimerRef.current = null;
    const shadow = shadowRef.current;
    if (!editorRef.current || shadow.revision < 0) return;
    const local = readLocalHtml();
    if (local === shadow.html) return;
    const now = Date.now();
    if (inFlightRef.current.active && now - inFlightRef.current.at < IN_FLIGHT_TIMEOUT_MS) {
      sendTimerRef.current = setTimeout(sendTick, 200);
      return;
    }
    const d = diffRegion(shadow.html, local);
    if (!d) return;
    // Ein primitiver Op pro Runde; Ersetzen konvergiert über Delete + Insert.
    let op;
    if (d.del === 0) op = { type: 'insert', pos: d.pos, text: d.ins };
    else op = { type: 'delete', pos: d.pos, len: d.del };
    inFlightRef.current = { active: true, at: now };
    send({ type: 'apply_op', op, baseRevision: shadow.revision });
    sendTimerRef.current = setTimeout(sendTick, 350);
  }, [readLocalHtml, send]);

  const scheduleSend = useCallback(() => {
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(sendTick, SEND_DEBOUNCE_MS);
  }, [sendTick]);

  const applyRemoteDoc = useCallback((docPayload) => {
    const ed = editorRef.current;
    if (!docPayload) {
      shadowRef.current = { html: '', revision: -1 };
      inFlightRef.current = { active: false, at: 0 };
      if (ed && ed.innerHTML !== '') {
        ed.innerHTML = '';
        updateCounts();
      }
      return;
    }
    const state = String(docPayload.state ?? '');
    const revision = Number(docPayload.revision) || 0;
    const shadow = shadowRef.current;
    if (revision < shadow.revision) return;
    if (revision === shadow.revision && state === shadow.html) return;

    const oldShadow = shadow.html;
    shadowRef.current = { html: state, revision };
    inFlightRef.current = { active: false, at: 0 };
    if (!ed) return;

    const local = readLocalHtml();
    if (local === state) {
      updateCounts();
      return;
    }
    if (local === oldShadow) {
      // Keine eigenen ungesendeten Änderungen: Remote-Stand übernehmen und
      // Cursor über die gerenderte Textposition stabil halten.
      const caret = captureCaret(ed);
      ed.innerHTML = sanitizeHtml(state);
      restoreCaret(ed, caret);
      updateCounts();
      renderRemoteCursors();
      return;
    }
    // Eigene Änderungen unterwegs: lokal behalten, in der nächsten Runde senden.
    scheduleSend();
  }, [readLocalHtml, renderRemoteCursors, scheduleSend, updateCounts]);

  // ---------- Editor-Eingabe ----------

  const onEditorInput = useCallback(() => {
    scheduleSend();
    updateCounts();
    renderRemoteCursors();
    broadcastCaret();
  }, [broadcastCaret, renderRemoteCursors, scheduleSend, updateCounts]);

  const exec = useCallback((command, value) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    // CSS-Styling für Farbe/Highlight/Ausrichtung (→ Inline-Style, den der
    // Sanitizer behält); Fett/Kursiv/… bleiben echte Tags (styleWithCSS aus).
    const wantCss = /^(foreColor|hiliteColor|backColor|justify)/.test(command);
    try {
      document.execCommand('styleWithCSS', false, wantCss);
      document.execCommand(command, false, value);
    } catch { /* ignore */ }
    refreshFormatState();
    onEditorInput();
  }, [onEditorInput, refreshFormatState]);

  const setBlock = useCallback((tag) => {
    exec('formatBlock', tag === 'p' ? 'p' : tag.toUpperCase());
  }, [exec]);

  // ---------- Zustand vom Controller im Hauptfenster ----------

  useEffect(() => {
    if (!window.bluetalk?.docs?.onState) return undefined;
    const off = window.bluetalk.docs.onState((payload) => {
      payloadRef.current = payload || null;
      applyRemoteDoc(payload?.hasRoom ? payload?.doc : null);
      const chromeData = payload
        ? {
          hasRoom: Boolean(payload.hasRoom),
          isHost: Boolean(payload.isHost),
          fileName: payload.fileName || 'Unbenanntes Dokument',
          participants: payload.participants || [],
          contacts: payload.contacts || [],
          pendingInvite: payload.pendingInvite || null,
          selfPeerId: payload.selfPeerId || '',
        }
        : null;
      const key = JSON.stringify(chromeData);
      if (key !== chromeKeyRef.current) {
        chromeKeyRef.current = key;
        setChrome(chromeData);
      }
    });
    window.bluetalk.docs.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.docs?.sendAction?.({ type: 'request_state' });
    }, 300);
    return () => {
      clearTimeout(retry);
      off?.();
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    };
  }, [applyRemoteDoc]);

  // Fremd-Cursor-Kanal (leichtgewichtig, kein React-Re-Render).
  useEffect(() => {
    const onPresence = window.bluetalk?.docs?.onPeerPresence;
    if (!onPresence) return undefined;
    return onPresence((payload) => setRemoteCursor(payload));
  }, [setRemoteCursor]);

  // Auswahländerungen: Toolbar-Status + eigenen Cursor senden.
  useEffect(() => {
    const handler = () => {
      const ed = editorRef.current;
      const sel = window.getSelection();
      if (!ed || !sel || sel.rangeCount === 0 || !ed.contains(sel.anchorNode)) return;
      refreshFormatState();
      broadcastCaret();
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [broadcastCaret, refreshFormatState]);

  // Fremd-Cursor bei Scroll/Resize neu positionieren + Ablauf alter Cursor.
  useEffect(() => {
    const onResize = () => renderRemoteCursors();
    window.addEventListener('resize', onResize);
    const sweep = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [peerId, info] of remoteCursorsRef.current) {
        if (now - info.at > CURSOR_STALE_MS) {
          remoteCursorsRef.current.delete(peerId);
          changed = true;
        }
      }
      if (changed) renderRemoteCursors();
    }, 4000);
    return () => {
      window.removeEventListener('resize', onResize);
      clearInterval(sweep);
    };
  }, [renderRemoteCursors]);

  // Wenn der Editor (nach hasRoom) frisch gemountet ist, aktuellen Stand zeigen.
  useEffect(() => {
    if (!chrome?.hasRoom) {
      remoteCursorsRef.current.clear();
      return;
    }
    const ed = editorRef.current;
    if (ed && shadowRef.current.revision >= 0 && readLocalHtml() !== shadowRef.current.html) {
      ed.innerHTML = sanitizeHtml(shadowRef.current.html || '');
      updateCounts();
      renderRemoteCursors();
    }
  }, [chrome?.hasRoom, readLocalHtml, renderRemoteCursors, updateCounts]);

  // ---------- Datei-Import / -Export ----------

  const importFile = useCallback(async (file) => {
    if (!file) return;
    try {
      let html;
      if (/\.docx$/i.test(file.name)) {
        html = sanitizeHtml(await parseDocxHtml(await file.arrayBuffer()));
      } else {
        html = sanitizeHtml(textToHtml(await file.text()));
      }
      const fileName = file.name.replace(/\.(docx|txt|md)$/i, '');
      send({ type: 'import_text', text: html, fileName });
      setStatus(`„${file.name}" geladen`);
    } catch (err) {
      console.error('Import fehlgeschlagen:', err);
      setStatus('Import fehlgeschlagen — ist das eine gültige Word-/Textdatei?');
    }
  }, [send]);

  const exportFile = useCallback(async (kind) => {
    const html = readLocalHtml() || shadowRef.current.html || '';
    const baseName = (chrome?.fileName || 'Dokument').replace(/[\\/:*?"<>|]/g, '_');
    let base64;
    let fileName;
    if (kind === 'docx') {
      base64 = bytesToBase64(buildDocxFromHtml(html));
      fileName = `${baseName}.docx`;
    } else {
      const text = editorRef.current?.textContent ?? '';
      base64 = bytesToBase64(new TextEncoder().encode(text));
      fileName = `${baseName}.txt`;
    }
    const saveAs = window.bluetalk?.docs?.saveAs;
    if (saveAs) {
      const result = await saveAs({ defaultFilename: fileName, base64 });
      if (result?.ok) setStatus(`Gespeichert: ${result.filePath}`);
      else if (!result?.canceled) setStatus('Speichern fehlgeschlagen.');
    } else {
      setStatus('Speichern nicht verfügbar.');
    }
  }, [chrome?.fileName, readLocalHtml]);

  const closeWindow = useCallback(() => window.bluetalk?.docs?.closeGameWindow?.(), []);
  const leaveSession = useCallback(() => {
    send({ type: 'leave' });
    setInvitePanelOpen(false);
  }, [send]);

  // ---------- Render ----------

  if (!chrome) {
    return (
      <div className="docs-root">
        <main className="docs-empty">
          <div className="docs-mark" aria-hidden>📝</div>
          <h1>Editor wird vorbereitet…</h1>
          <p>Verbindung zum Dokumente-Dienst im Hauptfenster wird hergestellt.</p>
          <button type="button" className="docs-btn" onClick={() => send({ type: 'request_state' })}>Erneut versuchen</button>
        </main>
      </div>
    );
  }

  const { hasRoom, isHost, fileName, participants, contacts, pendingInvite } = chrome;
  const invitableContacts = contacts.filter((c) => !participants.some((p) => p.peerId === c.id));

  return (
    <div className="docs-root">
      <header className="docs-titlebar">
        <div className="docs-title">
          <h1>📝 {hasRoom ? fileName : 'Dokumente'}</h1>
          <div className="docs-titlebar-sub">
            {hasRoom
              ? `Live · ${participants.length} ${participants.length === 1 ? 'Person' : 'Personen'}${isHost ? ' · Du bist Host' : ''}`
              : 'Bereit'}
          </div>
        </div>
        <div className="docs-titlebar-actions">
          {hasRoom ? (
            <button
              type="button"
              className={`docs-btn-icon${invitePanelOpen ? ' docs-btn-icon--active' : ''}`}
              title="Teilnehmer & Einladungen"
              onClick={() => setInvitePanelOpen((v) => !v)}
            >
              <Users size={16} />
            </button>
          ) : null}
          {hasRoom ? (
            <button type="button" className="docs-btn-icon" title="Sitzung verlassen" onClick={leaveSession}><LogOut size={16} /></button>
          ) : null}
          <button type="button" className="docs-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.docs?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="docs-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.docs?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="docs-btn-icon" title="Fenster schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>

      <input
        type="file"
        accept=".docx,.txt,.md"
        hidden
        ref={fileInputRef}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          void importFile(file);
        }}
      />

      {hasRoom ? (
        <main className="docs-main">
          <div className="docs-toolbar">
            <input
              className="docs-filename"
              defaultValue={fileName}
              key={fileName}
              maxLength={120}
              onFocus={() => { fileNameDraftRef.current = fileName; }}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== fileNameDraftRef.current) send({ type: 'set_filename', fileName: next });
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              title="Dokumentname"
            />
            <div className="docs-toolbar-actions">
              <button type="button" className="docs-btn" onClick={() => fileInputRef.current?.click()}>
                <FolderOpen size={14} /> Öffnen
              </button>
              <button type="button" className="docs-btn" onClick={() => void exportFile('docx')}>
                <Download size={14} /> Als .docx
              </button>
              <button type="button" className="docs-btn" onClick={() => void exportFile('txt')}>
                <FileText size={14} /> Als .txt
              </button>
              <button type="button" className="docs-btn docs-btn--primary" onClick={() => setInvitePanelOpen((v) => !v)}>
                <UserPlus size={14} /> Einladen
              </button>
            </div>
          </div>

          <div className="docs-format-bar" role="toolbar" aria-label="Formatierung" onMouseDown={(e) => e.preventDefault()}>
            <div className="docs-fmt-group">
              <button type="button" className={`docs-fmt-btn${fmt.bold ? ' is-active' : ''}`} title="Fett (Strg+B)" onClick={() => exec('bold')}><Bold size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.italic ? ' is-active' : ''}`} title="Kursiv (Strg+I)" onClick={() => exec('italic')}><Italic size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.underline ? ' is-active' : ''}`} title="Unterstrichen (Strg+U)" onClick={() => exec('underline')}><Underline size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.strike ? ' is-active' : ''}`} title="Durchgestrichen" onClick={() => exec('strikeThrough')}><Strikethrough size={16} /></button>
            </div>
            <div className="docs-fmt-sep" />
            <div className="docs-fmt-group">
              <button type="button" className={`docs-fmt-btn${fmt.block === 'p' && !fmt.ul && !fmt.ol ? ' is-active' : ''}`} title="Fließtext" onClick={() => setBlock('p')}><Pilcrow size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.block === 'h1' ? ' is-active' : ''}`} title="Überschrift 1" onClick={() => setBlock('h1')}><Heading1 size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.block === 'h2' ? ' is-active' : ''}`} title="Überschrift 2" onClick={() => setBlock('h2')}><Heading2 size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.block === 'h3' ? ' is-active' : ''}`} title="Überschrift 3" onClick={() => setBlock('h3')}><Heading3 size={16} /></button>
            </div>
            <div className="docs-fmt-sep" />
            <div className="docs-fmt-group">
              <button type="button" className={`docs-fmt-btn${fmt.ul ? ' is-active' : ''}`} title="Aufzählung" onClick={() => exec('insertUnorderedList')}><List size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.ol ? ' is-active' : ''}`} title="Nummerierte Liste" onClick={() => exec('insertOrderedList')}><ListOrdered size={16} /></button>
            </div>
            <div className="docs-fmt-sep" />
            <div className="docs-fmt-group">
              <button type="button" className={`docs-fmt-btn${fmt.align === 'left' ? ' is-active' : ''}`} title="Linksbündig" onClick={() => exec('justifyLeft')}><AlignLeft size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.align === 'center' ? ' is-active' : ''}`} title="Zentriert" onClick={() => exec('justifyCenter')}><AlignCenter size={16} /></button>
              <button type="button" className={`docs-fmt-btn${fmt.align === 'right' ? ' is-active' : ''}`} title="Rechtsbündig" onClick={() => exec('justifyRight')}><AlignRight size={16} /></button>
            </div>
            <div className="docs-fmt-sep" />
            <div className="docs-fmt-group">
              <label className="docs-fmt-btn docs-fmt-color" title="Textfarbe">
                <Bold size={15} style={{ opacity: 0 }} />
                <span className="docs-fmt-color-glyph">A</span>
                <input type="color" onChange={(e) => exec('foreColor', e.target.value)} defaultValue="#111827" />
              </label>
              <label className="docs-fmt-btn docs-fmt-color" title="Texthervorhebung">
                <Highlighter size={16} />
                <input type="color" onChange={(e) => exec('hiliteColor', e.target.value)} defaultValue="#fde68a" />
              </label>
            </div>
            <div className="docs-fmt-sep" />
            <div className="docs-fmt-group">
              <button type="button" className="docs-fmt-btn" title="Formatierung entfernen" onClick={() => exec('removeFormat')}><RemoveFormatting size={16} /></button>
              <button type="button" className="docs-fmt-btn" title="Rückgängig (Strg+Z)" onClick={() => exec('undo')}><Undo2 size={16} /></button>
              <button type="button" className="docs-fmt-btn" title="Wiederholen (Strg+Y)" onClick={() => exec('redo')}><Redo2 size={16} /></button>
            </div>
          </div>

          <div className="docs-editor-wrap" ref={wrapRef}>
            <div className="docs-editor-scroll" ref={scrollRef} onScroll={renderRemoteCursors}>
              <div
                ref={editorRef}
                className="docs-editor"
                contentEditable
                suppressContentEditableWarning
                spellCheck
                role="textbox"
                aria-multiline="true"
                aria-label="Dokumentinhalt"
                data-placeholder="Schreib los — alle in der Sitzung sehen deine Änderungen und Cursor live."
                onInput={onEditorInput}
                onKeyUp={broadcastCaret}
                onMouseUp={broadcastCaret}
                onBlur={() => send({ type: 'cursor', caret: null })}
              />
            </div>
            <div className="docs-cursor-layer" ref={cursorLayerRef} aria-hidden />
            {invitePanelOpen ? (
              <aside className="docs-side">
                <div className="docs-side-head">
                  <h3>Teilnehmer</h3>
                  <button type="button" className="docs-btn-icon" aria-label="Schließen" onClick={() => setInvitePanelOpen(false)}><X size={15} /></button>
                </div>
                <div className="docs-participants">
                  {participants.map((p) => (
                    <div key={p.peerId} className={`docs-participant${p.isSelf ? ' docs-participant--self' : ''}`}>
                      <span className="docs-dot" style={{ backgroundColor: p.isSelf ? undefined : colorForPeer(p.peerId) }} />
                      <b>{p.name}</b>
                      <span className="docs-meta">{p.isHost ? 'Host' : ''}{p.isSelf ? (p.isHost ? ' · Du' : 'Du') : ''}</span>
                    </div>
                  ))}
                </div>
                <h3>Kontakte einladen</h3>
                <div className="docs-contacts">
                  {invitableContacts.map((c) => (
                    <div key={c.id} className="docs-contact">
                      <b>{c.name}</b>
                      <button type="button" className="docs-btn docs-btn--small" onClick={() => send({ type: 'invite', peerId: c.id })}>
                        Einladen
                      </button>
                    </div>
                  ))}
                  {!invitableContacts.length ? <div className="docs-meta">Keine weiteren Kontakte verfügbar.</div> : null}
                </div>
              </aside>
            ) : null}
          </div>

          <footer className="docs-statusbar">
            <span>{counts.words} Wörter · {counts.chars} Zeichen</span>
            <span className="docs-status-msg">{status}</span>
            <span>
              {participants.length > 1 ? `${participants.length} Personen schreiben mit` : 'Nur du in der Sitzung'}
            </span>
          </footer>
        </main>
      ) : (
        <main className="docs-idle">
          <div className="docs-idle-card">
            <div className="docs-mark" aria-hidden>📝</div>
            <h2>Dokumente</h2>
            <p>Öffne eine Word-Datei oder starte ein leeres Dokument und lade Kontakte ein — alle schreiben gleichzeitig am selben Text, mit Formatierung und Live-Cursor.</p>
            {pendingInvite ? (
              <div className="docs-pending">
                <b>{pendingInvite.fromName || 'Ein Kontakt'} lädt dich ein: {String(pendingInvite.name || '').replace(/^Dokument: /, '') || 'Dokument'}</b>
                <div className="docs-actions">
                  <button type="button" className="docs-btn docs-btn--primary" onClick={() => send({ type: 'join_pending' })}>Mitschreiben</button>
                  <button type="button" className="docs-btn" onClick={() => send({ type: 'dismiss_pending' })}>Ignorieren</button>
                </div>
              </div>
            ) : null}
            <div className="docs-actions">
              <button type="button" className="docs-btn docs-btn--primary docs-btn--big" onClick={() => send({ type: 'new_doc' })}>
                Neues Dokument
              </button>
              <button type="button" className="docs-btn docs-btn--big" onClick={() => fileInputRef.current?.click()}>
                <FolderOpen size={15} /> Word-Datei (.docx) öffnen
              </button>
            </div>
            {status ? <p className="docs-meta">{status}</p> : null}
          </div>
        </main>
      )}
    </div>
  );
}
