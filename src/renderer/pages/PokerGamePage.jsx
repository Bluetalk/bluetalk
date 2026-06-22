import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Coins,
  Crown,
  HelpCircle,
  LogOut,
  Minus,
  Play,
  Save,
  Settings,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import './PokerGamePage.css';

const RN = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SN = ['♣', '♦', '♥', '♠'];
const RED_SUITS = new Set(['♦', '♥']);

const PHASE_LABELS = {
  lobby: 'Lobby',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
  between: 'Hand beendet',
  idle: 'Warten',
};

const HAND_LABELS = {
  'Straight Flush': 'Straight Flush',
  Vierling: 'Vierling',
  'Full House': 'Full House',
  Flush: 'Flush',
  Straight: 'Straße',
  Drilling: 'Drilling',
  'Zwei Paare': 'Zwei Paare',
  Paar: 'Paar',
  'High Card': 'Höchste Karte',
  'Gewinn (alle anderen gefoldet)': 'Alle anderen haben gefoldet',
};

function cardLabelFromRaw(card) {
  if (typeof card !== 'number') return String(card || '');
  return `${RN[card % 13]}${SN[(card / 13) | 0]}`;
}

function formatChips(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('de-DE');
}

function usePokerState() {
  const [snapshot, setSnapshot] = useState(null);
  const [selfId, setSelfId] = useState('');
  const [soundEnabled, setSoundEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void window.bluetalk?.peer?.getInfo?.().then((info) => {
      if (!cancelled && info?.id) setSelfId(info.id);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.poker?.onState) return undefined;
    const off = window.bluetalk.poker.onState((payload) => setSnapshot(payload || null));
    window.bluetalk.poker.sendAction?.({ type: 'request_state' });
    const retry = setTimeout(() => {
      window.bluetalk?.poker?.sendAction?.({ type: 'request_state' });
    }, 250);
    return () => {
      clearTimeout(retry);
      off?.();
    };
  }, []);

  const send = useCallback((payload) => {
    window.bluetalk?.poker?.sendAction?.(payload);
  }, []);

  return {
    snapshot,
    selfId,
    isHost: Boolean(selfId && snapshot?.public?.hostPeerId === selfId),
    send,
    soundEnabled,
    setSoundEnabled,
  };
}

function Card3D({ label, hidden = false, animate = false, compact = false }) {
  const normalized = String(label || '');
  const suit = hidden ? '' : normalized.slice(-1);
  const rank = hidden ? '' : normalized.slice(0, -1);
  const red = RED_SUITS.has(suit);
  return (
    <div
      className={`poker-card-3d${animate ? ' poker-card-deal' : ''}${hidden ? ' poker-card-back' : ''}${compact ? ' poker-card-compact' : ''}${red ? ' poker-card-red' : ''}`}
      role="img"
      aria-label={hidden ? 'Verdeckte Karte' : `${rank} ${suit}`}
    >
      {hidden ? (
        <div className="poker-card-pattern"><span>BT</span></div>
      ) : (
        <>
          <div className="poker-card-corner poker-card-tl"><strong>{rank}</strong><span>{suit}</span></div>
          <div className="poker-card-center">{suit}</div>
          <div className="poker-card-corner poker-card-br"><strong>{rank}</strong><span>{suit}</span></div>
        </>
      )}
    </div>
  );
}

function PokerChip({ value, small = false }) {
  const amount = Math.max(0, Number(value) || 0);
  const color = amount >= 1000 ? '#f97316' : amount >= 500 ? '#a855f7' : amount >= 100 ? '#111827' : amount >= 50 ? '#eab308' : amount >= 25 ? '#22c55e' : amount >= 10 ? '#3b82f6' : '#ef4444';
  return (
    <div className={`poker-chip${small ? ' poker-chip-small' : ''}`} style={{ '--chip-color': color }} aria-hidden>
      <div className="poker-chip-inner"><span>{amount >= 1000 ? `${Math.round(amount / 100) / 10}k` : amount}</span></div>
    </div>
  );
}

