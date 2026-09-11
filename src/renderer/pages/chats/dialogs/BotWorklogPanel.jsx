import React, { useEffect, useState } from 'react';
import { ScrollText, X } from 'lucide-react';
import { CHAT_ICON_STROKE } from '../messageHelpers.jsx';
import { MessageSegments } from '../agentBlocks.jsx';

function formatLogTime(ts) {
  const n = Number(ts);
  if (!n) return '';
  return new Date(n).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Seitenpanel: Live-Arbeit und gespeicherte Worklog-Einträge (Thinking + Tools).
 */
export function BotWorklogPanel({
  open,
  peerId,
  liveProgress = null,
  onClose,
}) {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    if (!open || !peerId) {
      setEntries([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const store = await window.bluetalk?.store?.get?.('aiChat.worklogs', {});
        const list = store && Array.isArray(store[peerId]) ? store[peerId] : [];
        if (!cancelled) setEntries([...list].reverse());
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();
    const off = window.bluetalk?.on?.('bot:worklog', (payload) => {
      if (payload?.peerId !== peerId || !payload?.entry) return;
      setEntries((prev) => [payload.entry, ...prev.filter((item) => item?.id !== payload.entry.id)].slice(0, 40));
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [open, peerId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const live = liveProgress?.peerId === peerId ? liveProgress : null;

  return (
    <aside
      className="chat-profile-panel peer-profile-modal bot-worklog-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="bot-worklog-title"
    >
      <div className="peer-profile-modal-toolbar">
        <h2 id="bot-worklog-title" className="peer-profile-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ScrollText size={16} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
          Worklog
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          onClick={onClose}
          aria-label="Schließen"
        >
          <X size={18} strokeWidth={CHAT_ICON_STROKE} />
        </button>
      </div>
      <div className="peer-profile-modal-body bot-worklog-body">
        {live ? (
          <section className="bot-worklog-entry bot-worklog-entry--live">
            <div className="bot-worklog-entry-meta">
              <span>Jetzt</span>
              <span className="msg-working-live-badge">läuft</span>
            </div>
            <MessageSegments
              segments={live.segments}
              content={live.content}
              thinking={live.thinking}
              toolEvents={live.toolEvents}
              live
            />
          </section>
        ) : null}
        {entries.length === 0 && !live ? (
          <p className="text-sm text-muted" style={{ margin: 0 }}>
            Noch keine Einträge. Sobald der Bot arbeitet, erscheinen hier Denkprozess und Tool-Aufrufe.
          </p>
        ) : entries.map((entry) => (
          <section className="bot-worklog-entry" key={entry.id || entry.at}>
            <div className="bot-worklog-entry-meta">
              <span>{formatLogTime(entry.at)}</span>
              {entry.model ? <span className="text-muted">{entry.model}</span> : null}
            </div>
            <MessageSegments
              segments={entry.segments}
              content=""
              thinking={entry.thinking}
              toolEvents={entry.toolEvents}
            />
          </section>
        ))}
      </div>
    </aside>
  );
}
