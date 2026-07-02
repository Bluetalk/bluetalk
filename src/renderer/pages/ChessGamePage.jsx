import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crown,
  Flag,
  HeartHandshake,
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
import './ChessGamePage.css';

const PHASE_LABELS = {
  lobby: 'Lobby',
  playing: 'Partie läuft',
  gameOver: 'Partie beendet',
};

// Gefüllte Glyphen für beide Seiten — die Farbe kommt aus dem CSS,
// damit Figuren auf hellen und dunklen Feldern gleich gut lesbar sind.
const PIECE_GLYPHS = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };

const PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9 };
const INITIAL_COUNTS = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
const CAPTURE_ORDER = ['Q', 'R', 'B', 'N', 'P'];

const PROMOTION_OPTIONS = [
  { key: 'q', type: 'Q', title: 'Dame' },
  { key: 'r', type: 'R', title: 'Turm' },
  { key: 'b', type: 'B', title: 'Läufer' },
  { key: 'n', type: 'N', title: 'Springer' },
];

const TIME_LABELS = {
  0: 'Unbegrenzt',
  60: '1 Min.',
  180: '3 Min.',
  300: '5 Min.',
  600: '10 Min.',
  900: '15 Min.',
  1800: '30 Min.',
};

function fenToBoard(fen) {
  if (!fen) return Array.from({ length: 8 }, () => Array(8).fill(null));
  const rows = String(fen).split(/\s+/)[0].split('/');
  const board = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (const ch of rows[r] || '') {
      if (ch >= '1' && ch <= '8') {
        for (let i = 0; i < Number(ch); i++) row.push(null);
      } else {
        const color = ch === ch.toUpperCase() ? 'w' : 'b';
        row.push({ color, type: ch.toUpperCase() });
      }
    }
    while (row.length < 8) row.push(null);
    board.push(row);
  }
  return board;
}

function algToCoords(alg) {
  if (!alg || alg.length < 2) return null;
  const file = alg.charCodeAt(0) - 97;
  const rank = Number(alg.slice(1));
  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
  return { r: 8 - rank, c: file };
}

function coordsToAlg(r, c) {
  return `${String.fromCharCode(97 + c)}${8 - r}`;
}

function formatClock(ms) {
  if (ms == null || ms < 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

// Aus dem FEN ableiten, welche Figuren jede Seite geschlagen hat,
// plus Materialdifferenz (positiv = Weiß vorn).
function computeCaptures(board) {
  const onBoard = { w: { P: 0, N: 0, B: 0, R: 0, Q: 0 }, b: { P: 0, N: 0, B: 0, R: 0, Q: 0 } };
  for (const row of board) {
    for (const piece of row) {
      if (piece && piece.type !== 'K') onBoard[piece.color][piece.type] += 1;
    }
  }
  const capturedBy = { w: [], b: [] };
  let materialDiff = 0;
  for (const type of CAPTURE_ORDER) {
    const missingBlack = Math.max(0, INITIAL_COUNTS[type] - onBoard.b[type]);
    const missingWhite = Math.max(0, INITIAL_COUNTS[type] - onBoard.w[type]);
    for (let i = 0; i < missingBlack; i++) capturedBy.w.push(type);
    for (let i = 0; i < missingWhite; i++) capturedBy.b.push(type);
    materialDiff += (onBoard.w[type] - onBoard.b[type]) * PIECE_VALUES[type];
  }
  return { capturedBy, materialDiff };
}

function useChessState() {
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
    if (!window.bluetalk?.chess?.onState) return undefined;
    const off = window.bluetalk.chess.onState((payload) => setSnapshot(payload || null));
    window.bluetalk.chess.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.chess?.sendAction?.({ type: 'request_state' });
    }, 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.chess?.sendAction?.(payload);
  }, []);

  return {
    snapshot,
    selfId,
    isHost: Boolean(selfId && snapshot?.public?.hostPeerId === selfId),
    send,
  };
}

function useChessWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.bluetalk?.chess;
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

function OverlayPanel({ title, onClose, children }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="chess-panel-overlay" role="presentation" onMouseDown={onClose}>
      <section className="chess-side-panel-dialog" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <button type="button" className="chess-game-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button>
        </header>
        <div className="chess-side-panel-content">{children}</div>
      </section>
    </div>
  );
}

