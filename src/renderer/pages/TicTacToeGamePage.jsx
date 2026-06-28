import React, { useCallback, useEffect, useMemo, useState } from 'react';
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
import './TicTacToeGamePage.css';

const PHASE_LABELS = {
  lobby: 'Lobby',
  playing: 'Spiel läuft',
  finished: 'Partie beendet',
};

const MARK_CLASSES = {
  X: 'ttt-mark-x',
  O: 'ttt-mark-o',
  '△': 'ttt-mark-tri',
  '□': 'ttt-mark-sq',
};

function useTicTacToeState() {
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
    if (!window.bluetalk?.ticTacToe?.onState) return undefined;
    const off = window.bluetalk.ticTacToe.onState((payload) => setSnapshot(payload || null));
    window.bluetalk.ticTacToe.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.ticTacToe?.sendAction?.({ type: 'request_state' });
    }, 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.ticTacToe?.sendAction?.(payload);
  }, []);

  return {
    snapshot,
    selfId,
    isHost: Boolean(selfId && snapshot?.public?.hostPeerId === selfId),
    send,
  };
}

function useTicTacToeWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.bluetalk?.ticTacToe;
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

function PlayerAvatar({ player, isActive, isHost, self = false }) {
  const initials = player?.name?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
  const mark = player?.mark || '?';
  return (
    <div className={`ttt-player-avatar${isActive ? ' active' : ''}${player?.connected === false ? ' disconnected' : ''}${self ? ' self' : ''}`}>
      <div className={`ttt-avatar-circle ${MARK_CLASSES[mark] || ''}`}>
        <span className="ttt-avatar-mark">{mark}</span>
        {isHost ? <Crown size={11} className="ttt-host-icon" aria-label="Host" /> : null}
      </div>
      <div className="ttt-avatar-name">{player?.name || 'Spieler'}{self ? ' (du)' : ''}</div>
    </div>
  );
}

function LobbyView({ snapshot, selfId, isHost, onStart, onLeave }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const settings = pub?.settings || {};
  const maxPlayers = settings.maxPlayers || 2;
  const isSolo = settings.playMode === 'solo';
  const canStart = isSolo
    ? players.some((p) => !p.isAi)
    : players.filter((p) => !p.isAi).length >= 2;

  return (
    <div className="ttt-lobby">
      <div className="ttt-lobby-header">
        <h2>{settings.tableName || 'Tic-Tac-Toe'}</h2>
        <div className="ttt-lobby-meta">
          <span><Users size={14} /> {players.filter((p) => !p.isAi).length}/{isSolo ? 1 : maxPlayers}</span>
          <span>{settings.boardSize || 3}×{settings.boardSize || 3} · {settings.winLength || 3} in einer Reihe</span>
          <span>{isSolo ? 'Solo vs Algorithmus' : 'Online'}</span>
        </div>
      </div>
      <div className="ttt-lobby-seats">
        {players.map((player) => (
          <div key={player.peerId} className="ttt-lobby-seat occupied">
            <PlayerAvatar
              player={player}
              isHost={player.peerId === pub.hostPeerId}
              self={player.peerId === selfId}
            />
          </div>
        ))}
        {!isSolo ? Array.from({ length: Math.max(0, maxPlayers - players.length) }, (_, seat) => (
          <div key={`empty-${seat}`} className="ttt-lobby-seat empty">
            <span className="ttt-lobby-empty">Platz {players.length + seat + 1}</span>
          </div>
        )) : null}
      </div>
      <div className="ttt-lobby-actions">
        {isHost ? (
          <button type="button" className="ttt-btn-primary" onClick={onStart} disabled={!canStart}>
            <Play size={16} /> Spiel starten
          </button>
        ) : (
          <p className="ttt-panel-note">Warte, bis der Host das Spiel startet.</p>
        )}
        <button type="button" className="ttt-btn-ghost" onClick={onLeave}><LogOut size={16} /> Verlassen</button>
      </div>
    </div>
  );
}

