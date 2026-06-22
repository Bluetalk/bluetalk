import React, { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Trash2, User } from 'lucide-react';
import { useApp } from '../../App';
import { useToast } from '../../components/ToastProvider';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
import { useRequireSettingsHub } from './useRequireSettingsHub';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

const MAX_AVATAR_BYTES = 380 * 1024;

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Not an image'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      reject(new Error(`Use an image under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

export default function AccountSettingsPage() {
  const { toast } = useToast();
  const { settings, updateSettings } = useApp();
  const settingsHub = useRequireSettingsHub();

  const [peerInfo, setPeerInfo] = useState(null);
  const [local, setLocal] = useState(settings);
  const [dataAction, setDataAction] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    setLocal(settings);
  }, [settings]);

  useEffect(() => {
    const fetchInfo = async () => {
      if (!window.bluetalk) return;
      const info = await window.bluetalk.peer.getInfo();
      setPeerInfo(info);
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

  const initial = (local.displayName || '?')[0].toUpperCase();

  const onAvatarPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageDataUrl(file);
      change('profilePicture', dataUrl);
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Profile photo',
        message: err.message || 'Could not use this image.',
      });
    }
  };

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

  return (
    <div className="page">
      <SettingsBackHeader
        title="Account"
        subtitle="Profile, identity, and local data"
        icon={User}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <User size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Profile
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            <div className="profile-menu-avatar-row">
              {local.profilePicture ? (
                <img src={local.profilePicture} alt="" className="profile-menu-preview" />
              ) : (
                <div className="profile-menu-preview profile-menu-preview-placeholder">{initial}</div>
              )}
              <div className="profile-menu-avatar-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
                  Change photo
                </button>
                {local.profilePicture ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => change('profilePicture', '')}>
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={onAvatarPick}
              />
            </div>
            <div className="input-group">
              <label htmlFor="account-display-name">Display name</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                This is how you appear to others.
              </p>
              <input
                id="account-display-name"
                className="input"
                value={local.displayName || ''}
                onChange={(e) => change('displayName', e.target.value)}
                placeholder="Your name"
              />
            </div>
            <div className="input-group">
              <label htmlFor="account-bio">Bio</label>
              <textarea
                id="account-bio"
                className="input profile-menu-bio"
                rows={3}
                placeholder="A short line about you…"
                value={local.bio || ''}
                maxLength={500}
                onChange={(e) => change('bio', e.target.value)}
              />
            </div>
          </div>
        </section>

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
      </div>
    </div>
  );
}