function SettingsPanel({ settings, isHost, onUpdate }) {
  const [local, setLocal] = useState({ ...settings });
  useEffect(() => setLocal({ ...settings }), [settings]);

  if (!isHost) {
    return (
      <div className="chess-settings-readonly">
        <p><strong>Partie:</strong> {settings?.tableName}</p>
        <p><strong>Zeit:</strong> {TIME_LABELS[settings?.timeControlSec] || `${settings?.timeControlSec}s`}</p>
        <p><strong>Lobby:</strong> {settings?.lobbyAccess === 'public' ? 'Öffentlich' : 'Nur auf Einladung'}</p>
      </div>
    );
  }

  return (
    <form className="chess-settings-form" onSubmit={(e) => { e.preventDefault(); onUpdate(local); }}>
      <label>
        Partiename
        <input value={local.tableName || ''} onChange={(e) => setLocal({ ...local, tableName: e.target.value })} />
      </label>
      <label>
        Zeitkontrolle
        <select value={local.timeControlSec ?? 0} onChange={(e) => setLocal({ ...local, timeControlSec: Number(e.target.value) })}>
          {Object.entries(TIME_LABELS).map(([sec, label]) => (
            <option key={sec} value={sec}>{label}</option>
          ))}
        </select>
      </label>
      <label>
        Lobby-Zugang
        <select value={local.lobbyAccess || 'invite'} onChange={(e) => setLocal({ ...local, lobbyAccess: e.target.value })}>
          <option value="invite">Nur auf Einladung</option>
          <option value="public">Öffentlich (Presence-Beitritt)</option>
        </select>
      </label>
      <button type="submit" className="chess-btn-primary">Speichern</button>
    </form>
  );
}

