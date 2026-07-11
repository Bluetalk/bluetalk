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
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import './UnoGamePage.css';

const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_LABELS = { red: 'Rot', yellow: 'Gelb', green: 'Grün', blue: 'Blau' };
const VALUE_LABELS = {
  skip: 'Skip',
  reverse: 'Reverse',
  draw2: '+2',
  wild: 'Wild',
  wild4: '+4',
};

const PHASE_LABELS = {
  lobby: 'Lobby',
  playing: 'Spiel läuft',
  roundOver: 'Runde beendet',
  matchOver: 'Match beendet',
};

const CARD_GLYPHS = {
  skip: '⊘',
  reverse: '⇄',
  draw2: '+2',
  wild: '✦',
  wild4: '+4',
};

function cardDisplayLabel(card) {
  if (!card) return '';
  if (card.value === 'wild' || card.value === 'wild4') return VALUE_LABELS[card.value];
  return VALUE_LABELS[card.value] || String(card.value);
}

function cardGlyph(card) {
  if (!card) return '';
  return CARD_GLYPHS[card.value] || String(card.value);
}

function useUnoState() {
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
    if (!window.bluetalk?.uno?.onState) return undefined;
    const off = window.bluetalk.uno.onState((payload) => setSnapshot(payload || null));
    window.bluetalk.uno.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.uno?.sendAction?.({ type: 'request_state' });
    }, 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.uno?.sendAction?.(payload);
  }, []);

  return {
    snapshot,
    selfId,
    isHost: Boolean(selfId && snapshot?.public?.hostPeerId === selfId),
    send,
  };
}

function useUnoWindowMaximized() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = window.bluetalk?.uno;
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

function UnoCard3D({
  card,
  hidden = false,
  animate = '',
  playable = false,
  dimmed = false,
  compact = false,
  onClick,
  style,
}) {
  const color = card?.color || 'wild';
  const label = cardDisplayLabel(card);
  const glyph = cardGlyph(card);
  const isWild = color === 'wild';
  return (
    <button
      type="button"
      className={`uno-card-3d uno-card-${isWild ? 'wild' : color}${hidden ? ' uno-card-back' : ''}${animate ? ` ${animate}` : ''}${playable ? ' uno-card-playable' : ''}${dimmed ? ' uno-card-dimmed' : ''}${compact ? ' uno-card-compact' : ''}`}
      style={style}
      onClick={onClick}
      disabled={!onClick}
      aria-label={hidden ? 'Verdeckte Karte' : `${COLOR_LABELS[color] || 'Wild'} ${label}`}
    >
      {hidden ? (
        <span className="uno-card-face">
          <span className="uno-card-ellipse">
            <span className="uno-card-glyph uno-card-logo">BT</span>
          </span>
        </span>
      ) : (
        <span className="uno-card-face">
          <span className="uno-card-corner uno-card-tl">{glyph}</span>
          <span className="uno-card-ellipse">
            <span className="uno-card-glyph">{glyph}</span>
          </span>
          <span className="uno-card-corner uno-card-br">{glyph}</span>
        </span>
      )}
    </button>
  );
}

function PlayerAvatar({ player, isActive, isHost, self = false }) {
  const initials = player?.name?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
  const oneCardLeft = player?.cardCount === 1;
  return (
    <div className={`uno-player-avatar${isActive ? ' active' : ''}${player?.connected === false ? ' disconnected' : ''}${self ? ' self' : ''}`}>
      <div className="uno-avatar-circle">
        <span>{initials}</span>
        {isHost ? <Crown size={11} className="uno-host-icon" aria-label="Host" /> : null}
        {player?.cardCount > 0 ? <span className="uno-card-count">{player.cardCount}</span> : null}
      </div>
      <div className="uno-avatar-info">
        <div className="uno-avatar-name">{player?.name || 'Spieler'}{self ? ' (du)' : ''}</div>
        {player?.score > 0 ? <div className="uno-avatar-score">{player.score} Pkt.</div> : null}
      </div>
      {oneCardLeft || player?.saidUno ? (
        <span className={`uno-said-badge${oneCardLeft ? ' uno-one-left' : ''}`}>UNO!</span>
      ) : null}
    </div>
  );
}

