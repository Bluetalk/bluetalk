import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crown,
  HelpCircle,
  LogOut,
  Maximize2,
  Minus,
  Play,
  Save,
  Settings,
  SquareStack,
  Users,
  UserX,
  X,
} from 'lucide-react';
import './ConnectFourGamePage.css';

const PHASE_LABELS = {
  lobby: 'Lobby',
  playing: 'Spiel läuft',
  finished: 'Partie beendet',
};

const DISC_COLORS = {
  0: 'empty',
  1: 'red',
  2: 'yellow',
};

function useConnectFourState() {
  const [snapshot, setSnapshot] = useState(null);
  const [selfId, setSelfId] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.bluetalk?.peer?.getInfo?.().then((info) => {
      if (!cancelled && info?.id) setSelfId(info.id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.connectFour?.onState) return undefined;
    const off = window.bluetalk.connectFour.onState((payload) => setSnapshot(payload || null));
    window.bluetalk.connectFour.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.connectFour?.sendAction?.({ type: 'request_state' });
    }, 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.connectFour?.sendAction?.(payload);
  }, []);

  return {
    snapshot,
    selfId,
    isHost: Boolean(selfId && snapshot?.public?.hostPeerId === selfId),
    send,
  };
}

function useConnectFourWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.bluetalk?.connectFour;
    if (!api?.isWindowMaximized || !api?.onWindowMaximizedChange) return undefined;
    let cancelled = false;
    void api.isWindowMaximized().then((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    const off = api.onWindowMaximizedChange((value) => {
      if (!cancelled) setIsMaximized(Boolean(value));
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  return isMaximized;
}

function PlayerAvatar({ player, isActive, isHost, self = false, disc = 1 }) {
  const initials = player?.name?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
  return (
    <div className={`cf-player-avatar${isActive ? ' active' : ''}${player?.connected === false ? ' disconnected' : ''}${self ? ' self' : ''}`}>
      <div className={`cf-avatar-circle cf-disc-${DISC_COLORS[disc] || 'red'}`}>
        <span>{initials}</span>
        {isHost ? <Crown size={11} className="cf-host-icon" aria-label="Host" /> : null}
      </div>
      <div className="cf-avatar-name">{player?.name || 'Spieler'}{self ? ' (du)' : ''}</div>
    </div>
  );
}

const DISC_NAMES = {
  1: 'Rot',
  2: 'Gelb',
};

function LobbyView({ snapshot, selfId, isHost, onStart, onLeave }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const maxPlayers = pub?.settings?.maxPlayers || 2;
  const seats = Array.from({ length: maxPlayers }, (_, seat) => players.find((item) => item.seat === seat) || null);
  return (
    <div className="cf-lobby">
      <div className="cf-lobby-emblem" aria-hidden>
        <span className="cf-emblem-disc red" />
        <span className="cf-emblem-disc yellow" />
        <span className="cf-emblem-disc yellow" />
        <span className="cf-emblem-disc red" />
      </div>
      <div className="cf-lobby-header">
        <h2>{pub?.settings?.tableName || 'Vier-gewinnt-Tisch'}</h2>
        <div className="cf-lobby-meta">
          <span><Users size={14} /> <b className="cf-num">{players.length}/{maxPlayers}</b></span>
          <span>2 Spieler · 4 in einer Reihe</span>
        </div>
      </div>
      <div className="cf-lobby-seats">
        {seats.map((player, seat) => (
          <React.Fragment key={seat}>
            {seat > 0 ? <div className="cf-lobby-vs" aria-hidden>VS</div> : null}
            <div className={`cf-lobby-seat ${player ? 'occupied' : 'empty'}`}>
              {player ? (
                <>
                  <PlayerAvatar
                    player={player}
                    isHost={player.peerId === pub.hostPeerId}
                    self={player.peerId === selfId}
                    disc={player.disc}
                  />
                  <span className={`cf-color-chip cf-chip-${DISC_COLORS[player.disc] || 'red'}`}>
                    <span className="cf-chip-dot" aria-hidden />
                    {DISC_NAMES[player.disc] || 'Farbe'}
                  </span>
                </>
              ) : (
                <>
                  <span className="cf-lobby-empty-circle" aria-hidden />
                  <span className="cf-lobby-empty">Platz {seat + 1} frei</span>
                </>
              )}
            </div>
          </React.Fragment>
        ))}
      </div>
      <div className="cf-lobby-actions">
        {isHost ? (
          <button type="button" className="cf-btn-primary cf-btn-start" onClick={onStart} disabled={players.length < 2}>
            <Play size={16} /> Spiel starten
          </button>
        ) : (
          <p className="cf-panel-note">Warte, bis der Host das Spiel startet.</p>
        )}
        <button type="button" className="cf-btn-ghost" onClick={onLeave}><LogOut size={16} /> Verlassen</button>
      </div>
    </div>
  );
}

function BoardView({ snapshot, selfId, onDrop, onRematch, onLeave, isHost }) {
  const pub = snapshot?.public;
  const board = pub?.board || [];
  const players = pub?.players || [];
  const selfPlayer = players.find((p) => p.peerId === selfId);
  const opponent = players.find((p) => p.peerId !== selfId);
  const activePlayer = players.find((p) => p.peerId === pub?.toAct);
  const playing = pub?.phase === 'playing';
  const canAct = pub?.toAct === selfId && playing;
  const selfColor = DISC_COLORS[selfPlayer?.disc] || 'red';
  const [hoverCol, setHoverCol] = useState(-1);
  const winSet = useMemo(() => {
    const cells = pub?.winCells || [];
    return new Set(cells.map((c) => `${c.row}:${c.col}`));
  }, [pub?.winCells]);

  // Letzten neu gesetzten Stein erkennen, um die Fall-Animation auszulösen.
  const prevBoardRef = useRef(null);
  const [dropCell, setDropCell] = useState(null);
  useEffect(() => {
    const prev = prevBoardRef.current;
    prevBoardRef.current = board;
    if (!prev || !board.length || prev.length !== board.length) return;
    const added = [];
    for (let r = 0; r < board.length; r += 1) {
      for (let c = 0; c < (board[r]?.length || 0); c += 1) {
        if ((prev[r]?.[c] ?? 0) === 0 && board[r][c] !== 0) added.push({ row: r, col: c });
      }
    }
    if (added.length === 1) {
      setDropCell({ ...added[0], key: `${added[0].row}:${added[0].col}:${Date.now()}` });
    } else if (added.length > 1) {
      setDropCell(null);
    }
  }, [board]);

  const isColumnPlayable = (col) => {
    if (!canAct) return false;
    if (!board.length) return false;
    return board[0][col] === 0;
  };

  const handleColumnClick = (col) => {
    if (!isColumnPlayable(col)) return;
    setHoverCol(-1);
    onDrop(col);
  };

  const finished = pub?.phase === 'finished';
  const winner = players.find((p) => p.peerId === pub?.winnerPeerId);
  const winnerColor = winner ? (DISC_COLORS[winner.disc] || 'red') : '';

  return (
    <div className="cf-table-container">
      <div className={`cf-opponent-row${playing && !canAct ? '' : ' dimmed'}`}>
        {opponent ? (
          <PlayerAvatar
            player={opponent}
            isActive={pub?.toAct === opponent.peerId}
            isHost={opponent.peerId === pub?.hostPeerId}
            disc={opponent.disc}
          />
        ) : null}
      </div>

      {playing ? (
        <div className={`cf-turn-banner${canAct ? ' own' : ' wait'}`} role="status">
          <span className={`cf-turn-dot cf-dot-${DISC_COLORS[activePlayer?.disc] || 'empty'}`} aria-hidden />
          {canAct
            ? 'Du bist am Zug — wähle eine Spalte'
            : `${activePlayer?.name || 'Gegner'} ist am Zug…`}
        </div>
      ) : null}

      <div className="cf-board-wrap">
        <div className={`cf-drop-row${canAct ? ' active' : ''}`} aria-label="Spalten wählen">
          {Array.from({ length: 7 }, (_, col) => {
            const playable = isColumnPlayable(col);
            return (
              <button
                key={col}
                type="button"
                className={`cf-col-btn${playable ? ' playable' : ''}${playable && hoverCol === col ? ' hovered' : ''}`}
                disabled={!playable}
                onMouseEnter={() => setHoverCol(col)}
                onMouseLeave={() => setHoverCol((cur) => (cur === col ? -1 : cur))}
                onFocus={() => setHoverCol(col)}
                onBlur={() => setHoverCol((cur) => (cur === col ? -1 : cur))}
                onClick={() => handleColumnClick(col)}
                aria-label={`Spalte ${col + 1}${playable ? ' — Stein setzen' : ''}`}
              >
                <span className={`cf-ghost-disc cf-disc-${selfColor}`} aria-hidden />
              </button>
            );
          })}
        </div>
        <div className="cf-board" role="grid" aria-label="Vier gewinnt Brett">
          {board.map((row, rowIdx) => (
            row.map((cell, colIdx) => {
              const key = `${rowIdx}:${colIdx}`;
              const isWin = winSet.has(key);
              const isDrop = dropCell && dropCell.row === rowIdx && dropCell.col === colIdx;
              const isHot = canAct && hoverCol === colIdx && isColumnPlayable(colIdx);
              return (
                <div
                  key={key}
                  className={`cf-cell${isWin ? ' cf-cell-win' : ''}${isHot ? ' cf-cell-hot' : ''}`}
                  role="gridcell"
                  aria-label={cell === 0 ? 'Leer' : `Spieler ${cell}`}
                  onMouseEnter={() => setHoverCol(colIdx)}
                  onMouseLeave={() => setHoverCol((cur) => (cur === colIdx ? -1 : cur))}
                  onClick={() => handleColumnClick(colIdx)}
                >
                  <div
                    key={isDrop ? dropCell.key : 'disc'}
                    className={`cf-disc cf-disc-${DISC_COLORS[cell] || 'empty'}${isWin ? ' cf-disc-win' : ''}${isDrop && cell !== 0 ? ' cf-disc-drop' : ''}`}
                    style={isDrop && cell !== 0 ? { '--cf-fall-row': rowIdx } : undefined}
                  />
                </div>
              );
            })
          ))}
        </div>

        {finished ? (
          <div className="cf-result-overlay" role="alertdialog" aria-label="Ergebnis">
            <div className={`cf-result-card${winner ? ` cf-result-${winnerColor}` : ' cf-result-draw'}`}>
              {winner ? (
                <div className={`cf-result-disc cf-disc-${winnerColor}`} aria-hidden />
              ) : (
                <div className="cf-result-disc cf-result-disc-split" aria-hidden />
              )}
              <h2 className="cf-result-title">
                {winner
                  ? (winner.peerId === selfId ? 'Du hast gewonnen!' : `${winner.name} gewinnt`)
                  : 'Unentschieden'}
              </h2>
              <p className="cf-result-sub">
                {winner ? 'Vier in einer Reihe!' : 'Das Brett ist voll.'}
              </p>
              <div className="cf-result-actions">
                {isHost ? (
                  <button type="button" className="cf-btn-primary cf-rematch-btn" onClick={onRematch}>
                    <Play size={16} /> Revanche
                  </button>
                ) : (
                  <p className="cf-panel-note">Warte auf Revanche vom Host.</p>
                )}
                <button type="button" className="cf-btn-ghost" onClick={onLeave}>
                  <LogOut size={16} /> Verlassen
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className={`cf-self-row${playing && canAct ? '' : ' dimmed'}`}>
        {selfPlayer ? (
          <PlayerAvatar
            player={selfPlayer}
            isActive={canAct}
            isHost={selfPlayer.peerId === pub?.hostPeerId}
            self
            disc={selfPlayer.disc}
          />
        ) : null}
      </div>

      <div className="cf-game-info">
        <span className="cf-phase">{PHASE_LABELS[pub?.phase] || pub?.phase}</span>
        {pub?.message ? <span className="cf-message">{pub.message}</span> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ settings, isHost, onUpdate }) {
  const [local, setLocal] = useState({ ...settings });
  useEffect(() => setLocal({ ...settings }), [settings]);
  if (!isHost) {
    return (
      <div className="cf-settings-readonly">
        <p><strong>Tisch:</strong> {settings?.tableName}</p>
        <p><strong>Spieler:</strong> 2 (fest)</p>
        <p><strong>Lobby:</strong> {settings?.lobbyAccess === 'public' ? 'Öffentlich' : 'Nur auf Einladung'}</p>
      </div>
    );
  }
  return (
    <form className="cf-settings-form" onSubmit={(e) => { e.preventDefault(); onUpdate(local); }}>
      <label>
        Tischname
        <input value={local.tableName || ''} onChange={(e) => setLocal({ ...local, tableName: e.target.value })} />
      </label>
      <label>
        Lobby-Zugang
        <select value={local.lobbyAccess || 'invite'} onChange={(e) => setLocal({ ...local, lobbyAccess: e.target.value })}>
          <option value="invite">Nur auf Einladung</option>
          <option value="public">Öffentlich (Presence-Beitritt)</option>
        </select>
      </label>
      <button type="submit" className="cf-btn-primary">Speichern</button>
    </form>
  );
}

function PlayerManagement({ snapshot, isHost, selfId, onInvite, onKickPlayer }) {
  const players = snapshot?.public?.players || [];
  const candidates = snapshot?.inviteCandidates || [];
  const kickable = isHost ? players.filter((p) => p.peerId !== selfId) : [];

  return (
    <div className="cf-player-management">
      {kickable.length ? (
        <section>
          <h3 className="cf-panel-subheading">Am Tisch</h3>
          <ul className="cf-invite-list">
            {kickable.map((player) => (
              <li key={player.peerId}>
                <span>{player.name}</span>
                <button type="button" className="cf-btn-ghost cf-btn-kick" onClick={() => onKickPlayer(player.peerId)} title={`${player.name} entfernen`}>
                  <UserX size={14} /> Entfernen
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="cf-panel-subheading">Einladen</h3>
        {candidates.length ? (
          <ul className="cf-invite-list">
            {candidates.map((c) => (
              <li key={c.peerId}>
                <span>{c.name}</span>
                <button type="button" className="cf-btn-ghost" onClick={() => onInvite(c.peerId)}>Einladen</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="cf-panel-note">Keine verbundenen Kontakte zum Einladen.</p>
        )}
      </section>
    </div>
  );
}

function ConnectFourGuide() {
  return (
    <div className="cf-guide">
      <p>Setze abwechselnd Steine in eine der sieben Spalten. Der Stein fällt nach unten.</p>
      <ul>
        <li><strong>Ziel:</strong> Vier eigene Steine in einer Reihe — horizontal, vertikal oder diagonal.</li>
        <li><strong>Spieler 1:</strong> Rot · <strong>Spieler 2:</strong> Gelb</li>
        <li><strong>Host</strong> startet die Partie, wenn beide Spieler in der Lobby sind.</li>
      </ul>
    </div>
  );
}

function OverlayPanel({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="cf-panel-overlay" role="presentation" onMouseDown={onClose}>
      <section className="cf-side-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="cf-game-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button></header>
        <div className="cf-side-panel-content">{children}</div>
      </section>
    </div>
  );
}

export default function ConnectFourGamePage() {
  const { snapshot, selfId, isHost, send } = useConnectFourState();
  const [panel, setPanel] = useState('');
  const isMaximized = useConnectFourWindowMaximized();
  const pub = snapshot?.public;
  const inLobby = !pub?.phase || pub.phase === 'lobby';

  const closeWindow = useCallback(() => window.bluetalk?.connectFour?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);
  const drop = useCallback((column) => send({ type: 'action', action: { type: 'drop', column } }), [send]);
  const rematch = useCallback(() => send({ type: 'action', action: { type: 'rematch' } }), [send]);

  if (!snapshot?.public) {
    return (
      <div className="cf-game-root">
        <div className="cf-game-grain" aria-hidden />
        <main className="cf-empty-state">
          <div className="cf-lobby-emblem" aria-hidden>
            <span className="cf-emblem-disc red" />
            <span className="cf-emblem-disc yellow" />
            <span className="cf-emblem-disc yellow" />
            <span className="cf-emblem-disc red" />
          </div>
          <h1>Vier gewinnt wird vorbereitet…</h1>
          <p>Starte oder öffne ein Spiel über den Spiele-Bereich im Hauptfenster.</p>
          <button type="button" className="cf-btn-ghost" onClick={() => send({ type: 'request_state' })}>Erneut laden</button>
        </main>
      </div>
    );
  }

  return (
    <div className="cf-game-root">
      <div className="cf-game-grain" aria-hidden />
      <header className="cf-game-titlebar">
        <div className="cf-title">
          <h1>{pub.settings?.tableName || 'Vier gewinnt'}</h1>
          <div className="cf-game-titlebar-sub">
            {PHASE_LABELS[pub.phase] || pub.phase}{isHost ? ' · Du bist Host' : ''}
          </div>
        </div>
        <div className="cf-game-titlebar-actions">
          <button type="button" className="cf-game-btn-icon" title="Hilfe" onClick={() => setPanel('help')}><HelpCircle size={16} /></button>
          {isHost ? <button type="button" className="cf-game-btn-icon" title="Spieler" onClick={() => setPanel('players')}><Users size={16} /></button> : null}
          <button type="button" className="cf-game-btn-icon" title="Einstellungen" onClick={() => setPanel('settings')}><Settings size={16} /></button>
          {isHost ? <button type="button" className="cf-game-btn-icon" title="Speichern" onClick={() => send({ type: 'save_game' })}><Save size={16} /></button> : null}
          <button type="button" className="cf-game-btn-icon" title="Verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="cf-game-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.connectFour?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="cf-game-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.connectFour?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="cf-game-btn-icon" title="Schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>
      <main className="cf-game-main">
        {inLobby ? (
          <LobbyView snapshot={snapshot} selfId={selfId} isHost={isHost} onStart={() => send({ type: 'host_start' })} onLeave={leave} />
        ) : (
          <BoardView
            snapshot={snapshot}
            selfId={selfId}
            isHost={isHost}
            onDrop={drop}
            onRematch={rematch}
            onLeave={leave}
          />
        )}
      </main>
      {panel === 'help' ? (
        <OverlayPanel title="Spielregeln" onClose={() => setPanel('')}>
          <ConnectFourGuide />
        </OverlayPanel>
      ) : null}
      {panel === 'settings' ? (
        <OverlayPanel title="Einstellungen" onClose={() => setPanel('')}>
          <SettingsPanel
            settings={pub.settings}
            isHost={isHost}
            onUpdate={(settings) => send({ type: 'update_settings', settings })}
          />
        </OverlayPanel>
      ) : null}
      {panel === 'players' && isHost ? (
        <OverlayPanel title="Spieler" onClose={() => setPanel('')}>
          <PlayerManagement
            snapshot={snapshot}
            isHost={isHost}
            selfId={selfId}
            onInvite={(peerId) => send({ type: 'invite', peerId })}
            onKickPlayer={(peerId) => send({ type: 'kick_player', peerId })}
          />
        </OverlayPanel>
      ) : null}
    </div>
  );
}
