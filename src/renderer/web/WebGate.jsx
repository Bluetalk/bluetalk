import React, { useEffect, useMemo, useState } from 'react';
import { LogIn, UserPlus, ShieldAlert, Shield } from 'lucide-react';
import { generateIdentity } from '../../bridge/webBridge/peerProtocol/index.js';
import { clearStayFlags, setStayLoggedIn } from '../../bridge/webBridge/persistFlags.js';
import { exportSpkiPublic, generateEcdhKeyPair } from '../chatCrypto';
import {
  fullUpload,
  getAccount,
  loginAccount,
  logoutAccount,
  onAccountChange,
  onSyncState,
  registerAccount,
  startSync,
  stopSync,
} from '../cloudAccount';
import logoUrl from '../../../assets/icon.svg?url';
import './WebGate.css';

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

function passwordHint(password) {
  if (!password) return { level: 'empty', label: 'Mindestens 8 Zeichen.' };
  if (password.length < 8) return { level: 'weak', label: 'Zu kurz — mindestens 8 Zeichen.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes >= 3 && password.length >= 12) return { level: 'strong', label: 'Starkes Passwort.' };
  if (classes >= 2) return { level: 'ok', label: 'In Ordnung, länger ist besser.' };
  return { level: 'weak', label: 'Bitte Buchstaben und Zahlen mischen.' };
}

async function createE2eeIdentity() {
  const pair = await generateEcdhKeyPair();
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicSpkiB64: await exportSpkiPublic(pair.publicKey),
  };
}

async function adoptVault(vault) {
  const seedB64 = vault?.networkSeed || vault?.networkSeedB64;
  if (!seedB64 || !vault?.e2eeIdentity) {
    throw new Error('Tresor unvollständig.');
  }
  await window.bluetalk.store.set('networkIdentity', { seedB64 });
  await window.bluetalk.store.set('e2eeIdentity', vault.e2eeIdentity);
  window.dispatchEvent(new Event('bluetalk:web-identity-ready'));
}

function mapError(error) {
  const text = error?.message || String(error || '');
  if (/username_taken/i.test(text)) return 'Dieser Benutzername ist bereits vergeben.';
  if (/peer_taken/i.test(text)) return 'Diese Identität ist bereits mit einem Konto verknüpft.';
  if (/invalid_credentials/i.test(text)) return 'Benutzername oder Passwort stimmt nicht.';
  if (/rate/i.test(text)) return 'Zu viele Versuche. Bitte kurz warten.';
  if (/invalid/i.test(text)) return 'Eingabe ungültig.';
  return text || 'Anmeldung fehlgeschlagen.';
}

async function signOutAndWipe() {
  try {
    stopSync?.();
  } catch {
    /* ignore */
  }
  try {
    await logoutAccount?.();
  } catch {
    /* lokal trotzdem leeren */
  }
  try {
    await window.bluetalk?.app?.wipeAllData?.();
  } catch {
    /* ignore */
  }
  clearStayFlags();
  window.location.reload();
}

