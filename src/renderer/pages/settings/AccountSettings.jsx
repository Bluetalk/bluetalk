import React, { useEffect, useRef, useState } from 'react';
import { Trash2, User } from 'lucide-react';
import { useApp } from '../../App';
import { useToast } from '../../components/ToastProvider';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

const MAX_AVATAR_BYTES = 380 * 1024;

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Keine Bilddatei'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      reject(new Error(`Bitte ein Bild unter ${Math.round(MAX_AVATAR_BYTES / 1024)} KB verwenden`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Lesen fehlgeschlagen'));
    reader.readAsDataURL(file);
  });
}

export default function AccountSettingsPage() {
  const { toast } = useToast();
  const { settings, updateSettings } = useApp();

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
        title: 'Profilbild',
        message: err.message || 'Dieses Bild konnte nicht verwendet werden.',
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
      'Browser-Cache und Web-Speicher der App (localStorage usw.) leeren? Deine Chats und Einstellungen bleiben auf der Festplatte, bis du sie separat löschst.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.clearCache();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'Cache geleert',
        message: 'Temporäre Web-Daten wurden entfernt.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Cache konnte nicht geleert werden',
        message: result?.error || 'Unbekannter Fehler',
      });
    }
  });

  const clearChatHistoryOnly = () => runDataAction('messages', async () => {
    const ok = window.confirm(
      'Alle gespeicherten Chat-Nachrichten und Lesebestätigungen löschen? Kontakte und Einstellungen bleiben erhalten.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.clearMessages();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'Chats geleert',
        message: 'Alle gespeicherten Nachrichten wurden entfernt.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Chats konnten nicht geleert werden',
        message: result?.error || 'Unbekannter Fehler',
      });
    }
  });

  const wipeAllAppData = () => runDataAction('wipe', async () => {
    const ok = window.confirm(
      'ALLE lokalen BlueTalk-Daten löschen (Chats, Kontakte, Einstellungen, Identität)? Das kann nicht rückgängig gemacht werden. Die App lädt danach dein leeres Profil.'
    );
    if (!ok) return;

    const result = await window.bluetalk.app.wipeAllData();
    if (result?.ok) {
      toast({
        variant: 'success',
        title: 'Alle Daten gelöscht',
        message: 'Der lokale Speicher wurde zurückgesetzt. Du erhältst eventuell eine neue Peer-ID.',
      });
    } else {
      toast({
        variant: 'error',
        title: 'Löschen fehlgeschlagen',
        message: result?.error || 'Unbekannter Fehler',
      });
    }
  });

  return (
    <div className="page">
      <SettingsBackHeader
        title="Konto"
        subtitle="Profil, Identität und lokale Daten"
        icon={User}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <User size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Profil
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
                  Foto ändern
                </button>
                {local.profilePicture ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => change('profilePicture', '')}>
                    Entfernen
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
              <label htmlFor="account-display-name">Anzeigename</label>
              <p className="text-sm text-muted" style={{ margin: '0 0 8px' }}>
                So erscheinst du bei anderen.
              </p>
              <input
                id="account-display-name"
                className="input"
                value={local.displayName || ''}
                onChange={(e) => change('displayName', e.target.value)}
                placeholder="Dein Name"
              />
            </div>
            <div className="input-group">
              <label htmlFor="account-bio">Bio</label>
              <textarea
                id="account-bio"
                className="input profile-menu-bio"
                rows={3}
                placeholder="Eine kurze Zeile über dich…"
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
              Identität
            </h3>
          </div>
          <div className="card flex flex-col gap-3">
            {peerInfo ? (
              <div className="input-group">
                <label>Peer ID</label>
                <input className="input font-mono" value={peerInfo.id || ''} readOnly style={{ color: 'var(--fg-2)' }} />
              </div>
            ) : (
              <p className="text-sm text-muted" style={{ margin: 0 }}>Peer-Informationen werden geladen…</p>
            )}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-title">
            <h3>
              <span className="section-title-icon" aria-hidden>
                <Trash2 size={15} strokeWidth={SETTINGS_ICON_STROKE} />
              </span>
              Daten &amp; Speicher
            </h3>
          </div>
          <div className="card flex flex-col gap-0">
            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Cache leeren</span>
                <span>Entfernt den Chromium-Festplatten-Cache und Web-Speicher dieses Fensters. Deine Chat-Verlaufsdatei bleibt erhalten.</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={clearAppCache}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'cache' ? 'Läuft…' : 'Cache leeren'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Alle Chats löschen</span>
                <span>Löscht alle gespeicherten Nachrichten und Lesebestätigungen. Kontakte und Einstellungen bleiben erhalten.</span>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={clearChatHistoryOnly}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'messages' ? 'Läuft…' : 'Chats löschen'}
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-row-info">
                <span>Alle lokalen Daten löschen</span>
                <span>Löscht die Konfigurationsdatei (Chats, Kontakte, Einstellungen) und weist eine neue Peer-Identität zu. Nur für einen sauberen Neustart verwenden.</span>
              </div>
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={wipeAllAppData}
                disabled={Boolean(dataAction)}
              >
                {dataAction === 'wipe' ? 'Läuft…' : 'Alles löschen'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
