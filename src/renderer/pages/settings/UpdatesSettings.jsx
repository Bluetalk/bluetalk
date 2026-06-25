import React, { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, RefreshCw, RotateCw } from 'lucide-react';
import { useApp } from '../../App';
import { APP_VERSION } from '../../appVersion';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
import {
  formatBytes,
  formatDateTime,
  getUpdateBadgeClass,
  getUpdateStatusLabel,
  SETTINGS_ICON_STROKE,
} from './settingsUtils';

export default function UpdatesSettingsPage() {
  const { settings, updateSettings } = useApp();
  const [local, setLocal] = useState(settings);
  const [updaterState, setUpdaterState] = useState(null);
  const [updateAction, setUpdateAction] = useState('');

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

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
      <SettingsBackHeader
        title="Updates"
        subtitle="Automatic checks, downloads, and installs"
        icon={ArrowUpCircle}
      />

      <div className="page-body">
        <section className="settings-section">
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
      </div>
    </div>
  );
}
