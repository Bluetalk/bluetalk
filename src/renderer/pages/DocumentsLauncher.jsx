import React, { useCallback, useEffect, useState } from 'react';
import { FileText, FolderOpen, Users, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useToast } from '../components/ToastProvider';
import { pluginRuntime } from '../plugins/pluginRuntime';

const ICON_STROKE = 1.75;
const DOCS_PLUGIN_ID = 'live-docs';

function formatWhen(ts) {
  const d = Number(ts) || 0;
  if (!d) return '';
  const min = Math.floor((Date.now() - d) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std`;
  const days = Math.floor(h / 24);
  if (days < 7) return `vor ${days} Tag${days === 1 ? '' : 'en'}`;
  return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Erstklassiger Einstieg für „Dokumente" — bewusst getrennt von der Spiele-Seite.
 * Öffnet denselben Live-Editor (eigenes Fenster), den das live-docs-Plugin
 * bereitstellt, zeigt aber keinerlei Spiel-Framing. Listet die zuletzt
 * bearbeiteten Dokumente und hebt eine laufende Sitzung hervor.
 */
export default function DocumentsLauncherPage() {
  const { toast } = useToast();
  const [entry, setEntry] = useState(null);
  const [state, setState] = useState({ active: false, tableName: null, docId: '' });
  const [recent, setRecent] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const tool = pluginRuntime.listTools().find((t) => t.id === DOCS_PLUGIN_ID) || null;
    setEntry(tool);
    if (tool?.enabled) {
      const [stateRes, recentRes] = await Promise.all([
        pluginRuntime.invokePluginCommand(DOCS_PLUGIN_ID, 'launcherState'),
        pluginRuntime.invokePluginCommand(DOCS_PLUGIN_ID, 'listRecent'),
      ]);
      setState(stateRes?.ok && stateRes.result ? stateRes.result : { active: false, tableName: null, docId: '' });
      setRecent(recentRes?.ok && Array.isArray(recentRes.result) ? recentRes.result : []);
    } else {
      setState({ active: false, tableName: null, docId: '' });
      setRecent([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const offPlugins = pluginRuntime.onPluginsChanged(() => { void refresh(); });
    const offChanged = window.bluetalk?.on?.('plugins:changed', () => { void refresh(); });
    // Der Editor läuft in einem eigenen Fenster — beim Zurückkehren neu einlesen.
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      offPlugins();
      offChanged?.();
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  const enable = useCallback(async () => {
    if (!window.bluetalk?.plugins?.setEnabled) return;
    await window.bluetalk.plugins.setEnabled(DOCS_PLUGIN_ID, true);
    await pluginRuntime.refresh();
    await refresh();
    toast({ variant: 'success', title: 'Dokumente aktiviert', message: 'Du kannst jetzt loslegen.' });
  }, [refresh, toast]);

  const invoke = useCallback(async (command, args) => {
    const response = await pluginRuntime.invokePluginCommand(DOCS_PLUGIN_ID, command, args);
    if (!response?.ok) {
      toast({
        variant: 'warning',
        title: 'Dokumente',
        message: response?.error === 'not_active'
          ? 'Die Erweiterung ist nicht aktiv — zuerst aktivieren.'
          : response?.error || 'Aktion konnte nicht ausgeführt werden.',
      });
      return;
    }
    await refresh();
  }, [refresh, toast]);

  const forget = useCallback(async (id) => {
    await pluginRuntime.invokePluginCommand(DOCS_PLUGIN_ID, 'forgetRecent', { id });
    await refresh();
  }, [refresh]);

  return (
    <div className="page page-games">
      <div className="page-header">
        <div>
          <h1 className="page-title-row">
            <span className="page-title-icon" aria-hidden>
              <FileText size={18} strokeWidth={ICON_STROKE} />
            </span>
            Dokumente
          </h1>
          <p>
            Word-Dokumente gemeinsam in Echtzeit bearbeiten — mit Formatierung, Live-Cursor und .docx-Import/-Export.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="games-empty"><p className="text-muted">Wird geladen…</p></div>
      ) : !entry ? (
        <div className="games-empty">
          <h3>Dokumente nicht verfügbar</h3>
          <p>Die Erweiterung „Dokumente" ist nicht installiert. Prüfe die <Link to="/plugins">Erweiterungen</Link>.</p>
        </div>
      ) : (
        <>
          <div className="games-grid">
            <article className={`games-launch-card${state.active ? ' is-active' : ''}${!entry.enabled ? ' is-inactive' : ''}`}>
              <div className="games-launch-card-head">
                <div className="games-launch-mark games-launch-mark--live-docs" aria-hidden>📝</div>
                <div className="games-launch-heading">
                  <div className="games-launch-title-row">
                    <h3>Dokumente</h3>
                    <span className="plugin-tag-badge plugin-tag-badge--card">Live</span>
                  </div>
                  {state.active ? (
                    <span className="games-launch-status games-launch-status--live">
                      <span className="games-launch-status-dot" aria-hidden />
                      Läuft
                    </span>
                  ) : !entry.enabled ? (
                    <span className="games-launch-status">Inaktiv</span>
                  ) : (
                    <span className="games-launch-status games-launch-status--ready">Bereit</span>
                  )}
                </div>
              </div>

              <div className="games-launch-body">
                {state.active ? (
                  <p className="games-launch-hint">
                    <strong>{state.tableName || 'Dokument'}</strong> läuft — Mitschreiben und Einladen im Editor-Fenster.
                  </p>
                ) : (
                  <>
                    <p className="games-launch-desc">{entry.description}</p>
                    {!entry.enabled ? (
                      <p className="games-launch-hint">Installiert, aber noch nicht aktiviert.</p>
                    ) : null}
                  </>
                )}
              </div>

              <div className="games-launch-actions">
                {!entry.enabled ? (
                  <>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void enable()}>
                      Aktivieren
                    </button>
                    <Link to="/plugins" className="btn btn-secondary btn-sm">Erweiterungen</Link>
                  </>
                ) : state.active ? (
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void invoke('openWindow')}>
                    <FolderOpen size={15} strokeWidth={ICON_STROKE} /> Editor öffnen
                  </button>
                ) : (
                  <>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void invoke('launchNew')}>
                      <Users size={15} strokeWidth={ICON_STROKE} /> Neues Dokument
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void invoke('openWindow')}>
                      Editor öffnen
                    </button>
                  </>
                )}
              </div>
            </article>
          </div>

          {entry.enabled && recent.length > 0 ? (
            <section className="docs-recent">
              <h3 className="docs-recent-title">Zuletzt bearbeitet</h3>
              <ul className="docs-recent-list">
                {recent.map((d) => {
                  const isCurrent = state.active && state.docId && state.docId === d.id;
                  return (
                    <li key={d.id} className={`docs-recent-item${isCurrent ? ' is-current' : ''}`}>
                      <button
                        type="button"
                        className="docs-recent-open"
                        onClick={() => void invoke('openRecent', { id: d.id })}
                        title="Dokument öffnen"
                      >
                        <span className="docs-recent-icon" aria-hidden>📄</span>
                        <span className="docs-recent-info">
                          <span className="docs-recent-name">{d.fileName || 'Unbenanntes Dokument'}</span>
                          <span className="docs-recent-meta">
                            {isCurrent ? 'Läuft gerade · ' : ''}{formatWhen(d.updatedAt)}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="docs-recent-forget"
                        title="Aus der Liste entfernen"
                        aria-label="Aus der Liste entfernen"
                        onClick={() => void forget(d.id)}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
