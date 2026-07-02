import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Download,
  FileText,
  FolderOpen,
  LogOut,
  Maximize2,
  Minus,
  SquareStack,
  UserPlus,
  Users,
  X,
} from 'lucide-react';
import { parseDocx, buildDocx } from '../../shared/docx-lite.js';
import './DocsEditorPage.css';

const SEND_DEBOUNCE_MS = 250;
const IN_FLIGHT_TIMEOUT_MS = 3000;

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

export default function DocsEditorPage() {
  const isMaximized = useDocsWindowMaximized();
  const [chrome, setChrome] = useState(null);
  const [invitePanelOpen, setInvitePanelOpen] = useState(false);
  const [status, setStatus] = useState('');
  const [counts, setCounts] = useState({ words: 0, chars: 0 });

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const payloadRef = useRef(null);
  const shadowRef = useRef({ text: '', revision: -1 });
  const inFlightRef = useRef({ active: false, at: 0 });
  const sendTimerRef = useRef(null);
  const chromeKeyRef = useRef('');
  const fileNameDraftRef = useRef(null);

  const send = useCallback((payload) => {
    window.bluetalk?.docs?.sendAction?.(payload);
  }, []);

  const updateCounts = useCallback(() => {
    const text = textareaRef.current?.value ?? '';
    setCounts((prev) => {
      const next = { words: countWords(text), chars: text.length };
      return prev.words === next.words && prev.chars === next.chars ? prev : next;
    });
  }, []);

  // ---------- Sync-Engine (Diff gegen den zuletzt bestätigten Stand) ----------

  const sendTick = useCallback(() => {
    sendTimerRef.current = null;
    const ta = textareaRef.current;
    const shadow = shadowRef.current;
    if (!ta || shadow.revision < 0) return;
    const local = ta.value;
    if (local === shadow.text) return;
    const now = Date.now();
    if (inFlightRef.current.active && now - inFlightRef.current.at < IN_FLIGHT_TIMEOUT_MS) {
      sendTimerRef.current = setTimeout(sendTick, 200);
      return;
    }
    const d = diffRegion(shadow.text, local);
    if (!d) return;
    // Ein primitiver Op pro Runde; gemischte Änderungen (Ersetzen) werden als
    // Delete + Insert über zwei Runden konvergiert.
    let op;
    if (d.del === 0) op = { type: 'insert', pos: d.pos, text: d.ins };
    else if (d.ins.length === 0) op = { type: 'delete', pos: d.pos, len: d.del };
    else op = { type: 'delete', pos: d.pos, len: d.del };
    inFlightRef.current = { active: true, at: now };
    send({ type: 'apply_op', op, baseRevision: shadow.revision });
    sendTimerRef.current = setTimeout(sendTick, 350);
  }, [send]);

  const scheduleSend = useCallback(() => {
    if (sendTimerRef.current) clearTimeout(sendTimerRef.current);
    sendTimerRef.current = setTimeout(sendTick, SEND_DEBOUNCE_MS);
  }, [sendTick]);

  const applyRemoteDoc = useCallback((docPayload) => {
    const ta = textareaRef.current;
    if (!docPayload) {
      shadowRef.current = { text: '', revision: -1 };
      inFlightRef.current = { active: false, at: 0 };
      if (ta && ta.value !== '') {
        ta.value = '';
        updateCounts();
      }
      return;
    }
    const state = String(docPayload.state ?? '');
    const revision = Number(docPayload.revision) || 0;
    const shadow = shadowRef.current;
    if (revision < shadow.revision) return; // veralteter Push
    if (revision === shadow.revision && state === shadow.text) return;

    const oldShadow = shadow.text;
    shadowRef.current = { text: state, revision };
    inFlightRef.current = { active: false, at: 0 };
    if (!ta) return;
    const local = ta.value;
    if (local === state) {
      updateCounts();
      return;
    }

    if (local === oldShadow) {
      // Keine eigenen ungesendeten Änderungen: Remote-Stand übernehmen und
      // den Cursor über die Änderungsregion hinweg stabil halten.
      const d = diffRegion(oldShadow, state);
      const selStart = ta.selectionStart;
      const selEnd = ta.selectionEnd;
      ta.value = state;
      if (d) {
        const delta = d.ins.length - d.del;
        const adjust = (pos) => (pos >= d.pos + d.del ? pos + delta : Math.min(pos, d.pos + d.ins.length));
        ta.selectionStart = adjust(selStart);
        ta.selectionEnd = adjust(selEnd);
      }
      updateCounts();
      return;
    }

    // Eigene Änderungen sind unterwegs/ungesendet: unsere Region in den
    // Remote-Stand einmischen (positions-verschoben), bei Überlappung gewinnt
    // lokal — die nächste Sende-Runde schiebt das Ergebnis zum Host.
    const ours = diffRegion(oldShadow, local);
    const theirs = diffRegion(oldShadow, state);
    if (!ours) {
      ta.value = state;
      updateCounts();
      return;
    }
    if (theirs) {
      const oursEnd = ours.pos + ours.del;
      const theirsEnd = theirs.pos + theirs.del;
      if (oursEnd <= theirs.pos || theirsEnd <= ours.pos) {
        let pos = ours.pos;
        if (theirs.pos < ours.pos) pos += theirs.ins.length - theirs.del;
        const merged = state.slice(0, pos) + ours.ins + state.slice(pos + ours.del);
        ta.value = merged;
        const cursor = pos + ours.ins.length;
        ta.selectionStart = cursor;
        ta.selectionEnd = cursor;
        updateCounts();
      }
      // Überlappung: lokalen Stand behalten (Textfeld unverändert lassen).
    }
    scheduleSend();
  }, [scheduleSend, updateCounts]);

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

  // ---------- Datei-Import / -Export ----------

  const importFile = useCallback(async (file) => {
    if (!file) return;
    try {
      let text;
      if (/\.docx$/i.test(file.name)) {
        text = await parseDocx(await file.arrayBuffer());
      } else {
        text = await file.text();
      }
      const fileName = file.name.replace(/\.(docx|txt|md)$/i, '');
      send({ type: 'import_text', text, fileName });
      setStatus(`„${file.name}“ geladen`);
    } catch (err) {
      console.error('Import fehlgeschlagen:', err);
      setStatus('Import fehlgeschlagen — ist das eine gültige Word-/Textdatei?');
    }
  }, [send]);

  const exportFile = useCallback(async (kind) => {
    const text = textareaRef.current?.value ?? shadowRef.current.text ?? '';
    const baseName = (chrome?.fileName || 'Dokument').replace(/[\\/:*?"<>|]/g, '_');
    let base64;
    let fileName;
    if (kind === 'docx') {
      base64 = bytesToBase64(buildDocx(text));
      fileName = `${baseName}.docx`;
    } else {
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
  }, [chrome?.fileName]);

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
          <p>Verbindung zum Dokumente-Plugin im Hauptfenster wird hergestellt.</p>
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
          <h1>📝 {hasRoom ? fileName : 'Live Dokumente'}</h1>
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

          <div className="docs-editor-wrap">
            <textarea
              ref={textareaRef}
              className="docs-editor"
              spellCheck={false}
              placeholder="Schreib los — alle in der Sitzung sehen deine Änderungen live."
              onInput={() => {
                scheduleSend();
                updateCounts();
              }}
            />
            {invitePanelOpen ? (
              <aside className="docs-side">
                <div className="docs-side-head">
                  <h3>Teilnehmer</h3>
                  <button type="button" className="docs-btn-icon" aria-label="Schließen" onClick={() => setInvitePanelOpen(false)}><X size={15} /></button>
                </div>
                <div className="docs-participants">
                  {participants.map((p) => (
                    <div key={p.peerId} className={`docs-participant${p.isSelf ? ' docs-participant--self' : ''}`}>
                      <span className="docs-dot" />
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
            <h2>Live Dokumente</h2>
            <p>Öffne eine Word-Datei oder starte ein leeres Dokument und lade Kontakte ein — alle schreiben gleichzeitig am selben Text.</p>
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