export default function WebGate({ children }) {
  const [account, setAccount] = useState(null);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [stayLoggedIn, setStay] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replaced, setReplaced] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('bluetalk-web');
    return undefined;
  }, []);

  useEffect(() => {
    let cancelled = false;
    getAccount().then((next) => {
      if (!cancelled) setAccount(next || null);
    }).catch(() => {
      if (!cancelled) setAccount(null);
    });
    const off = onAccountChange((next) => setAccount(next || null));
    const offSync = onSyncState?.((sync) => {
      if (sync?.state === 'off' && /Sitzung ungültig|Abgemeldet/i.test(sync?.error || '')) {
        setAccount(null);
        setReady(false);
      }
    });
    return () => {
      cancelled = true;
      off?.();
      offSync?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = account || await getAccount();
        if (!current) {
          if (!cancelled) setReady(false);
          return;
        }
        const identity = await window.bluetalk.store.get('networkIdentity', null);
        if (!identity?.seedB64) {
          if (!cancelled) setReady(false);
          return;
        }
        await startSync?.();
        if (!cancelled) setReady(true);
      } catch {
        if (!cancelled) setReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account]);

  useEffect(() => {
    if (!ready) return undefined;
    const ask = () => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    };
    window.addEventListener('pointerdown', ask, { once: true });
    return () => window.removeEventListener('pointerdown', ask);
  }, [ready]);

  useEffect(() => {
    if (!window.bluetalk?.cloud?.onStatus) return undefined;
    const off = window.bluetalk.cloud.onStatus((status) => {
      setReplaced(status?.state === 'replaced');
    });
    window.bluetalk.cloud.getStatus?.().then((status) => {
      setReplaced(status?.state === 'replaced');
    }).catch(() => {});
    return () => off?.();
  }, [ready]);

  const normalizedUser = useMemo(() => username.trim().toLowerCase(), [username]);
  const usernameOk = USERNAME_RE.test(normalizedUser);
  const passwordOk = password.length >= 8;
  const strength = useMemo(() => passwordHint(password), [password]);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (!usernameOk) {
      setError('Benutzername: 3–32 Zeichen, nur a–z, 0–9, _ . -');
      return;
    }
    if (!passwordOk) {
      setError('Passwort mindestens 8 Zeichen.');
      return;
    }
    if (mode === 'register' && password !== password2) {
      setError('Passwörter stimmen nicht überein.');
      return;
    }
    setBusy(true);
    try {
      setStayLoggedIn(stayLoggedIn);
      if (mode === 'register') {
        const network = generateIdentity();
        const e2eeIdentity = await createE2eeIdentity();
        await registerAccount({
          username: normalizedUser,
          password,
          identity: { networkSeedB64: network.seedB64, e2eeIdentity },
        });
        await adoptVault({ networkSeed: network.seedB64, e2eeIdentity });
        await fullUpload?.();
      } else {
        const result = await loginAccount({ username: normalizedUser, password });
        await adoptVault(result.vault);
      }
      setPassword('');
      setPassword2('');
      await startSync?.();
      setReady(true);
    } catch (err) {
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const takeover = async () => {
    setBusy(true);
    try {
      if (window.bluetalk.cloud.takeover) {
        await window.bluetalk.cloud.takeover();
      } else {
        const status = await window.bluetalk.cloud.getStatus();
        await window.bluetalk.cloud.setConfig({
          enabled: true,
          relayUrl: status?.relayUrl,
        });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    if (account && !error && busy) {
      return (
        <div className="web-gate-loading">
          <span className="spinner spinner--md" />
          <span>Schlüssel werden abgeleitet…</span>
        </div>
      );
    }
    return (
      <div className="web-gate">
        <div className="web-gate-card">
          <div className="web-gate-brand">
            <img src={logoUrl} alt="" className="web-gate-logo" width={48} height={48} />
            <h1>BlueTalk</h1>
            <p>
              BlueTalk Web ist der Browser-Client für deine Ende-zu-Ende verschlüsselten Chats —
              dieselbe Person wie in der Desktop-App, ohne Installation.
            </p>
          </div>
          <div className="web-gate-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`web-gate-tab${mode === 'login' ? ' is-active' : ''}`}
              onClick={() => { setMode('login'); setError(''); }}
            >
              Anmelden
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`web-gate-tab${mode === 'register' ? ' is-active' : ''}`}
              onClick={() => { setMode('register'); setError(''); }}
            >
              Konto erstellen
            </button>
          </div>
          <form className="web-gate-form" onSubmit={submit}>
            <div className="input-group">
              <label htmlFor="web-username">Benutzername</label>
              <input
                id="web-username"
                className="input"
                autoComplete="username"
                autoCapitalize="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                spellCheck={false}
              />
            </div>
            <div className="input-group">
              <label htmlFor="web-password">Passwort</label>
              <input
                id="web-password"
                className="input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {mode === 'register' ? (
              <>
                <div className="input-group">
                  <label htmlFor="web-password2">Passwort wiederholen</label>
                  <input
                    id="web-password2"
                    className="input"
                    type="password"
                    autoComplete="new-password"
                    value={password2}
                    onChange={(event) => setPassword2(event.target.value)}
                  />
                </div>
                <p className={`cloud-account-strength is-${strength.level}`}>{strength.label}</p>
                <p className="web-gate-privacy">
                  <Shield size={14} strokeWidth={1.75} aria-hidden />
                  Passwort kann nicht wiederhergestellt werden — Ende-zu-Ende verschlüsselt.
                  Der Server sieht weder Passwort noch Nachrichten.
                </p>
              </>
            ) : null}
            <label className="web-gate-stay">
              <input
                type="checkbox"
                checked={stayLoggedIn}
                onChange={(event) => setStay(event.target.checked)}
              />
              <span>Angemeldet bleiben</span>
            </label>
            {error ? <p className="web-gate-error" role="alert">{error}</p> : null}
            <button type="submit" className="btn btn-primary web-gate-submit" disabled={busy}>
              {mode === 'login' ? <LogIn size={15} aria-hidden /> : <UserPlus size={15} aria-hidden />}
              {busy ? 'Schlüssel werden abgeleitet…' : mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
            </button>
          </form>
          <p className="web-gate-hint">
            Bereits BlueTalk auf dem PC? Melde dich dort unter BlueTalk Cloud an, dann bist du hier dieselbe Person.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}
      {replaced ? (
        <div className="web-replaced">
          <div className="web-replaced-card">
            <img src={logoUrl} alt="" className="web-gate-logo" width={48} height={48} />
            <ShieldAlert size={28} aria-hidden />
            <h2>BlueTalk ist auf einem anderen Gerät aktiv</h2>
            <p>
              Nur ein Gerät gleichzeitig. Diese Sitzung wurde ersetzt, weil du dich woanders angemeldet hast.
              „Hier verwenden“ trennt das andere Gerät und setzt die Chats hier fort.
            </p>
            <div className="web-replaced-actions">
              <button type="button" className="btn btn-primary" onClick={() => void takeover()} disabled={busy}>
                Hier verwenden
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => void signOutAndWipe()}>
                Abmelden
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export { signOutAndWipe };
