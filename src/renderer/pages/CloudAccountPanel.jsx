import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExternalLink, KeyRound, LogOut, RefreshCw, Shield, Trash2, UserRound } from 'lucide-react';
import { createCloudApi } from '../cloudAccount/api.js';
import {
  changePassword,
  commitLiveAccount,
  deleteAccount,
  fullUpload,
  getAccount,
  getSyncState,
  loginAccount,
  logoutAccount,
  onAccountChange,
  onSyncState,
  prepareIdentityTakeover,
  registerAccount,
  startSync,
  stopSync,
  syncNow,
} from '../cloudAccount/index.js';
import { isValidUsername, normalizeUsername } from '../cloudAccount/crypto.js';

const WEB_URL = 'https://bt.henny.dev';

function passwordHint(password) {
  if (!password) return { level: 'empty', label: 'Mindestens 8 Zeichen.' };
  if (password.length < 8) return { level: 'weak', label: 'Zu kurz — mindestens 8 Zeichen.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3 && password.length >= 12) return { level: 'strong', label: 'Starkes Passwort.' };
  if (classes >= 2) return { level: 'ok', label: 'In Ordnung, länger ist besser.' };
  return { level: 'weak', label: 'Bitte Buchstaben und Zahlen mischen.' };
}

function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClock(ts) {
  if (!ts) return 'Noch nie';
  try {
    return new Date(ts).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  } catch {
    return '—';
  }
}

function shortenPeerId(id) {
  if (!id) return '';
  const prefix = id.startsWith('bt2_') ? 'bt2_' : '';
  const body = prefix ? id.slice(4) : id;
  if (body.length <= 12) return id;
  return `${prefix}${body.slice(0, 8)}…${body.slice(-4)}`;
}

function syncLabel(sync) {
  if (sync.state === 'syncing') return 'Synchronisiert…';
  if (sync.state === 'error') return 'Fehler';
  if (sync.state === 'idle') return 'Bereit';
  return 'Aus';
}

export default function CloudAccountPanel({ toast, localPeerId }) {
  const [ownPeerId, setOwnPeerId] = useState(localPeerId || '');
  const [account, setAccount] = useState(null);
  const [sync, setSync] = useState(() => getSyncState());
  const [tab, setTab] = useState('register');
  const [busy, setBusy] = useState('');
  const [formError, setFormError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [usage, setUsage] = useState(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [confirm, setConfirm] = useState(null);

  const strength = useMemo(() => passwordHint(tab === 'register' ? password : ''), [tab, password]);
  const newStrength = useMemo(() => passwordHint(newPw), [newPw]);

  const refreshUsage = useCallback(async () => {
    const current = await getAccount();
    if (!current) {
      setUsage(null);
      return;
    }
    try {
      const api = createCloudApi(current.baseUrl, () => current.token);
      const me = await api.me();
      setUsage(me);
    } catch {
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    if (localPeerId) setOwnPeerId(localPeerId);
  }, [localPeerId]);

  useEffect(() => {
    let cancelled = false;
    void window.bluetalk?.peer?.getInfo?.().then((info) => {
      if (!cancelled && info?.id) setOwnPeerId(info.id);
    }).catch(() => {});
    void getAccount().then((next) => {
      if (!cancelled) setAccount(next);
    });
    const offAccount = onAccountChange((next) => {
      if (!cancelled) setAccount(next);
    });
    const offSync = onSyncState((next) => {
      if (!cancelled) setSync(next);
    });
    setSync(getSyncState());
    return () => {
      cancelled = true;
      offAccount();
      offSync();
    };
  }, []);

  useEffect(() => {
    if (account) void refreshUsage();
    else setUsage(null);
  }, [account, refreshUsage]);

  const clearSecrets = () => {
    setPassword('');
    setPassword2('');
    setOldPw('');
    setNewPw('');
    setNewPw2('');
  };

  const run = async (key, fn) => {
    if (busy) return;
    setBusy(key);
    setFormError('');
    try {
      await fn();
    } catch (error) {
      setFormError(error?.message || 'Aktion fehlgeschlagen.');
    } finally {
      setBusy('');
    }
  };

  const afterAuth = async (nextAccount, vault, { isRegister }) => {
    clearSecrets();
    if (isRegister) {
      await startSync();
      await fullUpload();
      toast?.({ variant: 'success', title: 'Konto erstellt', message: 'Nachrichten werden Ende-zu-Ende verschlüsselt synchronisiert.' });
      await refreshUsage();
      return;
    }
    const remotePeer = nextAccount?.peerId || '';
    if (remotePeer && ownPeerId && remotePeer !== ownPeerId) {
      setConfirm({
        kind: 'identity',
        vault,
        peerId: remotePeer,
      });
      return;
    }
    await startSync();
    toast?.({ variant: 'success', title: 'Angemeldet', message: 'Cloud-Sync ist aktiv.' });
    await refreshUsage();
  };

  const submitRegister = () => run('register', async () => {
    const name = normalizeUsername(username);
    if (!isValidUsername(name)) throw new Error('Benutzername: 3–32 Zeichen, nur a–z, 0–9, _ . -');
    if (password !== password2) throw new Error('Passwörter stimmen nicht überein.');
    if (password.length < 8) throw new Error('Passwort muss mindestens 8 Zeichen haben.');
    const exported = await window.bluetalk?.account?.exportIdentity?.();
    const e2eeIdentity = await window.bluetalk?.store?.get?.('e2eeIdentity', null);
    if (!exported?.seedB64 || !e2eeIdentity) throw new Error('Lokale Identität ist noch nicht bereit.');
    const next = await registerAccount({
      username: name,
      password,
      identity: { networkSeedB64: exported.seedB64, e2eeIdentity },
    });
    await afterAuth(next, null, { isRegister: true });
  });

  const submitLogin = () => run('login', async () => {
    const result = await loginAccount({ username, password });
    await afterAuth(result.account, result.vault, { isRegister: false });
  });

  const adoptIdentity = () => run('adopt', async () => {
    const vault = confirm?.vault;
    setConfirm(null);
    if (!vault?.networkSeed || !vault?.e2eeIdentity) throw new Error('Tresor unvollständig.');
    stopSync();
    await commitLiveAccount();
    await prepareIdentityTakeover();
    await window.bluetalk.store.set('e2eeIdentity', vault.e2eeIdentity);
    toast?.({ variant: 'info', title: 'Identität wird übernommen', message: 'BlueTalk startet neu.' });
    await window.bluetalk.account.importIdentity(vault.networkSeed);
  });

  const doLogout = () => run('logout', async () => {
    stopSync();
    await logoutAccount();
    if (__BLUETALK_WEB__) {
      try {
        localStorage.removeItem('bluetalk-web-stay');
        sessionStorage.removeItem('bluetalk-web-alive');
      } catch {
        /* ignore */
      }
      await window.bluetalk?.app?.wipeAllData?.();
      window.location.reload();
      return;
    }
    toast?.({ variant: 'success', title: 'Abgemeldet', message: 'Dieses Gerät ist nicht mehr mit dem Konto verbunden.' });
  });

  const doChangePassword = () => run('password', async () => {
    if (newPw !== newPw2) throw new Error('Neue Passwörter stimmen nicht überein.');
    await changePassword(oldPw, newPw);
    clearSecrets();
    setPwOpen(false);
    toast?.({ variant: 'success', title: 'Passwort geändert', message: 'Andere Geräte müssen sich neu anmelden.' });
  });

  const doDelete = () => run('delete', async () => {
    const pw = confirm?.password || '';
    setConfirm(null);
    stopSync();
    await deleteAccount(pw);
    toast?.({ variant: 'success', title: 'Konto gelöscht', message: 'Cloud-Daten wurden entfernt.' });
  });

  const openWeb = async () => {
    try {
      if (window.bluetalk?.app?.openUrl) {
        await window.bluetalk.app.openUrl(WEB_URL);
        return;
      }
    } catch {
      /* Fallback */
    }
    toast?.({ variant: 'info', title: 'BlueTalk Web', message: WEB_URL });
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Konto</h2>

      {!account ? (
        <div className="card cloud-account-card">
          <div className="cloud-account-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'register'}
              className={`cloud-account-tab${tab === 'register' ? ' is-active' : ''}`}
              onClick={() => { setTab('register'); setFormError(''); }}
            >
              Konto erstellen
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'login'}
              className={`cloud-account-tab${tab === 'login' ? ' is-active' : ''}`}
              onClick={() => { setTab('login'); setFormError(''); }}
            >
              Anmelden
            </button>
          </div>

          <p className="cloud-account-privacy">
            <Shield size={14} strokeWidth={1.75} aria-hidden />
            Ende-zu-Ende verschlüsselt. Der Server sieht weder Passwort noch Nachrichten. Das Passwort kann nicht wiederhergestellt werden.
          </p>

          <div className="input-group">
            <label htmlFor="cloud-username">Benutzername</label>
            <input
              id="cloud-username"
              className="input"
              autoComplete="username"
              spellCheck={false}
              autoCapitalize="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="z. B. anna"
            />
          </div>
          <div className="input-group">
            <label htmlFor="cloud-password">Passwort</label>
            <input
              id="cloud-password"
              className="input"
              type="password"
              autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {tab === 'register' ? (
            <>
              <div className="input-group">
                <label htmlFor="cloud-password2">Passwort wiederholen</label>
                <input
                  id="cloud-password2"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={password2}
                  onChange={(event) => setPassword2(event.target.value)}
                />
              </div>
              <p className={`cloud-account-strength is-${strength.level}`}>{strength.label}</p>
            </>
          ) : null}

          {formError ? <p className="cloud-sync-error" role="alert">{formError}</p> : null}

          <div className="cloud-sync-actions">
            {tab === 'register' ? (
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void submitRegister()}>
                {busy === 'register' ? 'Erstellt…' : 'Konto erstellen'}
              </button>
            ) : (
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void submitLogin()}>
                {busy === 'login' ? 'Meldet an…' : 'Anmelden'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="card cloud-account-card">
          <div className="cloud-account-identity">
            <div className="cloud-account-avatar" aria-hidden>
              <UserRound size={18} strokeWidth={1.75} />
            </div>
            <div className="cloud-account-copy">
              <div className="cloud-account-name">{account.username}</div>
              <code className="cloud-sync-peer-id" title={account.peerId}>{shortenPeerId(account.peerId)}</code>
            </div>
          </div>

          <div className="cloud-account-sync-row">
            <div>
              <div className="cloud-account-sync-state">{syncLabel(sync)}</div>
              <p className="text-muted cloud-account-sync-meta">
                Zuletzt: {formatClock(sync.lastSyncAt)}
                {sync.pending ? ` · ${sync.pending} ausstehend` : ''}
              </p>
              {sync.error ? <p className="cloud-sync-error">{sync.error}</p> : null}
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy === 'sync'}
              onClick={() => run('sync', async () => {
                await syncNow();
                await refreshUsage();
              })}
            >
              <RefreshCw size={14} strokeWidth={1.75} />
              Jetzt synchronisieren
            </button>
          </div>

          {usage?.usage && usage?.quota ? (
            <div className="cloud-account-quota">
              <div className="cloud-account-quota-bar" aria-hidden>
                <span style={{ width: `${Math.min(100, (Number(usage.usage.bytes) / Math.max(1, Number(usage.quota.bytes))) * 100)}%` }} />
              </div>
              <p className="text-muted">
                Speicher: {formatBytes(usage.usage.bytes)} von {formatBytes(usage.quota.bytes)}
                {typeof usage.usage.items === 'number' ? ` · ${usage.usage.items} Einträge` : ''}
              </p>
            </div>
          ) : null}

          {pwOpen ? (
            <div className="cloud-account-password">
              <div className="input-group">
                <label htmlFor="cloud-old-pw">Aktuelles Passwort</label>
                <input id="cloud-old-pw" className="input" type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
              </div>
              <div className="input-group">
                <label htmlFor="cloud-new-pw">Neues Passwort</label>
                <input id="cloud-new-pw" className="input" type="password" autoComplete="new-password" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
              </div>
              <div className="input-group">
                <label htmlFor="cloud-new-pw2">Neues Passwort wiederholen</label>
                <input id="cloud-new-pw2" className="input" type="password" autoComplete="new-password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
              </div>
              <p className={`cloud-account-strength is-${newStrength.level}`}>{newStrength.label}</p>
              <div className="cloud-sync-actions">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPwOpen(false); clearSecrets(); }}>Abbrechen</button>
                <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => void doChangePassword()}>
                  Speichern
                </button>
              </div>
            </div>
          ) : null}

          {formError ? <p className="cloud-sync-error" role="alert">{formError}</p> : null}

          <div className="cloud-sync-actions">
            {!pwOpen ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPwOpen(true)}>
                <KeyRound size={14} strokeWidth={1.75} />
                Passwort ändern
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void doLogout()}>
              <LogOut size={14} strokeWidth={1.75} />
              Abmelden
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() => setConfirm({ kind: 'delete', password: '' })}
            >
              <Trash2 size={14} strokeWidth={1.75} />
              Konto löschen
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void openWeb()}>
              <ExternalLink size={14} strokeWidth={1.75} />
              BlueTalk Web öffnen
            </button>
          </div>
        </div>
      )}

      {confirm?.kind === 'identity' ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cloud-id-title">
          <div className="modal modal-danger">
            <h3 id="cloud-id-title">Identität übernehmen?</h3>
            <p className="text-muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Dieses Konto gehört zu einer anderen Peer-ID. Diese Installation übernimmt die Identität deines Kontos. Die bisherige Peer-ID dieses Geräts wird ersetzt, und BlueTalk startet neu.
            </p>
            <p className="cloud-sync-peer-id" style={{ marginTop: 10 }}>{shortenPeerId(confirm.peerId)}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setConfirm(null); stopSync(); void logoutAccount(); }}>Abbrechen</button>
              <button type="button" className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void adoptIdentity()}>
                Identität übernehmen
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirm?.kind === 'delete' ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="cloud-del-title">
          <div className="modal modal-danger">
            <h3 id="cloud-del-title">Konto unwiderruflich löschen?</h3>
            <p className="text-muted" style={{ marginTop: 8, lineHeight: 1.5 }}>
              Konto, Tokens und Cloud-Sync-Daten werden gelöscht. Lokal bleiben Chats auf diesem Gerät.
            </p>
            <div className="input-group" style={{ marginTop: 12 }}>
              <label htmlFor="cloud-del-pw">Passwort zur Bestätigung</label>
              <input
                id="cloud-del-pw"
                className="input"
                type="password"
                autoComplete="current-password"
                value={confirm.password}
                onChange={(event) => setConfirm({ ...confirm, password: event.target.value })}
              />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>Abbrechen</button>
              <button type="button" className="btn btn-danger" disabled={Boolean(busy) || !confirm.password} onClick={() => void doDelete()}>
                Endgültig löschen
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
