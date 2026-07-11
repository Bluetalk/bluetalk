// Extracted from Chats.jsx — presentational/pure chat modules (behaviour unchanged).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Save,
  Bell,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { createPortal } from 'react-dom';
import { filterToolEventsForDisplay, groupConsecutiveToolSegments, isRunCommandRunning, toolEventsFromSegment } from '../../utils/agentSegments.js';
import { isContactNotificationMuted } from '../../contactNotificationMute';
import { AI_CLOUD_MODELS, AI_MODEL_TIERS, isModelTierVisible } from '../../aiChatConstants';
import {
  CHAT_ICON_STROKE,
  subagentStatusLabel,
  notificationMuteSelectValue,
  formatMuteExpiry,
  getImageUrl,
} from './messageHelpers.jsx';
import {
  MarkdownBody,
  splitThinkingText,
  MessageReplyQuote,
} from './messageParts.jsx';

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

export {
  ContextMenuHoverSubmenu,
  NotificationMuteMenuItems,
  AiChatModelPicker,
  AiThinkingBlock,
  summarizeToolResult,
  TOOL_LABELS,
  toolArgPreview,
  AgentToolLines,
  AgentToolEvents,
  SubAgentBlock,
  SubagentChatView,
  buildAgentMessageLayout,
  AgentWorkingBlock,
  MessageSegments,
  ChatMessage,
  MediaLightbox,
};