function BoardView({ snapshot, selfId, onPlace, onRematch, isHost }) {
  const pub = snapshot?.public;
  const board = pub?.board || [];
  const players = pub?.players || [];
  const size = board.length || pub?.settings?.boardSize || 3;
  const canAct = pub?.toAct === selfId && pub?.phase === 'playing';
  const winSet = useMemo(() => {
    const cells = pub?.winCells || [];
    return new Set(cells.map((c) => `${c.row}:${c.col}`));
  }, [pub?.winCells]);

  const markForDisc = (disc) => {
    const player = players.find((p) => p.disc === disc);
    return player?.mark || pub?.playerMarks?.[(disc || 1) - 1] || '?';
  };

  const handleCellClick = (row, col) => {
    if (!canAct || board[row][col] !== 0) return;
    onPlace(row, col);
  };

  const finished = pub?.phase === 'finished';
  const winner = players.find((p) => p.peerId === pub?.winnerPeerId);
  const actor = players.find((p) => p.peerId === pub?.toAct);

  return (
    <div className="ttt-table-container">
      <div className="ttt-players-row">
        {players.map((player) => (
          <PlayerAvatar
            key={player.peerId}
            player={player}
            isActive={pub?.toAct === player.peerId}
            isHost={player.peerId === pub?.hostPeerId}
            self={player.peerId === selfId}
          />
        ))}
      </div>

      <div
        className="ttt-board"
        role="grid"
        aria-label="Tic-Tac-Toe Spielfeld"
        style={{
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${size}, minmax(0, 1fr))`,
        }}
      >
        {board.map((row, rowIdx) => (
          row.map((cell, colIdx) => {
            const key = `${rowIdx}:${colIdx}`;
            const isWin = winSet.has(key);
            const mark = cell ? markForDisc(cell) : '';
            const playable = canAct && cell === 0;
            return (
              <button
                key={key}
                type="button"
                className={`ttt-cell${isWin ? ' ttt-cell-win' : ''}${playable ? ' playable' : ''}`}
                role="gridcell"
                disabled={!playable}
                onClick={() => handleCellClick(rowIdx, colIdx)}
                aria-label={cell ? `Feld ${mark}` : `Leeres Feld ${rowIdx + 1}, ${colIdx + 1}`}
              >
                {mark ? <span className={`ttt-cell-mark ${MARK_CLASSES[mark] || ''}`}>{mark}</span> : null}
              </button>
            );
          })
        ))}
      </div>

      <div className="ttt-game-info">
        <span className="ttt-phase">{PHASE_LABELS[pub?.phase] || pub?.phase}</span>
        {pub?.message ? <span className="ttt-message">{pub.message}</span> : null}
      </div>

      {finished ? (
        <div className="ttt-finished-banner">
          {winner ? (
            winner.peerId === selfId
              ? 'Du hast gewonnen!'
              : `${winner.name} hat gewonnen.`
          ) : (
            'Unentschieden — das Feld ist voll.'
          )}
          {isHost ? (
            <button type="button" className="ttt-btn-primary ttt-rematch-btn" onClick={onRematch}>
              <Play size={16} /> Revanche
            </button>
          ) : (
            <p className="ttt-panel-note">Warte auf Revanche vom Host.</p>
          )}
        </div>
      ) : null}

      {!finished && pub?.phase === 'playing' ? (
        <div className="ttt-turn-banner">
          {canAct ? 'Du bist am Zug.' : `${actor?.name || 'Ein Spieler'} ist am Zug.`}
        </div>
      ) : null}
    </div>
  );
}

function SettingsPanel({ settings, isHost, onUpdate }) {
  const [local, setLocal] = useState({ ...settings });
  useEffect(() => setLocal({ ...settings }), [settings]);

  const boardSize = Number(local.boardSize) || 3;
  const winOptions = [3, 4, 5].filter((n) => n <= boardSize);

  if (!isHost) {
    return (
      <div className="ttt-settings-readonly">
        <p><strong>Tisch:</strong> {settings?.tableName}</p>
        <p><strong>Modus:</strong> {settings?.playMode === 'solo' ? 'Solo vs Algorithmus' : 'Online'}</p>
        <p><strong>Feld:</strong> {settings?.boardSize}×{settings?.boardSize}</p>
        <p><strong>Gewinn:</strong> {settings?.winLength} in einer Reihe</p>
        {settings?.playMode === 'online' ? (
          <p><strong>Spieler:</strong> max. {settings?.maxPlayers}</p>
        ) : (
          <p><strong>KI:</strong> {settings?.aiDifficulty === 'hard' ? 'Schwer' : settings?.aiDifficulty === 'easy' ? 'Leicht' : 'Mittel'}</p>
        )}
        <p><strong>Lobby:</strong> {settings?.lobbyAccess === 'public' ? 'Öffentlich' : 'Nur auf Einladung'}</p>
      </div>
    );
  }

  return (
    <form className="ttt-settings-form" onSubmit={(e) => { e.preventDefault(); onUpdate(local); }}>
      <label>
        Tischname
        <input value={local.tableName || ''} onChange={(e) => setLocal({ ...local, tableName: e.target.value })} />
      </label>
      <label>
        Modus
        <select
          value={local.playMode || 'solo'}
          onChange={(e) => setLocal({
            ...local,
            playMode: e.target.value,
            maxPlayers: e.target.value === 'solo' ? 2 : local.maxPlayers,
          })}
        >
          <option value="solo">Solo vs Algorithmus</option>
          <option value="online">Online (P2P)</option>
        </select>
      </label>
      <label>
        Feldgröße
        <select
          value={local.boardSize || 3}
          onChange={(e) => {
            const nextSize = Number(e.target.value);
            setLocal({
              ...local,
              boardSize: nextSize,
              winLength: Math.min(Number(local.winLength) || 3, nextSize),
            });
          }}
        >
          <option value={3}>3×3 (klassisch)</option>
          <option value={5}>5×5</option>
          <option value={7}>7×7</option>
        </select>
      </label>
      <label>
        Gewinnbedingung
        <select
          value={Math.min(Number(local.winLength) || 3, boardSize)}
          onChange={(e) => setLocal({ ...local, winLength: Number(e.target.value) })}
        >
          {winOptions.map((n) => (
            <option key={n} value={n}>{n} in einer Reihe</option>
          ))}
        </select>
      </label>
      {local.playMode === 'online' ? (
        <label>
          Max. Spieler
          <select value={local.maxPlayers || 2} onChange={(e) => setLocal({ ...local, maxPlayers: Number(e.target.value) })}>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
      ) : (
        <label>
          KI-Schwierigkeit
          <select value={local.aiDifficulty || 'medium'} onChange={(e) => setLocal({ ...local, aiDifficulty: e.target.value })}>
            <option value="easy">Leicht</option>
            <option value="medium">Mittel</option>
            <option value="hard">Schwer</option>
          </select>
        </label>
      )}
      {local.playMode === 'online' ? (
        <label>
          Lobby-Zugang
          <select value={local.lobbyAccess || 'invite'} onChange={(e) => setLocal({ ...local, lobbyAccess: e.target.value })}>
            <option value="invite">Nur auf Einladung</option>
            <option value="public">Öffentlich (Presence-Beitritt)</option>
          </select>
        </label>
      ) : null}
      <button type="submit" className="ttt-btn-primary">Speichern</button>
    </form>
  );
}

function PlayerManagement({ snapshot, isHost, selfId, onInvite, onKickPlayer }) {
  const players = snapshot?.public?.players || [];
  const candidates = snapshot?.inviteCandidates || [];
  const kickable = isHost ? players.filter((p) => p.peerId !== selfId && !p.isAi) : [];

  return (
    <div className="ttt-player-management">
      {kickable.length ? (
        <section>
          <h3 className="ttt-panel-subheading">Am Tisch</h3>
          <ul className="ttt-invite-list">
            {kickable.map((player) => (
              <li key={player.peerId}>
                <span>{player.name}</span>
                <button type="button" className="ttt-btn-ghost ttt-btn-kick" onClick={() => onKickPlayer(player.peerId)} title={`${player.name} entfernen`}>
                  <UserX size={14} /> Entfernen
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="ttt-panel-subheading">Einladen</h3>
        {candidates.length ? (
          <ul className="ttt-invite-list">
            {candidates.map((c) => (
              <li key={c.peerId}>
                <span>{c.name}</span>
                <button type="button" className="ttt-btn-ghost" onClick={() => onInvite(c.peerId)}>Einladen</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ttt-panel-note">Keine verbundenen Kontakte zum Einladen.</p>
        )}
      </section>
    </div>
  );
}

function TicTacToeGuide() {
  return (
    <div className="ttt-guide">
      <p>Setze abwechselnd dein Symbol in ein freies Feld. Wer zuerst die gewählte Anzahl in einer Reihe hat, gewinnt.</p>
      <ul>
        <li><strong>Klassisch:</strong> 3×3, drei in einer Reihe (X und O).</li>
        <li><strong>Erweitert:</strong> 5×5 oder 7×7 mit 3–5 in einer Reihe — auch diagonal.</li>
        <li><strong>Online:</strong> 2–4 Spieler mit Symbolen X, O, △, □.</li>
        <li><strong>Solo:</strong> Du spielst gegen einen lokalen Algorithmus (Leicht/Mittel/Schwer).</li>
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
    <div className="ttt-panel-overlay" role="presentation" onMouseDown={onClose}>
      <section className="ttt-side-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="ttt-game-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button></header>
        <div className="ttt-side-panel-content">{children}</div>
      </section>
    </div>
  );
}

export default function TicTacToeGamePage() {
  const { snapshot, selfId, isHost, send } = useTicTacToeState();
  const [panel, setPanel] = useState('');
  const isMaximized = useTicTacToeWindowMaximized();
  const pub = snapshot?.public;
  const inLobby = !pub?.phase || pub.phase === 'lobby';
  const isSolo = pub?.settings?.playMode === 'solo';

  const closeWindow = useCallback(() => window.bluetalk?.ticTacToe?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);
  const place = useCallback((row, col) => send({ type: 'action', action: { type: 'place', row, col } }), [send]);
  const rematch = useCallback(() => send({ type: 'action', action: { type: 'rematch' } }), [send]);

  if (!snapshot?.public) {
    return (
      <div className="ttt-game-root">
        <main className="ttt-empty-state">
          <div className="ttt-launch-mark">✕</div>
          <h1>Tic-Tac-Toe wird vorbereitet…</h1>
          <p>Starte oder öffne ein Spiel über den Spiele-Bereich im Hauptfenster.</p>
          <button type="button" className="ttt-btn-ghost" onClick={() => send({ type: 'request_state' })}>Erneut laden</button>
        </main>
      </div>
    );
  }

  return (
    <div className="ttt-game-root">
      <div className="ttt-game-grain" aria-hidden />
      <header className="ttt-game-titlebar">
        <div className="ttt-title">
          <h1>{pub.settings?.tableName || 'Tic-Tac-Toe'}</h1>
          <div className="ttt-game-titlebar-sub">
            {PHASE_LABELS[pub.phase] || pub.phase}{isHost ? ' · Du bist Host' : ''}
          </div>
        </div>
        <div className="ttt-game-titlebar-actions">
          <button type="button" className="ttt-game-btn-icon" title="Hilfe" onClick={() => setPanel('help')}><HelpCircle size={16} /></button>
          {isHost && !isSolo ? <button type="button" className="ttt-game-btn-icon" title="Spieler" onClick={() => setPanel('players')}><Users size={16} /></button> : null}
          <button type="button" className="ttt-game-btn-icon" title="Einstellungen" onClick={() => setPanel('settings')}><Settings size={16} /></button>
          {isHost ? <button type="button" className="ttt-game-btn-icon" title="Speichern" onClick={() => send({ type: 'save_game' })}><Save size={16} /></button> : null}
          <button type="button" className="ttt-game-btn-icon" title="Verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="ttt-game-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.ticTacToe?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="ttt-game-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.ticTacToe?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="ttt-game-btn-icon" title="Schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>
      <main className="ttt-game-main">
        {inLobby ? (
          <LobbyView snapshot={snapshot} selfId={selfId} isHost={isHost} onStart={() => send({ type: 'host_start' })} onLeave={leave} />
        ) : (
          <BoardView snapshot={snapshot} selfId={selfId} isHost={isHost} onPlace={place} onRematch={rematch} />
        )}
      </main>
      {panel === 'help' ? (
        <OverlayPanel title="Spielregeln" onClose={() => setPanel('')}>
          <TicTacToeGuide />
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
      {panel === 'players' && isHost && !isSolo ? (
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