function ColorPicker({ onChoose, onCancel }) {
  return (
    <div className="uno-color-picker" role="dialog" aria-label="Farbe wählen">
      <p className="uno-color-picker-title">Wähle eine Farbe</p>
      <div className="uno-color-options">
        {COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`uno-color-tile uno-color-tile-${color}`}
            onClick={() => onChoose(color)}
          >
            <span className="uno-color-tile-glow" aria-hidden />
            <span className="uno-color-tile-label">{COLOR_LABELS[color]}</span>
          </button>
        ))}
      </div>
      {onCancel ? (
        <button type="button" className="uno-btn-ghost" onClick={onCancel}>Abbrechen</button>
      ) : null}
    </div>
  );
}

function LobbyView({ snapshot, selfId, isHost, onStart, onLeave }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const maxPlayers = pub?.settings?.maxPlayers || 4;
  return (
    <div className="uno-lobby">
      <div className="uno-lobby-header">
        <h2>{pub?.settings?.tableName || 'UNO-Tisch'}</h2>
        <div className="uno-lobby-meta">
          <span><Users size={14} /> {players.length}/{maxPlayers}</span>
          <span>{pub?.settings?.gameMode === 'points' ? `Punkte bis ${pub?.settings?.targetScore || 500}` : 'Einzelrunde'}</span>
        </div>
      </div>
      <div className="uno-lobby-seats">
        {Array.from({ length: maxPlayers }, (_, seat) => {
          const player = players.find((item) => item.seat === seat);
          return (
            <div key={seat} className={`uno-lobby-seat ${player ? 'occupied' : 'empty'}`}>
              {player ? (
                <PlayerAvatar player={player} isHost={player.peerId === pub.hostPeerId} self={player.peerId === selfId} />
              ) : (
                <span className="uno-lobby-empty">Platz {seat + 1}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="uno-lobby-actions">
        {isHost ? (
          <button type="button" className="uno-btn-primary" onClick={onStart} disabled={players.length < 2}>
            <Play size={16} /> Spiel starten
          </button>
        ) : (
          <p className="uno-panel-note">Warte, bis der Host das Spiel startet.</p>
        )}
        <button type="button" className="uno-btn-ghost" onClick={onLeave}><LogOut size={16} /> Verlassen</button>
      </div>
    </div>
  );
}

function UnoHand({ cards, topCard, activeColor, houseRules, canAct, pendingDrawStack, pendingDrawType, onPlay, animatingId }) {
  if (!cards.length) return <div className="uno-hand-empty">Keine Karten</div>;
  // Fächere die Hand über einen begrenzten Gesamtwinkel auf (nicht pro Karte),
  // damit große Hände nicht zu einem 180°-Bogen mit fast liegenden Karten werden.
  const maxArc = 48;
  const spread = Math.min(9, maxArc / Math.max(cards.length - 1, 1));
  const offset = ((cards.length - 1) * spread) / 2;

  return (
    <div className="uno-hand" style={{ '--uno-hand-count': cards.length }}>
      {cards.map((card, index) => {
        const rotate = -offset + index * spread;
        const lift = Math.abs(rotate) * 0.9;
        const playable = canAct && (
          pendingDrawStack > 0
            ? (houseRules === 'casual' && (card.value === 'draw2' || card.value === 'wild4'))
            : canPlayCard(card, topCard, activeColor, houseRules, cards)
        );
        let animate = '';
        if (animatingId === card.id) animate = 'uno-card-fly-discard';
        return (
          <UnoCard3D
            key={card.id}
            card={card}
            playable={playable}
            dimmed={canAct && !playable}
            animate={animate}
            onClick={playable ? () => onPlay(card) : undefined}
            style={{
              '--uno-hand-rotate': `${rotate}deg`,
              '--uno-hand-lift': `${lift}px`,
              zIndex: index + 1,
            }}
          />
        );
      })}
    </div>
  );
}

function canPlayCard(card, topCard, activeColor, houseRules, hand) {
  if (!card || !topCard) return false;
  if (card.color === 'wild') {
    if (card.value === 'wild4' && houseRules === 'official') {
      const eff = topCard.color === 'wild' ? activeColor : topCard.color;
      return !hand.some((c) => c.color === eff);
    }
    return true;
  }
  const eff = topCard.color === 'wild' ? activeColor : topCard.color;
  if (card.color === eff) return true;
  return card.value === topCard.value;
}

function GameTable({ snapshot, selfId, onAction }) {
  const pub = snapshot?.public;
  const hand = snapshot?.myHand || [];
  const players = pub?.players || [];
  const selfPlayer = players.find((p) => p.peerId === selfId);
  const canAct = pub?.toAct === selfId && pub?.phase === 'playing';
  const needsColor = pub?.pendingColorChoice === selfId;
  const lastEventRef = useRef(null);
  const [animatingId, setAnimatingId] = useState('');
  const [drawAnim, setDrawAnim] = useState(false);

  useEffect(() => {
    const ev = pub?.lastEvent;
    if (!ev || ev.at === lastEventRef.current) return;
    lastEventRef.current = ev.at;
    if (ev.type === 'play' && ev.peerId === selfId && ev.card?.id) {
      setAnimatingId(ev.card.id);
      const t = setTimeout(() => setAnimatingId(''), 600);
      return () => clearTimeout(t);
    }
    if (ev.type === 'draw' && ev.peerId === selfId) {
      setDrawAnim(true);
      const t = setTimeout(() => setDrawAnim(false), 600);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [pub?.lastEvent, selfId]);

  const positionedPlayers = useMemo(() => {
    if (!players.length) return [];
    const maxSeats = pub?.settings?.maxPlayers || 4;
    const ownSeat = selfPlayer?.seat ?? 0;
    return players
      .filter((p) => p.peerId !== selfId)
      .map((player) => {
        const relative = (player.seat - ownSeat + maxSeats) % maxSeats;
        const position = relative <= Math.ceil(maxSeats / 3)
          ? 'top'
          : relative <= Math.ceil((2 * maxSeats) / 3)
            ? 'left'
            : 'right';
        return { ...player, position, relative };
      })
      .sort((a, b) => a.relative - b.relative);
  }, [players, pub?.settings?.maxPlayers, selfId, selfPlayer?.seat]);

  const top = positionedPlayers.filter((p) => p.position === 'top');
  const left = positionedPlayers.filter((p) => p.position === 'left');
  const right = positionedPlayers.filter((p) => p.position === 'right');

  const handlePlay = (card) => {
    if (card.color === 'wild') {
      onAction({ type: 'play', cardId: card.id });
    } else {
      onAction({ type: 'play', cardId: card.id });
    }
  };

  return (
    <div className="uno-table-container">
      <div className="uno-player-top">{top.map((p) => (
        <PlayerAvatar key={p.peerId} player={p} isActive={pub?.toAct === p.peerId} isHost={p.peerId === pub?.hostPeerId} />
      ))}</div>
      <div className="uno-table-middle">
        <div className="uno-players-left">{left.map((p) => (
          <PlayerAvatar key={p.peerId} player={p} isActive={pub?.toAct === p.peerId} isHost={p.peerId === pub?.hostPeerId} />
        ))}</div>
        <div className="uno-table-center">
          {pub?.phase === 'playing' && pub?.toAct ? (
            <div className={`uno-turn-chip${canAct ? ' self' : ''}`}>
              <span className="uno-turn-dot" aria-hidden />
              {canAct ? 'Du bist am Zug' : `${players.find((p) => p.peerId === pub.toAct)?.name || 'Spieler'} ist am Zug`}
            </div>
          ) : null}
          <div className="uno-piles">
            <div className={`uno-draw-pile${drawAnim ? ' uno-draw-pulse' : ''}`}>
              <div className="uno-draw-stack">
                <UnoCard3D hidden />
              </div>
              <span className="uno-pile-label">Nachziehen</span>
              <span className="uno-pile-count">{pub?.drawPileCount ?? 0} Karten</span>
            </div>
            <div className="uno-discard-pile">
              <div className="uno-discard-stack">
                <span className="uno-discard-under uno-discard-under-1" aria-hidden />
                <span className="uno-discard-under uno-discard-under-2" aria-hidden />
                {pub?.topCard ? (
                  <UnoCard3D card={pub.topCard} animate={pub?.lastEvent?.type === 'play' ? 'uno-discard-flip' : ''} />
                ) : (
                  <UnoCard3D hidden />
                )}
              </div>
              <span className="uno-pile-label">Ablage</span>
              {pub?.activeColor ? (
                <span className={`uno-active-color uno-color-${pub.activeColor}`}>{COLOR_LABELS[pub.activeColor]}</span>
              ) : null}
            </div>
          </div>
          {pub?.pendingDrawStack > 0 ? (
            <div className="uno-pending-draw">+{pub.pendingDrawStack} ausstehend</div>
          ) : null}
          {pub?.direction ? (
            <div className="uno-direction">
              <span className={`uno-direction-icon${pub.direction === -1 ? ' reversed' : ''}`} aria-hidden>
                {pub.direction === 1 ? '↻' : '↺'}
              </span>
              <span>{pub.direction === 1 ? 'Im Uhrzeigersinn' : 'Gegen den Uhrzeigersinn'}</span>
            </div>
          ) : null}
        </div>
        <div className="uno-players-right">{right.map((p) => (
          <PlayerAvatar key={p.peerId} player={p} isActive={pub?.toAct === p.peerId} isHost={p.peerId === pub?.hostPeerId} />
        ))}</div>
      </div>
      <div className="uno-player-self">
        <PlayerAvatar player={selfPlayer || { name: 'Du', cardCount: hand.length }} isActive={canAct} isHost={selfId === pub?.hostPeerId} self />
        {needsColor ? (
          <ColorPicker onChoose={(color) => onAction({ type: 'chooseColor', color })} />
        ) : null}
        <UnoHand
          cards={hand}
          topCard={pub?.topCard}
          activeColor={pub?.activeColor}
          houseRules={pub?.settings?.houseRules}
          canAct={canAct && !needsColor}
          pendingDrawStack={pub?.pendingDrawStack || 0}
          pendingDrawType={pub?.pendingDrawType}
          onPlay={handlePlay}
          animatingId={animatingId}
        />
        {hand.length === 1 && !selfPlayer?.saidUno ? (
          <div className="uno-action-bar uno-uno-call-bar">
            <div className="uno-action-info">
              <strong>Nur noch eine Karte — ruf UNO, bevor der nächste Spieler zieht!</strong>
            </div>
            <div className="uno-actions">
              <button type="button" className="uno-act-uno" onClick={() => onAction({ type: 'callUno' })}>UNO! rufen</button>
            </div>
          </div>
        ) : null}
        {canAct && !needsColor ? (
          <div className="uno-action-bar">
            <div className="uno-action-info">
              <strong>Du bist am Zug</strong>
              {pub?.drewCanPass === selfId ? <span>Gespielte Karte legen oder passen.</span> : null}
            </div>
            <div className="uno-actions">
              {pub?.drewCanPass === selfId ? (
                <button type="button" className="uno-act-pass" onClick={() => onAction({ type: 'pass' })}>Passen</button>
              ) : (
                <button type="button" className="uno-act-draw" onClick={() => onAction({ type: 'draw' })}>Karte ziehen</button>
              )}
            </div>
          </div>
        ) : null}
      </div>
      <div className="uno-game-info">
        <span className="uno-phase">{PHASE_LABELS[pub?.phase] || pub?.phase}</span>
        <span>Runde #{pub?.roundNumber || 0}</span>
        {pub?.message ? <span className="uno-message">{pub.message}</span> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ settings, isHost, onUpdate }) {
  const [local, setLocal] = useState({ ...settings });
  useEffect(() => setLocal({ ...settings }), [settings]);
  if (!isHost) {
    return (
      <div className="uno-settings-readonly">
        <p><strong>Tisch:</strong> {settings?.tableName}</p>
        <p><strong>Spieler:</strong> max. {settings?.maxPlayers}</p>
        <p><strong>Modus:</strong> {settings?.gameMode === 'points' ? `Punkte (${settings?.targetScore})` : 'Einzelrunde'}</p>
        <p><strong>Hausregeln:</strong> {settings?.houseRules === 'casual' ? 'Casual' : 'Offiziell'}</p>
        <p><strong>Lobby:</strong> {settings?.lobbyAccess === 'public' ? 'Öffentlich' : 'Nur auf Einladung'}</p>
      </div>
    );
  }
  return (
    <form className="uno-settings-form" onSubmit={(e) => { e.preventDefault(); onUpdate(local); }}>
      <label>Tischname<input value={local.tableName || ''} onChange={(e) => setLocal({ ...local, tableName: e.target.value })} /></label>
      <label>Max. Spieler<input type="number" min={2} max={8} value={local.maxPlayers || 4} onChange={(e) => setLocal({ ...local, maxPlayers: Number(e.target.value) })} /></label>
      <label>Spielmodus
        <select value={local.gameMode || 'single'} onChange={(e) => setLocal({ ...local, gameMode: e.target.value })}>
          <option value="single">Einzelrunde</option>
          <option value="points">Punkte</option>
        </select>
      </label>
      {local.gameMode === 'points' ? (
        <label>Zielpunkte<input type="number" min={100} max={10000} value={local.targetScore || 500} onChange={(e) => setLocal({ ...local, targetScore: Number(e.target.value) })} /></label>
      ) : null}
      <label>Hausregeln
        <select value={local.houseRules || 'official'} onChange={(e) => setLocal({ ...local, houseRules: e.target.value })}>
          <option value="official">Offiziell (Mattel)</option>
          <option value="casual">Casual (+2/+4 stapelbar)</option>
        </select>
      </label>
      <label>Lobby-Zugang
        <select value={local.lobbyAccess || 'invite'} onChange={(e) => setLocal({ ...local, lobbyAccess: e.target.value })}>
          <option value="invite">Nur auf Einladung</option>
          <option value="public">Öffentlich (Presence-Beitritt)</option>
        </select>
      </label>
      <label>Zugzeit (Sek., 0=∞)<input type="number" min={0} max={300} value={local.turnTimeSec ?? 0} onChange={(e) => setLocal({ ...local, turnTimeSec: Number(e.target.value) })} /></label>
      <button type="submit" className="uno-btn-primary">Speichern</button>
    </form>
  );
}

function PlayerManagement({ snapshot, isHost, selfId, onInvite, onKickPlayer }) {
  const players = snapshot?.public?.players || [];
  const candidates = snapshot?.inviteCandidates || [];
  const kickable = isHost ? players.filter((p) => p.peerId !== selfId) : [];

  return (
    <div className="uno-player-management">
      {kickable.length ? (
        <section>
          <h3 className="uno-panel-subheading">Am Tisch</h3>
          <ul className="uno-invite-list">
            {kickable.map((player) => (
              <li key={player.peerId}>
                <span>{player.name}</span>
                <button type="button" className="uno-btn-ghost uno-btn-kick" onClick={() => onKickPlayer(player.peerId)} title={`${player.name} entfernen`}>
                  <UserX size={14} /> Entfernen
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3 className="uno-panel-subheading">Einladen</h3>
        {candidates.length ? (
          <ul className="uno-invite-list">
            {candidates.map((c) => (
              <li key={c.peerId}>
                <span>{c.name}</span>
                <button type="button" className="uno-btn-ghost" onClick={() => onInvite(c.peerId)}>Einladen</button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="uno-panel-note">Keine verbundenen Kontakte zum Einladen.</p>
        )}
      </section>
    </div>
  );
}

function UnoGuide() {
  return (
    <div className="uno-guide">
      <p>Lege eine Karte passend zu Farbe oder Zahl. Wild-Karten passen immer.</p>
      <ul>
        <li><strong>Skip:</strong> Nächster Spieler aussetzen</li>
        <li><strong>Reverse:</strong> Spielrichtung drehen (2 Spieler = Skip)</li>
        <li><strong>+2:</strong> Nächster zieht 2 Karten</li>
        <li><strong>Wild / +4:</strong> Farbe wählen (+4: nächster zieht 4)</li>
      </ul>
      <p>Bei einer Karte „UNO!“ rufen — sonst Strafkarten.</p>
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
    <div className="uno-panel-overlay" role="presentation" onMouseDown={onClose}>
      <section className="uno-side-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="uno-game-btn-icon" aria-label="Schließen" onClick={onClose}><X size={16} /></button></header>
        <div className="uno-side-panel-content">{children}</div>
      </section>
    </div>
  );
}

export default function UnoGamePage() {
  const { snapshot, selfId, isHost, send } = useUnoState();
  const [panel, setPanel] = useState('');
  const isMaximized = useUnoWindowMaximized();
  const pub = snapshot?.public;
  const inLobby = !pub?.phase || pub.phase === 'lobby';
  const canNextRound = isHost && (pub?.phase === 'roundOver' || pub?.phase === 'matchOver') && pub?.phase !== 'matchOver';

  const closeWindow = useCallback(() => window.bluetalk?.uno?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);
  const action = useCallback((value) => send({ type: 'action', action: value }), [send]);

  if (!snapshot?.public) {
    return (
      <div className="uno-game-root">
        <main className="uno-empty-state">
          <div className="uno-launch-mark">🎴</div>
          <h1>UNO wird vorbereitet…</h1>
          <p>Starte oder öffne ein Spiel über den UNO-Bereich im Hauptfenster.</p>
          <button type="button" className="uno-btn-ghost" onClick={() => send({ type: 'request_state' })}>Erneut laden</button>
        </main>
      </div>
    );
  }

  return (
    <div className="uno-game-root">
      <div className="uno-game-grain" aria-hidden />
      <header className="uno-game-titlebar">
        <div className="uno-title">
          <h1>
            {pub.settings?.tableName || 'UNO'}
          </h1>
          <div className="uno-game-titlebar-sub">
            {PHASE_LABELS[pub.phase] || pub.phase}{isHost ? ' · Du bist Host' : ''}
          </div>
        </div>
        <div className="uno-game-titlebar-actions">
          <button type="button" className="uno-game-btn-icon" title="Hilfe" onClick={() => setPanel('help')}><HelpCircle size={16} /></button>
          {isHost ? <button type="button" className="uno-game-btn-icon" title="Spieler" onClick={() => setPanel('players')}><Users size={16} /></button> : null}
          <button type="button" className="uno-game-btn-icon" title="Einstellungen" onClick={() => setPanel('settings')}><Settings size={16} /></button>
          {isHost ? <button type="button" className="uno-game-btn-icon" title="Speichern" onClick={() => send({ type: 'save_game' })}><Save size={16} /></button> : null}
          <button type="button" className="uno-game-btn-icon" title="Verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="uno-game-btn-icon" title="Minimieren" onClick={() => window.bluetalk?.uno?.minimizeWindow?.()}><Minus size={16} /></button>
          <button type="button" className="uno-game-btn-icon" title={isMaximized ? 'Wiederherstellen' : 'Maximieren'} onClick={() => window.bluetalk?.uno?.maximizeWindow?.()}>
            {isMaximized ? <SquareStack size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" className="uno-game-btn-icon" title="Schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>
      <main className="uno-game-main">
        {inLobby ? (
          <LobbyView snapshot={snapshot} selfId={selfId} isHost={isHost} onStart={() => send({ type: 'host_start' })} onLeave={leave} />
        ) : (
          <GameTable snapshot={snapshot} selfId={selfId} onAction={action} />
        )}
        {(pub.phase === 'roundOver' || pub.phase === 'matchOver') && pub?.roundWinner ? (
          <div className="uno-winner-banner">
            <div className="uno-confetti" aria-hidden>
              {Array.from({ length: 14 }, (_, i) => (
                <span key={i} className="uno-confetti-piece" style={{ '--uno-confetti-i': i }} />
              ))}
            </div>
            <span className="uno-winner-kicker">{pub.phase === 'matchOver' ? 'Match beendet' : 'Runde beendet'}</span>
            <strong className="uno-winner-title">
              {pub.roundWinner === selfId
                ? (pub.phase === 'matchOver' ? 'Du hast das Match gewonnen!' : 'Du hast die Runde gewonnen!')
                : `${(pub.players || []).find((p) => p.peerId === pub.roundWinner)?.name || 'Ein Spieler'} gewinnt ${pub.phase === 'matchOver' ? 'das Match' : 'die Runde'}`}
            </strong>
          </div>
        ) : null}
        {canNextRound ? (
          <button type="button" className="uno-next-round uno-btn-primary" onClick={() => send({ type: 'host_start' })}>
            <Play size={16} /> Nächste Runde
          </button>
        ) : null}
      </main>
      {panel === 'help' ? <OverlayPanel title="UNO — Kurz erklärt" onClose={() => setPanel('')}><UnoGuide /></OverlayPanel> : null}
      {panel === 'settings' ? <OverlayPanel title="Einstellungen" onClose={() => setPanel('')}><SettingsPanel settings={pub.settings} isHost={isHost} onUpdate={(s) => send({ type: 'update_settings', settings: s })} /></OverlayPanel> : null}
      {panel === 'players' ? <OverlayPanel title="Spieler verwalten" onClose={() => setPanel('')}><PlayerManagement snapshot={snapshot} isHost={isHost} selfId={selfId} onInvite={(peerId) => send({ type: 'invite', peerId })} onKickPlayer={(peerId) => send({ type: 'kick_player', peerId })} /></OverlayPanel> : null}
    </div>
  );
}
