import React, { useEffect, useState } from 'react';
import {
  Cable,
  Check,
  Copy,
  Globe,
  Network,
  Plug,
  RefreshCw,
  ScrollText,
  Stethoscope,
  TestTube2,
  Unplug,
} from 'lucide-react';
import { useApp } from '../../App';
import { useToast } from '../../components/ToastProvider';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

export default function ConnectionSettingsPage() {
  const { toast } = useToast();
  const { settings, updateSettings, peers } = useApp();

  const [peerInfo, setPeerInfo] = useState(null);
  const [copied, setCopied] = useState(false);
  const [apiAccess, setApiAccess] = useState(null);
  const [local, setLocal] = useState(settings);
  const [portDiagnostics, setPortDiagnostics] = useState(null);
  const [testingPorts, setTestingPorts] = useState(false);
  const [doctorResult, setDoctorResult] = useState(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const [configTail, setConfigTail] = useState('');
  const [configPath, setConfigPath] = useState('');
  const [configLoading, setConfigLoading] = useState(false);
  const [redialing, setRedialing] = useState(false);
  const [resettingConnections, setResettingConnections] = useState(false);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  useEffect(() => {
    const fetchInfo = async () => {
      if (!window.bluetalk) return;
      const info = await window.bluetalk.peer.getInfo();
      setPeerInfo(info);
      if (window.bluetalk.network?.getApiAccess) {
        setApiAccess(await window.bluetalk.network.getApiAccess());
      }
    };

    fetchInfo();
    const interval = setInterval(fetchInfo, 5000);
    return () => clearInterval(interval);
  }, []);

  const change = (key, value) => {
    setLocal((prev) => ({ ...prev, [key]: value }));
    updateSettings({ [key]: value });
  };

  const copyAddress = async () => {
    const endpoint = peerInfo?.endpoints?.[0] || (
      peerInfo?.addresses?.[0] && peerInfo?.port
        ? `${peerInfo.addresses[0]}:${peerInfo.port}`
        : ''
    );

    if (!endpoint) {
      toast({
        variant: 'warning',
        title: 'Nichts zu kopieren',
        message: 'Deine Adresse ist noch nicht bereit. Warte ein paar Sekunden und versuche es erneut.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      toast({ variant: 'success', title: 'Kopiert', message: 'Peer-Adresse in die Zwischenablage kopiert.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        variant: 'error',
        title: 'Kopieren fehlgeschlagen',
        message: 'Zugriff auf die Zwischenablage verweigert oder nicht verfügbar.',
      });
    }
  };

  const testNetworkPorts = async () => {
    if (!window.bluetalk?.network?.testPorts || testingPorts) return;

    setTestingPorts(true);
    try {
      const diagnostics = await window.bluetalk.network.testPorts();
      setPortDiagnostics(diagnostics);

      const openPorts = diagnostics?.checks?.filter((item) => item.status === 'open') || [];
      const recommended = diagnostics?.recommendedPort || 0;
      if (openPorts.length > 0) {
        void window.bluetalk?.peer?.reconnectContacts?.();
        void window.bluetalk?.peer?.refreshDiscovery?.();
        toast({
          variant: 'success',
          title: 'Porttest abgeschlossen',
          message: recommended ? `Empfohlener Port: ${recommended}` : 'Mindestens ein Port hat als offen geantwortet.',
        });
      } else {
        toast({
          variant: 'warning',
          title: 'Porttest beendet',
          message: 'Keine offenen Standard-Ports von diesem Rechner erkannt.',
        });
      }

      if (window.bluetalk?.notify?.show) {
        const title = openPorts.length > 0
          ? 'BlueTalk-Netzwerktest abgeschlossen'
          : 'BlueTalk-Netzwerktest beendet';
        const body = openPorts.length > 0
          ? `Empfohlener Port: ${recommended}`
          : 'Keine offenen Standard-Ports erkannt.';
        window.bluetalk.notify.show({ title, body });
      }
    } catch (e) {
      const msg = e?.message || 'Der Porttest konnte nicht abgeschlossen werden.';
      toast({ variant: 'error', title: 'Porttest fehlgeschlagen', message: msg });
      window.bluetalk?.notify?.show?.({
        title: 'BlueTalk-Netzwerktest fehlgeschlagen',
        body: msg,
      });
    } finally {
      setTestingPorts(false);
    }
  };

  const runNetworkDoctor = async () => {
    if (!window.bluetalk?.network?.doctor || doctorLoading) return;
    setDoctorLoading(true);
    try {
      const report = await window.bluetalk.network.doctor();
      setDoctorResult(report);
      if (report?.portProbe) {
        setPortDiagnostics(report.portProbe);
      }
    } catch (e) {
      const msg = e?.message || 'Diagnose fehlgeschlagen.';
      toast({ variant: 'error', title: 'Diagnose fehlgeschlagen', message: msg });
    } finally {
      setDoctorLoading(false);
    }
  };

  const applyDoctorFix = (fix) => {
    if (!fix?.settingKey) return;
    if (fix.settingKey === 'apiPort') {
      const next = Number(fix.value) || 19876;
      change('apiPort', next);
      toast({
        variant: 'success',
        title: 'Einstellung aktualisiert',
        message: `API-Port auf ${next} gesetzt. Der REST-Listener wurde neu gestartet.`,
      });
    }
  };

  const loadConfigTail = async () => {
    if (!window.bluetalk?.app?.readConfigTail || configLoading) return;
    setConfigLoading(true);
    try {
      const meta = await window.bluetalk.app.getConfigLogPath?.();
      if (meta?.path) {
        setConfigPath(meta.path);
      }
      const tail = await window.bluetalk.app.readConfigTail(120000);
      if (tail?.ok) {
        setConfigTail(tail.text || '');
        if (tail.path) setConfigPath(tail.path);
      } else {
        setConfigTail(tail?.error || 'Konfigurationsdatei konnte nicht gelesen werden.');
      }
    } catch (e) {
      setConfigTail(e?.message || 'Lesen fehlgeschlagen.');
    } finally {
      setConfigLoading(false);
    }
  };

  const redialSavedContacts = async () => {
    if (!window.bluetalk?.peer?.reconnectContacts || redialing || resettingConnections) return;
    setRedialing(true);
    try {
      await window.bluetalk.peer.reconnectContacts();
      void window.bluetalk.peer.refreshDiscovery?.();
      toast({
        variant: 'success',
        title: 'Neuverbindung gestartet',
        message: 'Gespeicherte Kontaktadressen werden im Hintergrund angewählt.',
      });
    } catch (e) {
      toast({ variant: 'error', title: 'Neuverbindung fehlgeschlagen', message: e?.message || 'Unbekannter Fehler' });
    } finally {
      setRedialing(false);
    }
  };

  const resetAllConnectionsAndReconnect = async () => {
    if (!window.bluetalk?.peer?.resetAllConnections || resettingConnections || redialing) return;
    setResettingConnections(true);
    try {
      await window.bluetalk.peer.resetAllConnections();
      toast({
        variant: 'success',
        title: 'Verbindungen zurückgesetzt',
        message: 'Alle Peer-Verbindungen wurden getrennt; Neuverbindung zu Kontakten und Discovery läuft im Hintergrund.',
      });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Zurücksetzen fehlgeschlagen',
        message: e?.message || 'Unbekannter Fehler',
      });
    } finally {
      setResettingConnections(false);
    }
  };

  return (
    <div className="page">
      <SettingsBackHeader
        title="Verbindung"
        subtitle="Peers, Netzwerk und Ports"
        icon={Plug}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Plug size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Verbindungen
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            <div className="input-group">
              <label>Zu Kontakten neu verbinden</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Versucht ausgehende Verbindungen zu allen gespeicherten Kontaktadressen erneut und aktualisiert die LAN-Discovery. Nützlich nach einem Netzwerkwechsel oder wenn Peers als offline angezeigt werden.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={resetAllConnectionsAndReconnect}
                  disabled={
                    resettingConnections ||
                    redialing ||
                    !window.bluetalk?.peer?.resetAllConnections
                  }
                >
                  <Unplug size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {resettingConnections ? 'Wird zurückgesetzt…' : 'Alle zurücksetzen & neu verbinden'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={redialSavedContacts}
                  disabled={redialing || resettingConnections || !window.bluetalk?.peer?.reconnectContacts}
                >
                  <RefreshCw size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {redialing ? 'Wird verbunden…' : 'Neu verbinden'}
                </button>
              </div>
              <p className="text-sm text-muted" style={{ margin: '8px 0 0' }}>
                „Alle zurücksetzen“ trennt zuerst alle aktiven Chat-Verbindungen und führt dann dieselbe Neuverbindung und Discovery-Aktualisierung wie oben aus. Nützlich, wenn Chats hängen oder der Zustand inkonsistent wirkt.
              </p>
            </div>
            <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <span className="text-muted">Aktuell verbunden:</span>
              <span className="badge badge-default">{peers.length}</span>
            </div>
          </div>
        </section>

        {local.debugMode && (
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Network size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Netzwerk
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            {peerInfo && (
              <>
                <div className="input-group">
                  <label>Deine primäre Adresse</label>
                  <div className="flex gap-2">
                    <input
                      className="input font-mono"
                      value={peerInfo?.endpoints?.[0] || (peerInfo?.addresses?.[0] ? `${peerInfo.addresses[0]}:${peerInfo.port}` : 'Wird ermittelt…')}
                      readOnly
                      style={{ color: 'var(--fg-1)' }}
                    />
                    <button className="btn btn-secondary btn-icon" onClick={copyAddress} title="Adresse kopieren">
                      {copied ? <Check size={15} strokeWidth={SETTINGS_ICON_STROKE} /> : <Copy size={15} strokeWidth={SETTINGS_ICON_STROKE} />}
                    </button>
                  </div>
                </div>

                <div className="input-group">
                  <label>Lauschende Ports</label>
                  <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                    {(peerInfo?.ports?.length ? peerInfo.ports : [peerInfo.port]).map((port) => (
                      <span key={port} className="badge badge-default">{port}</span>
                    ))}
                  </div>
                </div>

                <div className="input-group">
                  <label>Erreichbare Endpunkte</label>
                  <div className="code-block" style={{ marginTop: 0 }}>
                    {(peerInfo?.endpoints?.length ? peerInfo.endpoints : ['Wird ermittelt…']).map((endpoint) => (
                      <div key={endpoint}>{endpoint}</div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="input-group">
              <label>API-Port</label>
              <input
                className="input font-mono"
                type="number"
                value={local.apiPort || 19876}
                onChange={(e) => change('apiPort', parseInt(e.target.value, 10) || 19876)}
              />
            </div>

            <div className="input-group">
              <label>API-Bearer-Token</label>
              <div className="flex gap-2">
                <input
                  className="input font-mono"
                  type="password"
                  value={apiAccess?.token || ''}
                  readOnly
                  aria-label="API Bearer Token"
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={async () => {
                    if (!apiAccess?.token) return;
                    await navigator.clipboard.writeText(apiAccess.token);
                    toast({ variant: 'success', title: 'API-Token kopiert' });
                  }}
                >
                  Kopieren
                </button>
              </div>
              <p className="text-sm text-muted" style={{ margin: '8px 0 0' }}>
                Die lokale REST-API lauscht nur auf 127.0.0.1 und erwartet dieses Token als Authorization: Bearer-Header.
              </p>
            </div>

            <div className="input-group">
              <label>Porttest</label>
              <div className="flex gap-2" style={{ alignItems: 'center' }}>
                <button
                  className="btn btn-secondary"
                  onClick={testNetworkPorts}
                  disabled={testingPorts}
                  title="Gängige Ports in restriktiven Netzwerken testen"
                >
                  <TestTube2 size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {testingPorts ? 'Teste Ports…' : 'Ports testen'}
                </button>
                {portDiagnostics?.recommendedPort ? (
                  <span className="badge badge-success">Empfohlen: {portDiagnostics.recommendedPort}</span>
                ) : (
                  <span className="badge badge-muted">Keine Empfehlung</span>
                )}
              </div>

              {portDiagnostics && (
                <div className="code-block" style={{ marginTop: 8 }}>
                  <div className="flex items-center gap-2">
                    <Globe size={14} strokeWidth={SETTINGS_ICON_STROKE} className="text-muted" style={{ flexShrink: 0 }} aria-hidden />
                    <span>Host: {portDiagnostics.host}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>
                    {portDiagnostics.checks.map((check) => (
                      <div key={check.port} className="flex items-center gap-2" style={{ marginTop: 2 }}>
                        <Cable size={14} strokeWidth={SETTINGS_ICON_STROKE} className="text-muted" style={{ flexShrink: 0 }} aria-hidden />
                        <span>
                        Port {check.port}: {check.status === 'open' ? 'offen' : 'blockiert'}
                        {check.code ? ` (${check.code})` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="input-group">
              <label>Netzwerkdiagnose</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Kombiniert ausgehende Port-Prüfungen mit dem lokalen Listener-Status und schlägt Ein-Klick-Korrekturen vor, wenn sie helfen.
              </p>
              <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={runNetworkDoctor}
                  disabled={doctorLoading}
                  title="Verbindungs- und Konfigurationsprüfungen ausführen"
                >
                  <Stethoscope size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {doctorLoading ? 'Läuft…' : 'Diagnose starten'}
                </button>
                {doctorResult?.issues?.length ? (
                  <span className="badge badge-warn">{doctorResult.issues.length} Befund{doctorResult.issues.length !== 1 ? 'e' : ''}</span>
                ) : doctorResult ? (
                  <span className="badge badge-success">Keine Probleme</span>
                ) : null}
              </div>
              {doctorResult?.issues?.length > 0 && (
                <ul className="text-sm" style={{ margin: '10px 0 0', paddingLeft: 18 }}>
                  {doctorResult.issues.map((issue) => (
                    <li key={issue.code} style={{ marginTop: 4 }}>
                      <span className={`badge ${issue.severity === 'error' ? 'badge-danger' : issue.severity === 'warn' ? 'badge-warn' : 'badge-muted'}`} style={{ marginRight: 6 }}>
                        {issue.severity}
                      </span>
                      {issue.message}
                    </li>
                  ))}
                </ul>
              )}
              {doctorResult?.fixes?.length > 0 && (
                <div className="flex gap-2" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                  {doctorResult.fixes.map((fix) => (
                    <button
                      key={fix.code}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => applyDoctorFix(fix)}
                    >
                      {fix.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="input-group">
              <label>Konfigurationsprotokoll (Auszug)</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Letzter Teil der gespeicherten Einstellungs-JSON (keine separate Logdatei). Nützlich für Support und zum Prüfen der Ports nach Änderungen.
              </p>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={loadConfigTail}
                  disabled={configLoading}
                >
                  <ScrollText size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {configLoading ? 'Wird geladen…' : 'Auszug laden'}
                </button>
                {configPath ? (
                  <span className="text-xs text-muted font-mono" style={{ alignSelf: 'center', wordBreak: 'break-all' }} title={configPath}>
                    {configPath}
                  </span>
                ) : null}
              </div>
              {configTail ? (
                <pre className="code-block" style={{ marginTop: 8, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{configTail}</pre>
              ) : null}
            </div>

            <div className="mt-1">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-medium" style={{ fontSize: 13 }}>Verbundene Peers</span>
                <span className="badge badge-default">{peers.length}</span>
              </div>
              {peers.length === 0 ? (
                <p className="text-sm text-muted">BlueTalk findet Peers im lokalen Netzwerk und kann mehrere Ports parallel testen.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {peers.map((peer) => (
                    <div key={peer.id} className="flex items-center gap-2" style={{ fontSize: 12.5 }}>
                      <span className="online-dot" />
                      <span className="font-medium">{peer.name}</span>
                      <span className="font-mono text-muted">{peer.address}:{peer.port}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
        )}
      </div>
    </div>
  );
}