function PlayerManagement({ snapshot, isHost, selfId, onInvite, onKickPlayer }) {
  const players = snapshot?.public?.players || [];
  const candidates = snapshot?.inviteCandidates || [];
  const kickable = isHost ? players.filter((p) => p.peerId !== selfId) : [];

  return (
    <div>
      {kickable.length ? (
        <section>
          <h3 className="chess-panel-subheading">An der Partie</h3>
          <ul className="chess-invite-list">
            {kickable.map((player) => (
              <li key={player.peerId}>
                <span>{player.name} ({player.color === 'w' ? 'Weiß' : 'Schwarz'})</span>
                <button type="button" className="chess-btn-ghost" onClick={() => onKickPlayer(player.peerId)}>
                  <UserX size={14} /> Entfernen
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="chess-panel-subheading">Einladen</h3>
        {candidates.length ? (
          <ul className="chess-invite-list">
            {candidates.map((c) => (
              <li key={c.peerId}>
                <span>{c.name}</span>
                <button type="button" className="chess-btn-ghost" onClick={() => onInvite(c.peerId)}>Einladen</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="chess-panel-note">Keine verbundenen Kontakte zum Einladen.</p>
        )}
      </section>
    </div>
  );
}

function LobbyView({ snapshot, isHost, onStart, onLeave, onOpenPlayers }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const canStart = isHost && players.length >= 2 && players.every((p) => p.connected !== false);
  const settings = pub?.settings;

  return (
    <div className="chess-lobby">
      <div className="chess-lobby-emblem" aria-hidden>♞</div>
      <h2>{settings?.tableName || 'Schach-Partie'}</h2>
      <p className="chess-lobby-sub">
        {TIME_LABELS[settings?.timeControlSec] || 'Unbegrenzt'}
        {' · '}
        {settings?.lobbyAccess === 'public' ? 'Öffentliche Lobby' : 'Nur auf Einladung'}
      </p>
      <ul className="chess-lobby-players">
        {players.map((p) => (
          <li key={p.peerId} className={p.connected === false ? 'chess-lobby-player--offline' : ''}>
            <span className={`chess-color-chip chess-color-chip--${p.color}`} aria-hidden />
            <span className="chess-lobby-player-name">{p.name}</span>
            <span className="chess-lobby-player-side">
              {p.color === 'w' ? 'Weiß' : 'Schwarz'}{p.connected === false ? ' · offline' : ''}
            </span>
          </li>
        ))}
        {players.length < 2 ? (
          <li className="chess-lobby-waiting">
            <span className="chess-lobby-waiting-dot" aria-hidden />
            <span>Wartet auf Gegner…</span>
            {isHost && onOpenPlayers ? (
              <button type="button" className="chess-btn-ghost" onClick={onOpenPlayers}>Einladen</button>
            ) : null}
          </li>
        ) : null}
      </ul>
      {pub?.message ? <p className="chess-status-msg">{pub.message}</p> : null}
      <div className="chess-lobby-actions">
        {isHost ? (
          <button type="button" className="chess-btn-primary" disabled={!canStart} onClick={onStart}>
            <Play size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} />
            Partie starten
          </button>
        ) : (
          <p className="chess-panel-note">Warte auf den Host…</p>
        )}
        <button type="button" className="chess-btn-ghost" onClick={onLeave}>Verlassen</button>
      </div>
    </div>
  );
}

function PromotionDialog({ color, onPick, onCancel }) {
  return (
    <div className="chess-promotion-overlay" role="presentation">
      <div className="chess-promotion-dialog" role="dialog" aria-label="Bauernumwandlung">
        <h3>Umwandeln in …</h3>
        <div className="chess-promotion-pieces">
          {PROMOTION_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              title={opt.title}
              className={`chess-promotion-piece chess-piece--${color}`}
              onClick={() => onPick(opt.key)}
            >
              {PIECE_GLYPHS[opt.type]}
              <span className="chess-promotion-label">{opt.title}</span>
            </button>
          ))}
        </div>
        <button type="button" className="chess-btn-ghost" style={{ marginTop: 12 }} onClick={onCancel}>Abbrechen</button>
      </div>
    </div>
  );
}

function CapturedRow({ pieces, advantage }) {
  return (
    <div className="chess-captured" aria-label="Geschlagene Figuren">
      {pieces.map((type, i) => (
        <span key={`${type}${i}`} className="chess-captured-piece">{PIECE_GLYPHS[type]}</span>
      ))}
      {advantage > 0 ? <span className="chess-captured-adv">+{advantage}</span> : null}
    </div>
  );
}

function PlayerPlate({ player, color, clockMs, isActive, isSelf, isLowTime, captured, advantage, inCheck }) {
  return (
    <div className={`chess-plate${isActive ? ' chess-plate--active' : ''}`}>
      <span className={`chess-color-chip chess-color-chip--${color}`} aria-hidden />
      <div className="chess-plate-info">
        <div className="chess-plate-name">
          {player?.name || (color === 'w' ? 'Weiß' : 'Schwarz')}
          {isSelf ? <span className="chess-plate-you">Du</span> : null}
          {player?.connected === false ? <span className="chess-plate-offline">offline</span> : null}
          {inCheck ? <span className="chess-plate-check">Schach!</span> : null}
        </div>
        <CapturedRow pieces={captured} advantage={advantage} />
      </div>
      {clockMs != null ? (
        <div className={`chess-clock${isActive ? ' chess-clock--active' : ''}${isLowTime ? ' chess-clock--low' : ''}`}>
          {formatClock(clockMs)}
        </div>
      ) : null}
    </div>
  );
}

function MoveList({ moveHistory }) {
  const listRef = useRef(null);
  const rows = useMemo(() => {
    const out = [];
    for (let i = 0; i < moveHistory.length; i += 2) {
      out.push({ num: i / 2 + 1, white: moveHistory[i], black: moveHistory[i + 1] || null });
    }
    return out;
  }, [moveHistory]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [moveHistory.length]);

  return (
    <div className="chess-movelist-wrap">
      <h3 className="chess-panel-subheading">Notation</h3>
      <div className="chess-movelist" ref={listRef}>
        {rows.length ? rows.map((row, idx) => {
          const isLastRow = idx === rows.length - 1;
          const lastIsBlack = Boolean(row.black);
          return (
            <div className="chess-movelist-row" key={row.num}>
              <span className="chess-movelist-num">{row.num}.</span>
              <span className={`chess-movelist-san${isLastRow && !lastIsBlack ? ' chess-movelist-san--current' : ''}`}>{row.white?.san || ''}</span>
              <span className={`chess-movelist-san${isLastRow && lastIsBlack ? ' chess-movelist-san--current' : ''}`}>{row.black?.san || ''}</span>
            </div>
          );
        }) : <p className="chess-panel-note">Noch keine Züge.</p>}
      </div>
    </div>
  );
}

function ChessBoard({
  fen,
  myColor,
  myLegalMoves,
  lastMove,
  inCheck,
  turn,
  disabled,
  onMove,
}) {
  const [selected, setSelected] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null);

  const board = useMemo(() => fenToBoard(fen), [fen]);
  const flipped = myColor === 'b';

  const displayRows = useMemo(() => (
    Array.from({ length: 8 }, (_, dr) => (flipped ? 7 - dr : dr))
  ), [flipped]);

  const displayCols = useMemo(() => (
    Array.from({ length: 8 }, (_, dc) => (flipped ? 7 - dc : dc))
  ), [flipped]);

  const legalFromSelected = useMemo(() => {
    if (!selected) return [];
    const fromAlg = coordsToAlg(selected.r, selected.c);
    return (myLegalMoves || []).filter((m) => m.from === fromAlg);
  }, [selected, myLegalMoves]);

  const targetSet = useMemo(() => {
    const set = new Map();
    for (const m of legalFromSelected) {
      set.set(m.to, m);
    }
    return set;
  }, [legalFromSelected]);

  const lastFrom = lastMove?.from ? algToCoords(lastMove.from) : null;
  const lastTo = lastMove?.to ? algToCoords(lastMove.to) : null;

  const kingSquare = useMemo(() => {
    if (!inCheck) return null;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = board[r][c];
        if (p && p.color === turn && p.type === 'K') return { r, c };
      }
    }
    return null;
  }, [board, inCheck, turn]);

  useEffect(() => {
    setSelected(null);
    setPendingPromotion(null);
  }, [fen, turn]);

  const tryMove = useCallback((from, to, promotion) => {
    const fromAlg = coordsToAlg(from.r, from.c);
    const toAlg = coordsToAlg(to.r, to.c);
    const candidates = (myLegalMoves || []).filter((m) => m.from === fromAlg && m.to === toAlg);
    if (!candidates.length) return;

    if (!promotion && candidates.some((m) => m.promotion)) {
      setPendingPromotion({ from, to, options: candidates });
      return;
    }

    const promo = promotion || candidates[0].promotion;
    onMove({ type: 'move', from: fromAlg, to: toAlg, promotion: promo });
    setSelected(null);
    setPendingPromotion(null);
  }, [myLegalMoves, onMove]);

  const onSquareClick = (r, c) => {
    if (disabled) return;
    const piece = board[r][c];
    const alg = coordsToAlg(r, c);

    if (selected) {
      if (selected.r === r && selected.c === c) {
        setSelected(null);
        return;
      }
      if (targetSet.has(alg)) {
        tryMove(selected, { r, c });
        return;
      }
    }

    if (piece && piece.color === myColor && myColor === turn) {
      const fromAlg = coordsToAlg(r, c);
      const hasMoves = (myLegalMoves || []).some((m) => m.from === fromAlg);
      if (hasMoves) setSelected({ r, c });
    }
  };

  return (
    <>
      <div className="chess-board-wrap">
        <div className="chess-board" role="grid" aria-label="Schachbrett">
          {displayRows.map((r, dr) => displayCols.map((c, dc) => {
            const isLight = (r + c) % 2 === 0;
            const piece = board[r][c];
            const alg = coordsToAlg(r, c);
            const isSelected = selected?.r === r && selected?.c === c;
            const isTarget = targetSet.has(alg);
            const isCapture = isTarget && board[r][c];
            const isLast = (lastFrom && lastFrom.r === r && lastFrom.c === c)
              || (lastTo && lastTo.r === r && lastTo.c === c);
            const isLandingSquare = lastTo && lastTo.r === r && lastTo.c === c;
            const isKingCheck = kingSquare && kingSquare.r === r && kingSquare.c === c;

            let className = `chess-square chess-square--${isLight ? 'light' : 'dark'}`;
            if (isSelected) className += ' chess-square--selected';
            if (isLast) className += ' chess-square--last-move';
            if (isTarget && !isCapture) className += ' chess-square--target';
            if (isCapture) className += ' chess-square--capture';
            if (isKingCheck) className += ' chess-square--check';

            return (
              <button
                key={alg}
                type="button"
                className={className}
                disabled={disabled}
                aria-label={piece ? `${piece.color === 'w' ? 'Weiß' : 'Schwarz'} ${piece.type} ${alg}` : alg}
                onClick={() => onSquareClick(r, c)}
              >
                {dc === 0 ? <span className="chess-coord chess-coord--rank" aria-hidden>{8 - r}</span> : null}
                {dr === 7 ? <span className="chess-coord chess-coord--file" aria-hidden>{String.fromCharCode(97 + c)}</span> : null}
                {piece ? (
                  <span
                    key={`${alg}-${piece.color}${piece.type}`}
                    className={`chess-piece chess-piece--${piece.color}${isLandingSquare ? ' chess-piece--landed' : ''}`}
                  >
                    {PIECE_GLYPHS[piece.type]}
                  </span>
                ) : null}
              </button>
            );
          }))}
        </div>
      </div>
      {pendingPromotion ? (
        <PromotionDialog
          color={myColor}
          onPick={(promotion) => tryMove(pendingPromotion.from, pendingPromotion.to, promotion)}
          onCancel={() => setPendingPromotion(null)}
        />
      ) : null}
    </>
  );
}

function GameView({ snapshot, onAction, onLeave }) {
  const pub = snapshot?.public;
  const myColor = snapshot?.myColor;
  const myLegalMoves = snapshot?.myLegalMoves || [];
  const isMyTurn = pub?.turn === myColor && pub?.phase === 'playing';
  const clocks = pub?.clocks;
  const drawOffer = pub?.drawOffer;
  const result = pub?.gameResult;

  const whitePlayer = pub?.players?.find((p) => p.color === 'w');
  const blackPlayer = pub?.players?.find((p) => p.color === 'b');

  const board = useMemo(() => fenToBoard(pub?.fen), [pub?.fen]);
  const { capturedBy, materialDiff } = useMemo(() => computeCaptures(board), [board]);

  // Aus eigener Sicht: Gegner oben, man selbst unten.
  const bottomColor = myColor === 'b' ? 'b' : 'w';
  const topColor = bottomColor === 'w' ? 'b' : 'w';
  const plateFor = (color) => ({
    player: color === 'w' ? whitePlayer : blackPlayer,
    clockMs: clocks ? (color === 'w' ? clocks.whiteMs : clocks.blackMs) : null,
    isActive: pub?.phase === 'playing' && pub?.turn === color && !result,
    isLowTime: clocks ? (color === 'w' ? clocks.whiteMs : clocks.blackMs) < 30000 : false,
    captured: capturedBy[color],
    advantage: color === 'w' ? Math.max(0, materialDiff) : Math.max(0, -materialDiff),
    inCheck: Boolean(pub?.inCheck && pub?.turn === color),
  });

  let banner = null;
  let bannerKind = '';
  if (pub?.phase === 'gameOver' && result) {
    banner = pub.message;
    bannerKind = 'result';
  } else if (pub?.inCheck) {
    banner = isMyTurn ? 'Du stehst im Schach!' : 'Schach!';
    bannerKind = 'check';
  } else if (isMyTurn) {
    banner = 'Du bist am Zug.';
    bannerKind = 'turn';
  }

  const showDrawActions = pub?.phase === 'playing' && !result;
  const opponentOfferedDraw = drawOffer && drawOffer !== myColor;
  const iWon = result?.winnerColor && result.winnerColor === myColor;

  return (
    <div className="chess-play-layout">
      <div className="chess-board-column">
        <PlayerPlate color={topColor} isSelf={topColor === myColor} {...plateFor(topColor)} />
        <ChessBoard
          fen={pub?.fen}
          myColor={myColor}
          myLegalMoves={myLegalMoves}
          lastMove={pub?.lastMove}
          inCheck={pub?.inCheck}
          turn={pub?.turn}
          disabled={!isMyTurn || pub?.phase !== 'playing'}
          onMove={onAction}
        />
        <PlayerPlate color={bottomColor} isSelf={bottomColor === myColor} {...plateFor(bottomColor)} />
      </div>
      <aside className="chess-side-panel">
        {banner ? (
          <div className={`chess-banner chess-banner--${bannerKind}${iWon ? ' chess-banner--victory' : ''}`}>
            {bannerKind === 'result' && iWon ? <Crown size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} /> : null}
            {banner}
          </div>
        ) : null}
        <MoveList moveHistory={pub?.moveHistory || []} />
        {pub?.message && bannerKind !== 'result' ? <p className="chess-status-msg">{pub.message}</p> : null}
        {showDrawActions ? (
          <div className="chess-action-row">
            {opponentOfferedDraw ? (
              <>
                <button type="button" className="chess-btn-primary" onClick={() => onAction({ type: 'acceptDraw' })}>
                  <HeartHandshake size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
                  Remis annehmen
                </button>
                <button type="button" className="chess-btn-ghost" onClick={() => onAction({ type: 'declineDraw' })}>Ablehnen</button>
              </>
            ) : (
              <>
                <button type="button" className="chess-btn-ghost" disabled={Boolean(drawOffer)} onClick={() => onAction({ type: 'offerDraw' })}>
                  <HeartHandshake size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
                  {drawOffer === myColor ? 'Remis angeboten…' : 'Remis anbieten'}
                </button>
                <button type="button" className="chess-btn-ghost chess-btn-danger" onClick={() => onAction({ type: 'resign' })}>
                  <Flag size={15} style={{ verticalAlign: 'text-bottom', marginRight: 5 }} />
                  Aufgeben
                </button>
              </>
            )}
          </div>
        ) : null}
        {pub?.phase === 'gameOver' ? (
          <button type="button" className="chess-btn-ghost" onClick={onLeave}>Schließen</button>
        ) : null}
      </aside>
    </div>
  );
}

function ChessGuide() {
  return (
    <div className="chess-guide">
      <p>2-Spieler-Schach über P2P. Der Host spielt Weiß, der Gast Schwarz.</p>
      <ul>
        <li>Klicke eine Figur, dann ein hervorgehobenes Feld zum Ziehen.</li>
        <li>Rochade, En passant und Bauernumwandlung sind unterstützt.</li>
        <li>Die Notation rechts zeigt alle Züge in Standard-Schreibweise (SAN).</li>
        <li>Remis bei Patt, unzureichendem Material oder 50-Züge-Regel.</li>
      </ul>
    </div>
  );
}

export default function ChessGamePage() {
  const { snapshot, selfId, isHost, send } = useChessState();
  const [panel, setPanel] = useState('');
  const isMaximized = useChessWindowMaximized();
  const pub = snapshot?.public;
  const inLobby = !pub?.phase || pub.phase === 'lobby';

  const closeWindow = useCallback(() => window.bluetalk?.chess?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);
  const action = useCallback((value) => send({ type: 'action', action: value }), [send]);

  if (!snapshot?.public) {
    return (
      <div className="chess-game-root">
        <div className="chess-game-grain" aria-hidden />
        <main className="chess-empty-state">
          <div className="chess-launch-mark">♞</div>
          <h1>Schach wird vorbereitet…</h1>
          <p>Starte oder öffne eine Partie über den Spiele-Bereich im Hauptfenster.</p>
          <button type="button" className="chess-btn-ghost" onClick={() => send({ type: 'request_state' })}>Erneut laden</button>
        </main>
      </div>
    );
  }

  return (
    <div className="chess-game-root">
      <div className="chess-game-grain" aria-hidden />
      <header className="chess-game-titlebar">
        <div className="chess-title">
          <h1>{pub.settings?.tableName || 'Schach'}</h1>
          <div className="chess-game-titlebar-sub">
            {PHASE_LABELS[pub.phase] || pub.phase}{isHost ? ' · Du bist Host (Weiß)' : snapshot.myColor === 'b' ? ' · Schwarz' : ''}
          </div>
        </div>
        <div className="chess-game-titlebar-actions">
          <button type="button" className="chess-game-btn-icon" title="Hilfe" onClick={() => setPanel('help')}><HelpCircle size={16} /></button>
          {isHost ? <button type="button" className="chess-game-btn-icon" title="Spieler" onClick={() => setPanel('players')}><Users size={16} /></button> : null}
          <button type="button" className="chess-game-btn-icon" title="Einstellungen" onClick={() => setPanel('settings')}><Settings size={16} /></button>
          {isHost ? <button type="button" className="chess-game-btn-icon" title="Speichern" onClick={() => send({ type: 'save_game' })}><Save size={16} /></button> : null}
          <button type="button" className="chess-game-btn-icon" title="Verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="chess-game-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.chess?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="chess-game-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.chess?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="chess-game-btn-icon" title="Schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>
      <main className="chess-game-main">
        {inLobby ? (
          <LobbyView
            snapshot={snapshot}
            isHost={isHost}
            onStart={() => send({ type: 'host_start' })}
            onLeave={leave}
            onOpenPlayers={() => setPanel('players')}
          />
        ) : (
          <GameView snapshot={snapshot} onAction={action} onLeave={leave} />
        )}
      </main>
      {panel === 'help' ? (
        <OverlayPanel title="Schach — Hilfe" onClose={() => setPanel('')}>
          <ChessGuide />
        </OverlayPanel>
      ) : null}
      {panel === 'settings' ? (
        <OverlayPanel title="Einstellungen" onClose={() => setPanel('')}>
          <SettingsPanel
            settings={pub.settings}
            isHost={isHost}
            onUpdate={(settings) => { send({ type: 'update_settings', settings }); setPanel(''); }}
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
