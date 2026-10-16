import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Cloud,
  Copy,
  ExternalLink,
  EyeOff,
  Globe,
  Shield,
} from 'lucide-react';
import { useToast } from '../components/ToastProvider';
import CloudAccountPanel from './CloudAccountPanel';

const DEFAULT_RELAY_URL = 'wss://bt.henny.dev/v1/ws';
const RELAY_SOURCE_URL = 'https://github.com/Bluetalk/bluetalk/tree/v2/relay';

function hostFromUrl(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url || '';
  }
}

function shortenPeerId(id) {
  if (!id) return '';
  const prefix = id.startsWith('bt2_') ? 'bt2_' : '';
  const body = prefix ? id.slice(4) : id;
  if (body.length <= 12) return id;
  return `${prefix}${body.slice(0, 8)}…${body.slice(-4)}`;
}

function stateLabel(state) {
  switch (state) {
    case 'online':
      return 'Online';
    case 'connecting':
      return 'Verbindet…';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Fehler';
    case 'disabled':
      return 'Aus';
    case 'replaced':
      return 'Anderes Gerät';
    default:
      return 'Lädt…';
  }
}

export default function CloudSyncPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [relayDraft, setRelayDraft] = useState(DEFAULT_RELAY_URL);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [validationError, setValidationError] = useState('');

  const applyStatus = useCallback((next) => {
    if (!next || typeof next !== 'object') return;
    setStatus(next);
    if (typeof next.relayUrl === 'string' && next.relayUrl) {
      setRelayDraft(next.relayUrl);
    }
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.cloud) {
      setLoadError('Cloud-Nachrichten sind in dieser Umgebung nicht verfügbar.');
      return undefined;
    }
    let cancelled = false;
    void window.bluetalk.cloud.getStatus().then((next) => {
      if (!cancelled) {
        applyStatus(next);
        setLoadError('');
      }
    }).catch((error) => {
      if (!cancelled) setLoadError(error?.message || 'Status konnte nicht geladen werden.');
    });
    const off = window.bluetalk.cloud.onStatus((next) => {
      if (!cancelled) applyStatus(next);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [applyStatus]);

  const state = status?.state || (loadError ? 'error' : 'connecting');
  const enabled = status?.enabled !== false;
  const latency = typeof status?.latencyMs === 'number' ? status.latencyMs : null;
  const tunnelCount = status?.tunnels || 0;
  const onlineCount = Array.isArray(status?.onlinePeers) ? status.onlinePeers.length : 0;
  const relayHost = hostFromUrl(status?.relayUrl || relayDraft);
  const dirty = (status?.relayUrl || DEFAULT_RELAY_URL) !== relayDraft.trim();

  const online = state === 'online';
  const metricOrDash = (value) => (online ? value : '—');

  const privacySees = useMemo(() => ([
    'Peer-IDs von Absender und Empfänger',
    'Deinen Anzeigenamen',
    'Zeitpunkte und Größen',
    'IP-Adresse deiner Verbindung',
  ]), []);
  const privacyHides = useMemo(() => ([
    'Nachrichteninhalte und Anhänge — Ende-zu-Ende verschlüsselt',
    'Spiele und Dateiübertragungen im Tunnel — durchgehend verschlüsselt',
  ]), []);

  const toggleEnabled = async () => {
    if (!window.bluetalk?.cloud || saving) return;
    setSaving(true);
    setValidationError('');
    try {
      const next = await window.bluetalk.cloud.setConfig({
        enabled: !enabled,
        relayUrl: status?.relayUrl || DEFAULT_RELAY_URL,
      });
      applyStatus(next);
    } catch (error) {
      setValidationError(error?.message || 'Einstellung konnte nicht gespeichert werden.');
    } finally {
      setSaving(false);
    }
  };

  const saveRelay = async () => {
    if (!window.bluetalk?.cloud || saving) return;
    setSaving(true);
    setValidationError('');
    try {
      const next = await window.bluetalk.cloud.setConfig({
        enabled,
        relayUrl: relayDraft.trim() || DEFAULT_RELAY_URL,
      });
      applyStatus(next);
      toast({ variant: 'success', title: 'Gespeichert', message: 'Relay-Server aktualisiert.' });
    } catch (error) {
      setValidationError(error?.message || 'Relay-URL ist ungültig.');
    } finally {
      setSaving(false);
    }
  };

  const resetRelay = () => {
    setRelayDraft(DEFAULT_RELAY_URL);
    setValidationError('');
  };

  const copyPeerId = async () => {
    const peerId = status?.peerId;
    if (!peerId) {
      toast({ variant: 'warning', title: 'Noch nicht bereit', message: 'Deine Peer-ID kommt nach der Anmeldung.' });
      return;
    }
    try {
      await navigator.clipboard.writeText(peerId);
      setCopied(true);
      toast({ variant: 'success', title: 'Kopiert', message: 'Peer-ID in der Zwischenablage.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen', message: 'Kein Zugriff auf die Zwischenablage.' });
    }
  };

  const openRelaySource = async () => {
    try {
      if (window.bluetalk?.app?.openUrl) {
        await window.bluetalk.app.openUrl(RELAY_SOURCE_URL);
        return;
      }
    } catch {
      /* Fallback unten */
    }
    toast({
      variant: 'info',
      title: 'Eigenen Server hosten',
      message: RELAY_SOURCE_URL,
    });
  };

  return (
    <div className="page page-inset cloud-sync-page">
      <div className="page-shell cloud-sync-shell">
        <div className="cloud-sync-toolbar">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => navigate(-1, { viewTransition: true })}
          >
            <ArrowLeft size={16} strokeWidth={2} />
            Zurück
          </button>
        </div>

        {loadError && !status ? (
          <div className="card cloud-sync-empty" role="alert">
            <Cloud size={22} strokeWidth={1.75} aria-hidden />
            <h1 className="cloud-sync-title">BlueTalk Cloud</h1>
            <p className="text-muted">{loadError}</p>
          </div>
        ) : !status ? (
          <div className="card cloud-sync-empty" role="status">
            <span className="spinner spinner--md" />
            <p className="text-muted">Cloud-Status wird geladen…</p>
          </div>
        ) : (
          <>
            <section className="cloud-sync-hero">
              <div className="cloud-sync-hero-main">
                <div className={`cloud-sync-status-ring is-${state}`} aria-hidden>
                  <Cloud size={20} strokeWidth={1.75} />
                  <span className="cloud-sync-status-dot" />
                </div>
                <div className="cloud-sync-hero-copy">
                  <h1 className="cloud-sync-title">BlueTalk Cloud</h1>
                  <p className="cloud-sync-lead">
                    {stateLabel(state)}
                    {relayHost ? ` · ${relayHost}` : ''}
                    {latency != null && state === 'online' ? ` · ${latency} ms` : ''}
                  </p>
                  {status.lastError && state !== 'online' ? (
                    <p className="cloud-sync-error">{status.lastError}</p>
                  ) : (
                    <p className="cloud-sync-sub text-muted">
                      Live-Tunnel und Offline-Postfach über den Relay. Inhalte bleiben Ende-zu-Ende verschlüsselt.
                    </p>
                  )}
                </div>
              </div>
              <div className="cloud-sync-power">
                <span className="cloud-sync-power-label" aria-hidden>{enabled ? 'An' : 'Aus'}</span>
                <label className="toggle">
                    <span className="sr-only">BlueTalk Cloud {enabled ? 'ausschalten' : 'einschalten'}</span>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={saving}
                    onChange={() => void toggleEnabled()}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </section>

            {state === 'replaced' ? (
              <div className="card cloud-replaced-banner" role="status">
                <div>
                  <strong>BlueTalk ist auf einem anderen Gerät aktiv</strong>
                  <p className="text-muted" style={{ margin: '4px 0 0' }}>
                    Dieses Gerät wurde vom Relay getrennt. Sync über REST bleibt möglich.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={saving}
                  onClick={() => {
                    if (!window.bluetalk?.cloud?.takeover) return;
                    setSaving(true);
                    void window.bluetalk.cloud.takeover().catch((error) => {
                      setValidationError(error?.message || 'Übernahme fehlgeschlagen.');
                    }).finally(() => setSaving(false));
                  }}
                >
                  Hier verwenden
                </button>
              </div>
            ) : null}

            <CloudAccountPanel toast={toast} localPeerId={status?.peerId || ''} />

            <div className="cloud-sync-metrics">
              <div className="card cloud-sync-metric">
                <span className="cloud-sync-metric-value">{metricOrDash(onlineCount)}</span>
                <span className="cloud-sync-metric-label">Kontakte online über Cloud</span>
              </div>
              <div className="card cloud-sync-metric">
                <span className="cloud-sync-metric-value">{metricOrDash(tunnelCount)}</span>
                <span className="cloud-sync-metric-label">Aktive Tunnel</span>
              </div>
              <div className="card cloud-sync-metric">
                <span className="cloud-sync-metric-value">{online && latency != null ? `${latency} ms` : '—'}</span>
                <span className="cloud-sync-metric-label">Latenz</span>
              </div>
            </div>

            <section className="settings-section">
              <h2 className="settings-section-title">Server</h2>
              <div className="card">
                <div className="input-group">
                  <label htmlFor="cloud-relay-url">Relay-URL</label>
                  <input
                    id="cloud-relay-url"
                    className="input"
                    value={relayDraft}
                    onChange={(event) => {
                      setRelayDraft(event.target.value);
                      setValidationError('');
                    }}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder={DEFAULT_RELAY_URL}
                  />
                </div>
                {validationError ? (
                  <p className="cloud-sync-error" role="alert">{validationError}</p>
                ) : null}
                <div className="cloud-sync-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={resetRelay}>
                    Standard (bt.henny.dev)
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={saving || !dirty}
                    onClick={() => void saveRelay()}
                  >
                    Speichern
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Datenschutz</h2>
              <div className="card">
                <div className="cloud-sync-privacy">
                  <div>
                    <h3 className="cloud-sync-privacy-title">
                      <Globe size={15} strokeWidth={1.75} aria-hidden />
                      Was der Server sieht
                    </h3>
                    <ul>
                      {privacySees.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="cloud-sync-privacy-title">
                      <EyeOff size={15} strokeWidth={1.75} aria-hidden />
                      Was der Server nicht sieht
                    </h3>
                    <ul>
                      {privacyHides.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <p className="cloud-sync-privacy-note text-muted">
                  <Shield size={14} strokeWidth={1.75} aria-hidden />
                  Tunnel und Postfach tragen nur bereits verschlüsselte Bytes. Der Relay kann sich nicht unbemerkt dazwischenschalten.
                </p>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openRelaySource()}>
                  <ExternalLink size={14} strokeWidth={1.75} />
                  Eigenen Server hosten
                </button>
              </div>
            </section>

            <section className="settings-section">
              <h2 className="settings-section-title">Deine Peer-ID</h2>
              <div className="card cloud-sync-id-row">
                <code
                  className="cloud-sync-peer-id"
                  title={status.peerId || undefined}
                >
                  {status.peerId ? shortenPeerId(status.peerId) : 'Wird nach der Anmeldung angezeigt.'}
                </code>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void copyPeerId()}
                  disabled={!status.peerId}
                >
                  {copied ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={2} />}
                  {copied ? 'Kopiert' : 'Kopieren'}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
