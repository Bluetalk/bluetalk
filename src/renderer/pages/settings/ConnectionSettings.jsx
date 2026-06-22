import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
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
import { useRequireSettingsHub } from './useRequireSettingsHub';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

export default function ConnectionSettingsPage() {
  const { toast } = useToast();
  const { settings, updateSettings, peers } = useApp();
  const settingsHub = useRequireSettingsHub();

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

  if (!settingsHub) {
    return <Navigate to="/settings" replace />;
  }

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
        title: 'Nothing to copy',
        message: 'Your address is not ready yet. Wait a few seconds and try again.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      toast({ variant: 'success', title: 'Copied', message: 'Peer address copied to clipboard.' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({
        variant: 'error',
        title: 'Copy failed',
        message: 'Clipboard access was denied or is unavailable.',
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
          title: 'Port test complete',
          message: recommended ? `Recommended port: ${recommended}` : 'At least one port responded as open.',
        });
      } else {
        toast({
          variant: 'warning',
          title: 'Port test finished',
          message: 'No open standard ports detected from this machine.',
        });
      }

      if (window.bluetalk?.notify?.show) {
        const title = openPorts.length > 0
          ? 'BlueTalk network test complete'
          : 'BlueTalk network test finished';
        const body = openPorts.length > 0
          ? `Recommended port: ${recommended}`
          : 'No open standard ports detected.';
        window.bluetalk.notify.show({ title, body });
      }
    } catch (e) {
      const msg = e?.message || 'The port probe could not be completed.';
      toast({ variant: 'error', title: 'Port test failed', message: msg });
      window.bluetalk?.notify?.show?.({
        title: 'BlueTalk network test failed',
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
      const msg = e?.message || 'Doctor check failed.';
      toast({ variant: 'error', title: 'Doctor failed', message: msg });
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
        title: 'Setting updated',
        message: `API port set to ${next}. The REST listener was restarted.`,
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
        setConfigTail(tail?.error || 'Could not read configuration file.');
      }
    } catch (e) {
      setConfigTail(e?.message || 'Read failed.');
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
        title: 'Reconnect started',
        message: 'Dialing saved contact addresses in the background.',
      });
    } catch (e) {
      toast({ variant: 'error', title: 'Reconnect failed', message: e?.message || 'Unknown error' });
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
        title: 'Connections reset',
        message: 'All peer connections were closed; reconnecting to contacts and discovery in the background.',
      });
    } catch (e) {
      toast({
        variant: 'error',
        title: 'Reset failed',
        message: e?.message || 'Unknown error',
      });
    } finally {
      setResettingConnections(false);
    }
  };

  return (
    <div className="page">
      <SettingsBackHeader
        title="Connection"
        subtitle="Peers, network, and ports"
        icon={Plug}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Plug size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Connections
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            <div className="input-group">
              <label>Reconnect to contacts</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Retry outbound connections to every saved contact address and refresh LAN discovery. Use this after a network change or if peers show as offline.
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
                  {resettingConnections ? 'Resetting…' : 'Reset all & reconnect'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={redialSavedContacts}
                  disabled={redialing || resettingConnections || !window.bluetalk?.peer?.reconnectContacts}
                >
                  <RefreshCw size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {redialing ? 'Reconnecting…' : 'Reconnect'}
                </button>
              </div>
              <p className="text-sm text-muted" style={{ margin: '8px 0 0' }}>
                Reset all closes every active chat connection first, then runs the same reconnect and discovery refresh as above. Use when chats are stuck or state looks inconsistent.
              </p>
            </div>
            <div className="flex items-center gap-2" style={{ fontSize: 13 }}>
              <span className="text-muted">Currently connected:</span>
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
              Network
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            {peerInfo && (
              <>
                <div className="input-group">
                  <label>Your Primary Address</label>
                  <div className="flex gap-2">
                    <input
                      className="input font-mono"
                      value={peerInfo?.endpoints?.[0] || (peerInfo?.addresses?.[0] ? `${peerInfo.addresses[0]}:${peerInfo.port}` : 'Detecting...')}
                      readOnly
                      style={{ color: 'var(--fg-1)' }}
                    />
                    <button className="btn btn-secondary btn-icon" onClick={copyAddress} title="Copy address">
                      {copied ? <Check size={15} strokeWidth={SETTINGS_ICON_STROKE} /> : <Copy size={15} strokeWidth={SETTINGS_ICON_STROKE} />}
                    </button>
                  </div>
                </div>

                <div className="input-group">
                  <label>Listening Ports</label>
                  <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                    {(peerInfo?.ports?.length ? peerInfo.ports : [peerInfo.port]).map((port) => (
                      <span key={port} className="badge badge-default">{port}</span>
                    ))}
                  </div>
                </div>

                <div className="input-group">
                  <label>Reachable Endpoints</label>
                  <div className="code-block" style={{ marginTop: 0 }}>
                    {(peerInfo?.endpoints?.length ? peerInfo.endpoints : ['Detecting...']).map((endpoint) => (
                      <div key={endpoint}>{endpoint}</div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <div className="input-group">
              <label>API Port</label>
              <input
                className="input font-mono"
                type="number"
                value={local.apiPort || 19876}
                onChange={(e) => change('apiPort', parseInt(e.target.value, 10) || 19876)}
              />
            </div>

            <div className="input-group">
              <label>API Bearer Token</label>
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
                    toast({ variant: 'success', title: 'API token copied' });
                  }}
                >
                  Copy
                </button>
              </div>
              <p className="text-sm text-muted" style={{ margin: '8px 0 0' }}>
                The local REST API listens only on 127.0.0.1 and requires this token as an Authorization: Bearer header.
              </p>
            </div>

            <div className="input-group">
              <label>Port Test</label>
              <div className="flex gap-2" style={{ alignItems: 'center' }}>
                <button
                  className="btn btn-secondary"
                  onClick={testNetworkPorts}
                  disabled={testingPorts}
                  title="Test common ports in restrictive networks"
                >
                  <TestTube2 size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {testingPorts ? 'Testing ports...' : 'Test ports'}
                </button>
                {portDiagnostics?.recommendedPort ? (
                  <span className="badge badge-success">Recommended: {portDiagnostics.recommendedPort}</span>
                ) : (
                  <span className="badge badge-muted">No recommendation</span>
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
                        Port {check.port}: {check.status === 'open' ? 'open' : 'blocked'}
                        {check.code ? ` (${check.code})` : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="input-group">
              <label>Network doctor</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Combines outbound port probes with local listener state and suggests one-click fixes when they help.
              </p>
              <div className="flex gap-2" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={runNetworkDoctor}
                  disabled={doctorLoading}
                  title="Run connectivity and configuration checks"
                >
                  <Stethoscope size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {doctorLoading ? 'Running…' : 'Run doctor'}
                </button>
                {doctorResult?.issues?.length ? (
                  <span className="badge badge-warn">{doctorResult.issues.length} finding{doctorResult.issues.length !== 1 ? 's' : ''}</span>
                ) : doctorResult ? (
                  <span className="badge badge-success">No issues</span>
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
              <label>Configuration log (tail)</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                Last portion of the on-disk settings JSON (no separate log file). Useful for support and verifying ports after changes.
              </p>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={loadConfigTail}
                  disabled={configLoading}
                >
                  <ScrollText size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {configLoading ? 'Loading…' : 'Load tail'}
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
                <span className="font-medium" style={{ fontSize: 13 }}>Connected Peers</span>
                <span className="badge badge-default">{peers.length}</span>
              </div>
              {peers.length === 0 ? (
                <p className="text-sm text-muted">BlueTalk discovers peers on the local network and can test multiple ports in parallel.</p>
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