function PlayerAvatar({ player, isDealer, isActive, isHost, self = false, revealedCards = [] }) {
  const initials = player?.name?.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase() || '?';
  return (
    <div className={`poker-player-avatar${isActive ? ' active' : ''}${player?.folded ? ' folded' : ''}${player?.allIn ? ' allin' : ''}${player?.connected === false ? ' disconnected' : ''}${self ? ' self' : ''}`}>
      <div className="poker-avatar-circle">
        <span>{initials}</span>
        {isDealer ? <span className="poker-dealer-badge">D</span> : null}
        {isHost ? <Crown size={11} className="poker-host-icon" aria-label="Host" /> : null}
        {player?.isBot ? <Bot size={11} className="poker-bot-icon" aria-label="Bot" /> : null}
      </div>
      <div className="poker-avatar-name">{player?.name || 'Spieler'}{self ? ' (du)' : ''}</div>
      <div className="poker-avatar-chips">{formatChips(player?.chips)} Chips</div>
      {player?.connected === false ? <span className="poker-player-status">offline</span> : null}
      {revealedCards.length ? (
        <div className="poker-revealed-cards">
          {revealedCards.map((card) => <Card3D key={card} label={card} compact />)}
        </div>
      ) : null}
      {player?.currentRoundBet > 0 ? (
        <div className="poker-avatar-bet"><PokerChip value={player.currentRoundBet} small /></div>
      ) : null}
    </div>
  );
}

