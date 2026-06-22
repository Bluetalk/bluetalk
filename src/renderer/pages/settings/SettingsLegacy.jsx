import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../App';
import { useToast } from '../../components/ToastProvider';
import { APP_VERSION } from '../../appVersion';
import FeatureFlagsModal from '../../components/FeatureFlagsModal';
import {
  formatBytes,
  formatDateTime,
  getUpdateBadgeClass,
  getUpdateStatusLabel,
  SETTINGS_ICON_STROKE,
} from './settingsUtils';
import {
  ArrowUpCircle,
  Bell,
  Bug,
  Cable,
  Check,
  Copy,
  Download,
  Globe,
  Moon,
  Network,
  Plug,
  Power,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server,
  Settings2,
  Smile,
  Stethoscope,
  Sun,
  TestTube2,
  Trash2,
  Unplug,
  User,
} from 'lucide-react';

export default function SettingsLegacy() {
  const { toast } = useToast();
  const { settings, updateSettings, peers, theme, toggleTheme } = useApp();
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
  const [updaterState, setUpdaterState] = useState(null);
  const [updateAction, setUpdateAction] = useState('');
  const [dataAction, setDataAction] = useState('');
  const [featureFlagsOpen, setFeatureFlagsOpen] = useState(false);

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

  useEffect(() => {
    if (!window.bluetalk?.updater) return undefined;

    let mounted = true;
    let unsubscribe = null;

    const loadUpdater = async () => {
      const state = await window.bluetalk.updater.getState();
      if (mounted) {
        setUpdaterState(state);
      }

      unsubscribe = window.bluetalk.on('updater:state', (nextState) => {
        if (mounted) {
          setUpdaterState(nextState);
        }
      });
    };

    loadUpdater();

    return () => {
      mounted = false;
      unsubscribe?.();
    };
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

  const runUpdaterAction = async (action, fn) => {
    if (!window.bluetalk?.updater || updateAction) return;

    setUpdateAction(action);
    try {
      const nextState = await fn();
      if (nextState && typeof nextState === 'object') {
        setUpdaterState(nextState);
      }
    } finally {
      setUpdateAction('');
    }
  };

  const checkForUpdates = () => runUpdaterAction('check', () => window.bluetalk.updater.check());
  const downloadUpdate = () => runUpdaterAction('download', () => window.bluetalk.updater.download());
  const installUpdate = () => runUpdaterAction('install', () => window.bluetalk.updater.install());

  const runDataAction = async (actionKey, fn) => {
    if (!window.bluetalk?.app || dataAction) return;
    setDataAction(actionKey);
    try {
      return await fn();
    } finally {
      setDataAction('');
    }
  };

  const clearAppCache = () => runDataAction('cache', async () => {
    const ok = window.confirm(
      'Clear the in-app browser cache and web storage (localStorage, etc.)? Your chats and settings stay on disk until you delete them separately.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.clearCache();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'Cache cleared',
        message: 'Temporary web data was removed.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Could not clear cache',
        message: result?.error || 'Unknown error',
      });
    }
  });

  const clearChatHistoryOnly = () => runDataAction('messages', async () => {
    const ok = window.confirm(
      'Delete all saved chat messages and read receipts? Contacts and settings are kept.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.clearMessages();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'Chats cleared',
        message: 'All stored messages were removed.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Could not clear chats',
        message: result?.error || 'Unknown error',
      });
    }
  });

  const wipeAllAppData = () => runDataAction('wipe', async () => {
    const ok = window.confirm(
      'Delete ALL local BlueTalk data (chats, contacts, settings, identity)? This cannot be undone. The app will reload your empty profile.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.wipeAllData();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'All data deleted',
        message: 'Local storage was reset. You may get a new peer ID.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Delete failed',
        message: result?.error || 'Unknown error',
      });
    }
  });

  const isCheckingUpdates = updateAction === 'check' || updaterState?.status === 'checking';
  const isDownloadingUpdate = updateAction === 'download' || updaterState?.status === 'downloading';
  const updateProgress = Math.max(0, Math.min(100, updaterState?.percent || 0));
  const latestVersion = updaterState?.downloadedVersion || updaterState?.availableVersion || '-';
  const showManualDownload = updaterState?.supported &&
    updaterState?.status !== 'pending_build' && (
      (!updaterState?.autoDownloadUpdates && updaterState?.status === 'available') ||
      (updaterState?.status === 'error' && Boolean(updaterState?.availableVersion))
    );
  const showInstallAction = updaterState?.supported && updaterState?.status === 'downloaded';

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title-row">
          <span className="page-title-icon" aria-hidden>
            <Settings2 size={18} strokeWidth={SETTINGS_ICON_STROKE} />
          </span>
          Settings
        </h1>
        <p>Configure your BlueTalk instance</p>
      </div>

      <div className="page-body">
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <User size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Identity
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            {peerInfo ? (
              <div className="input-group">
                <label>Peer ID</label>
                <input className="input font-mono" value={peerInfo.id || ''} readOnly style={{ color: 'var(--fg-2)' }} />
              </div>
            ) : (
              <p className="text-sm text-muted" style={{ margin: 0 }}>Loading peer information…</p>
            )}
          </div>
        </section>

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
                <input className="input font-mono" type="password" value={apiAccess?.token || ''} readOnly />
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
                The REST API is loopback-only and requires this token as an Authorization: Bearer header.
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

        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Trash2 size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Data &amp; storage
            </h3>
          </div>
          <div className="card flex flex-col gap-0">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Clear cache</span>
                <span>Removes Chromium disk cache and web storage for this window. Does not delete your chat history file.</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={clearAppCache}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'cache' ? 'Working…' : 'Clear cache'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Clear all chats</span>
                <span>Deletes every stored message and read receipt. Keeps contacts and settings.</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={clearChatHistoryOnly}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'messages' ? 'Working…' : 'Clear chats'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Delete all local data</span>
                <span>Wipes the config file (chats, contacts, settings) and assigns a fresh peer identity. Use only if you want a clean install.</span>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={wipeAllAppData}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'wipe' ? 'Working…' : 'Delete everything'}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <ArrowUpCircle size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Updates
            </h3>
          </div>
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Automatic update checks</span>
                <span>Poll GitHub Releases in the background for packaged installs</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.autoUpdateEnabled ?? true}
                  onChange={(e) => change('autoUpdateEnabled', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Automatically download updates</span>
                <span>Download the installer as soon as a newer release is found</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.autoDownloadUpdates ?? true}
                  onChange={(e) => change('autoDownloadUpdates', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="updater-panel">
              <div className="card-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="font-medium" style={{ fontSize: 13.5 }}>BlueTalk {updaterState?.currentVersion || APP_VERSION}</div>
                  <p className="text-sm text-muted" style={{ marginTop: 4 }}>
                    {updaterState?.message || 'Check for updates manually or let BlueTalk check in the background.'}
                  </p>
                </div>
                <span className={`badge ${getUpdateBadgeClass(updaterState)}`}>
                  {getUpdateStatusLabel(updaterState)}
                </span>
              </div>

              <div className="updater-grid">
                <div className="input-group">
                  <label>Current Version</label>
                  <input className="input font-mono" value={updaterState?.currentVersion || APP_VERSION} readOnly />
                </div>
                <div className="input-group">
                  <label>Latest Release</label>
                  <input className="input font-mono" value={latestVersion} readOnly />
                </div>
                <div className="input-group">
                  <label>Last Checked</label>
                  <input className="input" value={formatDateTime(updaterState?.lastCheckedAt)} readOnly />
                </div>
                <div className="input-group">
                  <label>Release Date</label>
                  <input className="input" value={formatDateTime(updaterState?.releaseDate)} readOnly />
                </div>
              </div>

              {isDownloadingUpdate && (
                <div className="updater-progress">
                  <div className="updater-progress-bar">
                    <div className="updater-progress-fill" style={{ width: `${updateProgress}%` }} />
                  </div>
                  <div className="card-row text-sm text-muted">
                    <span>{updateProgress.toFixed(0)}%</span>
                    <span>{formatBytes(updaterState?.downloadedBytes || 0)} / {formatBytes(updaterState?.totalBytes || 0)}</span>
                  </div>
                </div>
              )}

              {updaterState?.errorMessage && (
                <div className="updater-note updater-note-error">
                  {updaterState.errorMessage}
                </div>
              )}

              {updaterState?.status === 'pending_build' && updaterState?.message && (
                <div className="updater-note updater-note-pending" role="status">
                  {updaterState.message}
                </div>
              )}

              {!updaterState?.supported && updaterState?.message && (
                <div className="updater-note">
                  {updaterState.message}
                </div>
              )}

              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <button className="btn btn-secondary" onClick={checkForUpdates} disabled={isCheckingUpdates || isDownloadingUpdate}>
                  <RefreshCw size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                  {isCheckingUpdates ? 'Checking...' : 'Check now'}
                </button>

                {showManualDownload && (
                  <button className="btn btn-secondary" onClick={downloadUpdate} disabled={isDownloadingUpdate}>
                    <Download size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                    {isDownloadingUpdate ? 'Downloading...' : 'Download update'}
                  </button>
                )}

                {showInstallAction && (
                  <button className="btn btn-primary" onClick={installUpdate}>
                    <RotateCw size={15} strokeWidth={SETTINGS_ICON_STROKE} />
                    Restart and install
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Smile size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Sticker
            </h3>
          </div>
          <div className="card">
            <p className="text-sm text-muted" style={{ margin: '0 0 12px' }}>
              Sticker erstellen, Packs verwalten und Favoriten festlegen.
            </p>
            <Link to="/settings/stickers" className="btn btn-secondary btn-sm">
              Sticker verwalten
            </Link>
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Server size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Application
            </h3>
          </div>
          <div className="card">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Bell size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Windows-Benachrichtigungen
                </span>
                <span>System-Mitteilungen für eingehende Nachrichten. Mehrere in kurzer Zeit werden zu einer Zusammenfassung gruppiert.</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.windowsNotifications ?? true}
                  onChange={(e) => change('windowsNotifications', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Lesebestätigungen senden</span>
                <span>Wenn aus, sehen andere nicht, dass du ihre Nachrichten gelesen hast („Seen“).</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.sendReadReceipts ?? true}
                  onChange={(e) => change('sendReadReceipts', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Testbenachrichtigung</span>
                <span>Prüft, ob Windows eine Mitteilung anzeigen darf (nur wenn Benachrichtigungen oben aktiv sind).</span>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => window.bluetalk?.notify?.show?.({
                  title: 'BlueTalk',
                  body: 'Windows notifications are active.',
                })}
              >
                Test
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Theme</span>
                <span>Switch between light and dark mode</span>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={toggleTheme}>
                {theme === 'dark' ? <Sun size={15} strokeWidth={SETTINGS_ICON_STROKE} /> : <Moon size={15} strokeWidth={SETTINGS_ICON_STROKE} />}
                {theme === 'dark' ? 'Light' : 'Dark'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Minimize to Tray</span>
                <span>Keep running in the background when closed</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.minimizeToTray ?? true}
                  onChange={(e) => change('minimizeToTray', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Power size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Launch at startup
                </span>
                <span>Open BlueTalk automatically when you sign in to this computer</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.launchAtLogin ?? false}
                  onChange={(e) => change('launchAtLogin', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span className="toggle-row-label-with-icon">
                  <Bug size={15} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Debug mode
                </span>
                <span>Show the Network section (addresses, API port, port tests, doctor, config tail)</span>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={local.debugMode ?? false}
                  onChange={(e) => change('debugMode', e.target.checked)}
                />
                <span className="toggle-slider" />
              </label>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Feature flags</span>
                <span>Experimental performance and behavior toggles (search, detail view, descriptions).</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setFeatureFlagsOpen(true)}
              >
                Configure feature flags
              </button>
            </div>
          </div>
        </section>
      </div>

      <FeatureFlagsModal
        open={featureFlagsOpen}
        onClose={() => setFeatureFlagsOpen(false)}
        settings={local}
        updateSettings={updateSettings}
      />
    </div>
  );
}
