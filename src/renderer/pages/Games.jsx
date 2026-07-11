import React, { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/ToastProvider';
import { pluginRuntime } from '../plugins/pluginRuntime';

const ICON_STROKE = 1.75;

const DEFAULT_LABELS = {
  launchNew: 'Neues Spiel',
  launchResume: 'Fortsetzen',
  openWindow: 'Spielfenster öffnen',
};

function labelsForGame(game) {
  const custom = game.labels || {};
  const byId = game.id === 'uno'
    ? { launchNew: 'Neue Runde', openWindow: 'UNO-Fenster öffnen' }
    : game.id === 'poker'
      ? { openWindow: 'Poker-Fenster öffnen' }
      : game.id === 'connect-four'
        ? { openWindow: 'Vier-gewinnt-Fenster öffnen' }
        : game.id === 'chess'
          ? { launchNew: 'Neue Partie', openWindow: 'Schach-Fenster öffnen' }
          : game.id === 'tic-tac-toe'
            ? { openWindow: 'Tic-Tac-Toe-Fenster öffnen' }
            : {};
  return { ...DEFAULT_LABELS, ...byId, ...custom };
}

export default function GamesPage() {
  const { toast } = useToast();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const games = pluginRuntime.listGames();
    if (!games.length) {
      setEntries([]);
      setLoading(false);
      return;
    }

    const next = await Promise.all(games.map(async (game) => {
      if (!game.enabled) {
        return {
          game,
          state: { active: false, hasSavedGame: false, tableName: null },
          labels: labelsForGame(game),
        };
      }
      const response = await pluginRuntime.invokePluginCommand(game.id, 'launcherState');
      const state = response?.ok && response.result
        ? response.result
        : { active: false, hasSavedGame: false, tableName: null };
      return { game, state, labels: labelsForGame(game) };
    }));
    setEntries(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const offPlugins = pluginRuntime.onPluginsChanged(() => { void refresh(); });
    const onLauncherRefresh = () => { void refresh(); };
    window.addEventListener('bt:games-launcher-refresh', onLauncherRefresh);
    const offChanged = window.bluetalk?.on?.('plugins:changed', () => { void refresh(); });
    return () => {
      offPlugins();
      offChanged?.();
      window.removeEventListener('bt:games-launcher-refresh', onLauncherRefresh);
    };
  }, [refresh]);

  const enableGame = async (gameId) => {
    if (!window.bluetalk?.plugins?.setEnabled) return;
    const confirmed = window.confirm(
      'Diese Erweiterung aktivieren? Spiele laufen mit Zugriff auf Chats, Kontakte und Netzwerk.'
    );
    if (!confirmed) return;
    await window.bluetalk.plugins.setEnabled(gameId, true);
    await pluginRuntime.refresh();
    await refresh();
    toast({ variant: 'success', title: 'Spiel aktiviert', message: 'Du kannst es jetzt starten.' });
  };

  const invokeGame = async (gameId, command) => {
    const response = await pluginRuntime.invokePluginCommand(gameId, command);
    if (!response?.ok) {
      toast({
        variant: 'warning',
        title: 'Spiele',
        message: response?.error === 'not_active'
          ? 'Diese Erweiterung ist nicht aktiv — zuerst aktivieren.'
          : response?.error === 'unknown_command'
            ? 'Spiel-Befehl nicht verfügbar — Erweiterung neu laden oder „Standard wiederherstellen“ unter Erweiterungen.'
            : response?.error || 'Aktion konnte nicht ausgeführt werden.',
      });
      return;
    }
    if (response.result?.ok === false) {
      toast({
        variant: 'warning',
        title: 'Spiele',
        message: response.result?.message || 'Spiel konnte nicht gestartet werden.',
      });
      return;
    }
    await refresh();
  };

  return (
    <div className="page page-games">
      <div className="page-header">
        <div>
          <h1 className="page-title-row">
            <span className="page-title-icon" aria-hidden>
              <Sparkles size={18} strokeWidth={ICON_STROKE} />
            </span>
            Spiele
          </h1>
          <p>
            Starte installierte Spiele — Host erstellt die Lobby, Gäste treten per Chat-Einladung bei.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="games-empty">
          <p className="text-muted">Spiele werden geladen…</p>
        </div>
      ) : null}

      {!loading && entries.length === 0 ? (
        <div className="games-empty">
          <h3>Noch keine Spiele aktiv</h3>
          <p>
            Aktiviere Spiele wie Poker oder UNO unter <strong>Erweiterungen</strong>, um sie hier zu sehen.
          </p>
        </div>
      ) : null}

      {!loading && entries.length > 0 ? (
        <div className="games-grid">
          {entries.map(({ game, state, labels }) => {
            const cardClass = `games-launch-card${state.active ? ' is-active' : ''}${!game.enabled ? ' is-inactive' : ''}`;
            // Alpha-Badge nur, wenn das Manifest tatsächlich einen alphaNotice-Text liefert.
            const isAlpha = Boolean(game.alphaNotice);
            const showTag = game.tag && String(game.tag).toLowerCase() !== 'alpha';
            return (
              <article key={game.id} className={cardClass}>
                <div className="games-launch-card-head">
                  <div className={`games-launch-mark games-launch-mark--${game.id}`} aria-hidden>
                    {game.mark}
                  </div>
                  <div className="games-launch-heading">
                    <div className="games-launch-title-row">
                      <h3>{game.name}</h3>
                      {isAlpha ? (
                        <span className="plugin-tag-badge plugin-tag-badge--card plugin-tag-badge--alpha">Alpha</span>
                      ) : null}
                      {showTag ? (
                        <span className="plugin-tag-badge plugin-tag-badge--card">{game.tag}</span>
                      ) : null}
                    </div>
                    {state.active ? (
                      <span className="games-launch-status games-launch-status--live">
                        <span className="games-launch-status-dot" aria-hidden />
                        Läuft
                      </span>
                    ) : !game.enabled ? (
                      <span className="games-launch-status">Inaktiv</span>
                    ) : state.hasSavedGame ? (
                      <span className="games-launch-status">Gespeichertes Spiel</span>
                    ) : (
                      <span className="games-launch-status games-launch-status--ready">Bereit</span>
                    )}
                  </div>
                </div>

                <div className="games-launch-body">
                  <p className="games-launch-desc">{game.description}</p>
                  {!game.enabled ? (
                    <p className="games-launch-hint">Installiert, aber noch nicht aktiviert.</p>
                  ) : state.active ? (
                    <p className="games-launch-hint">
                      <strong>{state.tableName || game.name}</strong> läuft — Einladungen und Einstellungen im Spielfenster.
                    </p>
                  ) : game.alphaNotice ? (
                    <p className="games-alpha-notice" role="note">{game.alphaNotice}</p>
                  ) : null}
                </div>

                <div className="games-launch-actions">
                  {!game.enabled ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void enableGame(game.id)}
                      >
                        Spiel aktivieren
                      </button>
                      <Link to="/plugins" className="btn btn-secondary btn-sm">
                        Erweiterungen
                      </Link>
                    </>
                  ) : state.active ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void invokeGame(game.id, 'openWindow')}
                    >
                      {labels.openWindow}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void invokeGame(game.id, 'launchNew')}
                      >
                        {labels.launchNew}
                      </button>
                      {state.hasSavedGame ? (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void invokeGame(game.id, 'launchResume')}
                        >
                          {labels.launchResume}
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