function SettingsPanel({ settings, isHost, onUpdate }) {
  const [draft, setDraft] = useState(settings || {});

  const set = (key, value) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = (event) => {
    event.preventDefault();
    if (isHost) onUpdate(draft);
  };

  return (
    <form className="poker-settings-panel" onSubmit={submit}>
      <div className="poker-panel-heading">
        <div><h3>Tischeinstellungen</h3><p>Änderungen gelten ohne Neustart, Blind-Änderungen ab der nächsten Hand.</p></div>
      </div>
      <div className="poker-settings-grid">
        <label>Tischname<input value={draft.tableName || ''} onChange={(event) => set('tableName', event.target.value)} disabled={!isHost} /></label>
        <label>Small Blind<input type="number" min="1" value={draft.smallBlind ?? 10} onChange={(event) => set('smallBlind', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Big Blind<input type="number" min="1" value={draft.bigBlind ?? 20} onChange={(event) => set('bigBlind', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Ante<input type="number" min="0" value={draft.ante ?? 0} onChange={(event) => set('ante', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Start-Chips<input type="number" min="1" value={draft.startingChips ?? 2000} onChange={(event) => set('startingChips', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Max. Spieler<input type="number" min="2" max="9" value={draft.maxPlayers ?? 6} onChange={(event) => set('maxPlayers', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Zugzeit in Sekunden<input type="number" min="0" max="300" value={draft.turnTimeSec ?? 0} onChange={(event) => set('turnTimeSec', Number(event.target.value))} disabled={!isHost} /></label>
        <label>Min. Raise in BB<input type="number" min="1" max="10" value={draft.minRaiseBB ?? 1} onChange={(event) => set('minRaiseBB', Number(event.target.value))} disabled={!isHost} /></label>
        <label className="poker-settings-checkbox"><input type="checkbox" checked={draft.autoStart === true} onChange={(event) => set('autoStart', event.target.checked)} disabled={!isHost} />Nächste Hand automatisch starten</label>
      </div>
      {isHost ? <button type="submit" className="poker-btn-primary">Einstellungen übernehmen</button> : <p className="poker-panel-note">Nur der Host kann diese Werte ändern.</p>}
    </form>
  );
}

function PlayerManagement({ snapshot, isHost, onInvite, onGrantChips, onAddBot, onRemoveBot }) {
  const players = snapshot?.public?.players || [];
  const inviteCandidates = snapshot?.inviteCandidates || [];
  const [amounts, setAmounts] = useState({});
  const hasBot = players.some((player) => player.isBot);

  return (
    <div className="poker-management">
      <section>
        <div className="poker-panel-heading"><div><h3>Spieler einladen</h3><p>Die Einladung wird als Chatnachricht versendet.</p></div></div>
        <div className="poker-invite-list">
          {inviteCandidates.length ? inviteCandidates.map((candidate) => (
            <div key={candidate.peerId} className="poker-manage-row">
              <span>{candidate.name}</span>
              <button type="button" className="poker-btn-ghost" onClick={() => onInvite(candidate.peerId)}><UserPlus size={14} /> Einladen</button>
            </div>
          )) : <p className="poker-panel-note">Keine weiteren verbundenen Kontakte verfügbar.</p>}
        </div>
      </section>
      <section>
        <div className="poker-panel-heading"><div><h3>Chips & Spielstände</h3><p>Als Host kannst du Chips hinzufügen. Der Stand wird zwischen Händen automatisch gespeichert.</p></div></div>
        <div className="poker-manage-list">
          {players.map((player) => (
            <div key={player.peerId} className="poker-manage-row poker-manage-player">
              <div><strong>{player.name}</strong><span>{formatChips(player.chips)} Chips{player.pendingChips > 0 ? ` · +${formatChips(player.pendingChips)} nächste Hand` : ''} · {player.stats?.handsWon || 0}/{player.stats?.handsPlayed || 0} Hände gewonnen</span></div>
              {isHost ? (
                <div className="poker-chip-grant">
                  <input
                    type="number"
                    min="1"
                    aria-label={`Chips für ${player.name}`}
                    value={amounts[player.peerId] ?? 500}
                    onChange={(event) => setAmounts((current) => ({ ...current, [player.peerId]: Number(event.target.value) }))}
                  />
                  <button type="button" className="poker-btn-ghost" onClick={() => onGrantChips(player.peerId, amounts[player.peerId] ?? 500)}><Coins size={14} /> Geben</button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>
      {isHost ? (
        <section className="poker-bot-controls">
          <button type="button" className="poker-btn-ghost" onClick={hasBot ? onRemoveBot : onAddBot}><Bot size={14} /> {hasBot ? 'Bot entfernen' : 'Bot hinzufügen'}</button>
        </section>
      ) : null}
    </div>
  );
}

function PokerGuide() {
  return (
    <div className="poker-guide">
      <section><h3>So läuft Texas Hold&apos;em</h3><ol><li>Jeder erhält zwei verdeckte Karten.</li><li>Nach jeder Setzrunde erscheinen Flop (3), Turn (1) und River (1).</li><li>Aus deinen Karten und den fünf Gemeinschaftskarten zählt die beste Fünf-Karten-Hand.</li></ol></section>
      <section><h3>Deine Aktionen</h3><dl><dt>Check</dt><dd>Weitergeben, wenn nichts zu zahlen ist.</dd><dt>Call</dt><dd>Den aktuellen Einsatz ausgleichen.</dd><dt>Raise</dt><dd>Auf einen selbst gewählten Gesamtbetrag erhöhen.</dd><dt>Fold</dt><dd>Die Hand aufgeben.</dd><dt>All-in</dt><dd>Alle verbleibenden Chips setzen.</dd></dl></section>
      <section><h3>Hand-Rangfolge</h3><p>Straight Flush · Vierling · Full House · Flush · Straße · Drilling · Zwei Paare · Paar · Höchste Karte</p></section>
    </div>
  );
}

function LobbyView({ snapshot, selfId, isHost, onStart, onLeave }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const ready = players.filter((player) => player.chips > 0 && (player.connected !== false || player.isBot));
  const maxPlayers = pub?.settings?.maxPlayers || 6;
  return (
    <div className="poker-lobby">
      <div className="poker-lobby-header"><h2>{pub?.settings?.tableName || 'Poker-Tisch'}</h2><div className="poker-lobby-meta"><span><Users size={14} /> {players.length}/{maxPlayers}</span><span>Blinds {pub?.settings?.smallBlind || 10}/{pub?.settings?.bigBlind || 20}</span></div></div>
      <div className="poker-lobby-table"><div className="poker-lobby-seats">
        {Array.from({ length: maxPlayers }, (_, seat) => {
          const player = players.find((item) => item.seat === seat);
          return <div key={seat} className={`poker-lobby-seat ${player ? 'occupied' : 'empty'}`}>{player ? <PlayerAvatar player={player} isHost={player.peerId === pub.hostPeerId} self={player.peerId === selfId} /> : <span className="poker-lobby-empty">Freier Platz {seat + 1}</span>}</div>;
        })}
      </div></div>
      <div className="poker-lobby-actions">
        {isHost ? <button type="button" className="poker-btn-primary" onClick={onStart} disabled={ready.length < 2}><Play size={16} /> Erste Hand starten</button> : <p className="poker-panel-note">Warte, bis der Host die Hand startet.</p>}
        <button type="button" className="poker-btn-ghost" onClick={onLeave}><LogOut size={16} /> Tisch verlassen</button>
      </div>
      <p className="poker-lobby-hint">Einladungen, Chips und Regeln findest du oben über „Spieler“ und „Einstellungen“.</p>
    </div>
  );
}

function GameTable({ snapshot, selfId, onAction }) {
  const pub = snapshot?.public;
  const players = pub?.players || [];
  const selfPlayer = players.find((player) => player.peerId === selfId);
  const board = pub?.board || [];
  const phase = pub?.phase;
  const isBetween = phase === 'between' || phase === 'showdown';
  const canAct = pub?.toAct === selfId && !isBetween;
  const bounds = pub?.actionBounds || {};
  const toCall = Math.max(0, bounds.toCall ?? (pub?.currentBet || 0) - (selfPlayer?.currentRoundBet || 0));
  const minRaiseTo = Math.max(0, bounds.minRaiseTo || 0);
  const maxRaiseTo = Math.max(minRaiseTo, bounds.maxRaiseTo || 0);
  const [raiseTo, setRaiseTo] = useState(minRaiseTo);

  useEffect(() => setRaiseTo(minRaiseTo), [minRaiseTo, pub?.toAct, phase]);

  const positionedPlayers = useMemo(() => {
    if (!players.length) return [];
    const maxSeats = pub?.settings?.maxPlayers || 6;
    const ownSeat = selfPlayer?.seat || 0;
    return players.filter((player) => player.peerId !== selfId).map((player) => {
      const relative = (player.seat - ownSeat + maxSeats) % maxSeats;
      const position = relative === Math.floor(maxSeats / 2) ? 'top' : relative < Math.ceil(maxSeats / 2) ? 'left' : 'right';
      return { ...player, position, relative };
    }).sort((a, b) => a.relative - b.relative);
  }, [players, pub?.settings?.maxPlayers, selfId, selfPlayer?.seat]);

  const revealed = useMemo(() => new Map((pub?.showdownCards || []).map((row) => [row.peerId, row.cards || []])), [pub?.showdownCards]);
  const renderPlayer = (player) => <PlayerAvatar key={player.peerId} player={player} isDealer={pub?.dealerSeat === player.seat} isActive={pub?.toAct === player.peerId} isHost={player.peerId === pub?.hostPeerId} revealedCards={revealed.get(player.peerId)} />;
  const top = positionedPlayers.filter((player) => player.position === 'top');
  const left = positionedPlayers.filter((player) => player.position === 'left');
  const right = positionedPlayers.filter((player) => player.position === 'right');

  return (
    <div className="poker-table-container">
      <div className="poker-player-top">{top.map(renderPlayer)}</div>
      <div className="poker-table-middle">
        <div className="poker-players-left">{left.map(renderPlayer)}</div>
        <div className="poker-table-center"><div className="poker-felt">
          <div className="poker-pot-area">{pub?.pot > 0 ? <div className="poker-pot"><PokerChip value={pub.pot} /><span className="poker-pot-amount">Pot {formatChips(pub.pot)}</span></div> : null}</div>
          <div className="poker-board">{board.length ? board.map((card) => <Card3D key={card} label={card} animate />) : <div className="poker-board-placeholder">Gemeinschaftskarten</div>}</div>
          {isBetween && pub?.winners?.length ? <div className="poker-winner-banner">{pub.winners.map((winner) => { const player = players.find((item) => item.peerId === winner.peerId); return <div key={winner.peerId} className="poker-winner"><Crown size={16} /><span>{winner.peerId === selfId ? 'Du' : player?.name || 'Spieler'} gewinnst {formatChips(winner.amount)}</span><span className="poker-winner-hand">{HAND_LABELS[winner.hand] || winner.hand}</span></div>; })}</div> : null}
        </div></div>
        <div className="poker-players-right">{right.map(renderPlayer)}</div>
      </div>
      <div className="poker-player-self">
        <PlayerAvatar player={selfPlayer || { name: 'Du', chips: 0 }} isDealer={pub?.dealerSeat === selfPlayer?.seat} isActive={canAct} isHost={selfId === pub?.hostPeerId} self />
        <div className="poker-hole-cards">{snapshot?.myHole?.length ? snapshot.myHole.map((card) => <Card3D key={card} label={cardLabelFromRaw(card)} animate />) : <><Card3D hidden /><Card3D hidden /></>}</div>
        {canAct ? <div className="poker-action-bar">
          <div className="poker-action-info"><strong>Du bist am Zug</strong>{toCall > 0 ? <span className="poker-tocall">Zu zahlen: {formatChips(toCall)}</span> : <span>Du kannst checken.</span>}</div>
          {bounds.canRaise ? <div className="poker-raise-picker"><label htmlFor="poker-raise-value">Erhöhen auf</label><input id="poker-raise-value" type="number" min={minRaiseTo} max={maxRaiseTo} value={raiseTo} onChange={(event) => setRaiseTo(Math.max(minRaiseTo, Math.min(maxRaiseTo, Number(event.target.value) || minRaiseTo)))} /><input type="range" aria-label="Raise-Betrag" min={minRaiseTo} max={maxRaiseTo} step={Math.max(1, pub?.settings?.smallBlind || 1)} value={raiseTo} onChange={(event) => setRaiseTo(Number(event.target.value))} /></div> : null}
          <div className="poker-actions">
            <button type="button" className="poker-act-fold" onClick={() => onAction({ type: 'fold' })}>Fold</button>
            {toCall === 0 ? <button type="button" className="poker-act-check" onClick={() => onAction({ type: 'check' })}>Check</button> : <button type="button" className="poker-act-call" onClick={() => onAction({ type: 'call' })}>Call {formatChips(toCall)}</button>}
            {bounds.canRaise ? <button type="button" className="poker-act-raise" onClick={() => onAction({ type: 'raise', raiseTo })}>Raise auf {formatChips(raiseTo)}</button> : null}
            <button type="button" className="poker-act-allin" onClick={() => onAction({ type: 'all_in' })}>All-in</button>
          </div>
        </div> : null}
      </div>
      <div className="poker-game-info"><span className="poker-phase">{PHASE_LABELS[phase] || phase}</span><span>Hand #{pub?.handNumber || 0}</span><span>Blinds {pub?.settings?.smallBlind}/{pub?.settings?.bigBlind}</span>{pub?.savedAt ? <span>Gespeichert {new Date(pub.savedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span> : null}{pub?.message ? <span className="poker-message">{pub.message}</span> : null}</div>
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
    <div className="poker-panel-overlay" role="presentation" onMouseDown={onClose}>
      <section className="poker-side-panel" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>{title}</h2><button type="button" className="poker-game-btn-icon" aria-label={`${title} schließen`} onClick={onClose}><X size={16} /></button></header>
        <div className="poker-side-panel-content">{children}</div>
      </section>
    </div>
  );
}

export default function PokerGamePage() {
  const { snapshot, selfId, isHost, send, soundEnabled, setSoundEnabled } = usePokerState();
  const [panel, setPanel] = useState('');
  const pub = snapshot?.public;
  const inLobby = !pub?.phase || pub.phase === 'lobby';

  const closeWindow = useCallback(() => window.bluetalk?.poker?.closeGameWindow?.(), []);
  const leave = useCallback(() => { send({ type: 'leave' }); closeWindow(); }, [closeWindow, send]);
  const action = useCallback((value) => send({ type: 'action', action: value }), [send]);

  if (!snapshot?.public) {
    return <div className="poker-game-root"><main className="poker-empty-state"><div className="poker-launch-mark">♠</div><h1>Poker wird vorbereitet…</h1><p>Falls kein Tisch geladen wird, starte oder öffne ihn über den Poker-Bereich im Hauptfenster.</p><button type="button" className="poker-btn-ghost" onClick={() => send({ type: 'request_state' })}>Erneut laden</button></main></div>;
  }

  return (
    <div className="poker-game-root">
      <div className="poker-game-grain" aria-hidden />
      <header className="poker-game-titlebar">
        <div className="poker-title"><h1>{pub.settings?.tableName || 'Poker'}</h1><div className="poker-game-titlebar-sub">Texas Hold&apos;em · {PHASE_LABELS[pub.phase] || pub.phase}{isHost ? ' · Du bist Host' : ''}</div></div>
        <div className="poker-game-titlebar-actions">
          <button type="button" className="poker-game-btn-icon" title="Poker-Hilfe" aria-label="Poker-Hilfe" onClick={() => setPanel('help')}><HelpCircle size={16} /></button>
          {isHost ? <button type="button" className="poker-game-btn-icon" title="Spieler verwalten" aria-label="Spieler verwalten" onClick={() => setPanel('players')}><Users size={16} /></button> : null}
          <button type="button" className="poker-game-btn-icon" title="Einstellungen" aria-label="Einstellungen" onClick={() => setPanel('settings')}><Settings size={16} /></button>
          {isHost ? <button type="button" className="poker-game-btn-icon" title="Spielstand speichern" aria-label="Spielstand speichern" onClick={() => send({ type: 'save_game' })}><Save size={16} /></button> : null}
          <button type="button" className="poker-game-btn-icon" title="Tisch verlassen" aria-label="Tisch verlassen" onClick={leave}><LogOut size={16} /></button>
          <button type="button" className="poker-game-btn-icon" title={soundEnabled ? 'Ton aus' : 'Ton an'} aria-label={soundEnabled ? 'Ton ausschalten' : 'Ton einschalten'} onClick={() => setSoundEnabled((value) => !value)}>{soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}</button>
          <button type="button" className="poker-game-btn-icon" title="Minimieren" aria-label="Minimieren" onClick={() => window.bluetalk?.window?.minimize?.()}><Minus size={16} /></button>
          <button type="button" className="poker-game-btn-icon" title="Fenster schließen" aria-label="Fenster schließen" onClick={closeWindow}><X size={16} /></button>
        </div>
      </header>
      <main className="poker-game-main">
        {inLobby ? <LobbyView snapshot={snapshot} selfId={selfId} isHost={isHost} onStart={() => send({ type: 'host_start' })} onLeave={leave} /> : <GameTable snapshot={snapshot} selfId={selfId} onAction={action} />}
        {isHost && pub.phase === 'between' ? <button type="button" className="poker-next-hand-button poker-btn-primary" onClick={() => send({ type: 'host_start' })}><Play size={16} /> Nächste Hand starten</button> : null}
      </main>
      {panel === 'help' ? <OverlayPanel title="Poker kurz erklärt" onClose={() => setPanel('')}><PokerGuide /></OverlayPanel> : null}
      {panel === 'settings' ? <OverlayPanel title="Tischeinstellungen" onClose={() => setPanel('')}><SettingsPanel settings={pub.settings} isHost={isHost} onUpdate={(settings) => send({ type: 'update_settings', settings })} /></OverlayPanel> : null}
      {panel === 'players' ? <OverlayPanel title="Spieler verwalten" onClose={() => setPanel('')}><PlayerManagement snapshot={snapshot} isHost={isHost} onInvite={(peerId) => send({ type: 'invite', peerId })} onGrantChips={(peerId, amount) => send({ type: 'admin_add_chips', peerId, amount })} onAddBot={() => send({ type: 'add_bot' })} onRemoveBot={() => send({ type: 'remove_bot' })} /></OverlayPanel> : null}
    </div>
  );
}
