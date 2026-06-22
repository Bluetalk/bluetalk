import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import {
  Blocks,
  Copy,
  FolderOpen,
  Package,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';
import { pluginRuntime } from '../plugins/pluginRuntime';

const ICON_STROKE = 1.75;

function clampMenuPosition(x, y, menuW = 240, menuH = 280) {
  const pad = 8;
  const maxX = Math.max(pad, window.innerWidth - menuW - pad);
  const maxY = Math.max(pad, window.innerHeight - menuH - pad);
  return {
    x: Math.min(Math.max(pad, x), maxX),
    y: Math.min(Math.max(pad, y), maxY),
  };
}

export default function PluginsPage() {
  const { toast } = useToast();
  const { settings } = useApp();
  const debugMode = settings.debugMode ?? false;

  const [plugins, setPlugins] = useState(() => pluginRuntime.getPlugins());
  const [busy, setBusy] = useState('');
  const [menu, setMenu] = useState(null);
  const menuRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!window.bluetalk?.plugins) return;
    const list = await window.bluetalk.plugins.list();
    setPlugins(list || []);
  }, []);

  useEffect(() => {
    refresh();
    const off = pluginRuntime.onPluginsChanged((list) => setPlugins(list));
    const offChanged = window.bluetalk?.on?.('plugins:changed', (list) => setPlugins(list || []));
    return () => {
      off?.();
      offChanged?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (!menu) return undefined;

    const close = () => setMenu(null);
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        close();
      }
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [menu]);

  const openPageMenu = (e) => {
    e.preventDefault();
    const { x, y } = clampMenuPosition(e.clientX, e.clientY);
    setMenu({ type: 'page', x, y });
  };

  const openPluginMenu = (e, plugin) => {
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = clampMenuPosition(e.clientX, e.clientY);
    setMenu({ type: 'plugin', plugin, x, y });
  };

  const closeMenu = () => setMenu(null);

  const rescan = async () => {
    if (!window.bluetalk?.plugins) return;
    setBusy('rescan');
    try {
      const list = await window.bluetalk.plugins.rescan();
      setPlugins(list || []);
      toast({
        variant: 'success',
        title: 'Erweiterungen aktualisiert',
        message: `${list?.length || 0} Eintrag${list?.length === 1 ? '' : 'e'} gefunden.`,
      });
    } catch (e) {
      toast({ variant: 'error', title: 'Aktualisieren fehlgeschlagen', message: e?.message || 'Unbekannter Fehler' });
    } finally {
      setBusy('');
      closeMenu();
    }
  };

  const openDir = async () => {
    if (!window.bluetalk?.plugins) return;
    await window.bluetalk.plugins.openDir();
    closeMenu();
  };

  const installFromDialog = async () => {
    if (!window.bluetalk?.plugins) return;
    setBusy('install');
    try {
      const result = await window.bluetalk.plugins.installFromDialog();
      if (result?.ok) {
        toast({
          variant: 'success',
          title: 'Erweiterung hinzugefügt',
          message: `${result.plugin?.manifest?.name || result.plugin?.id} wurde aus Sicherheitsgründen deaktiviert installiert.`,
        });
        refresh();
      } else if (!result?.canceled) {
        toast({ variant: 'error', title: 'Hinzufügen fehlgeschlagen', message: result?.error || 'Unbekannter Fehler' });
      }
    } finally {
      setBusy('');
      closeMenu();
    }
  };

  const reseedBundled = async () => {
    if (!window.bluetalk?.plugins?.reseedBundled) return;
    setBusy('reseed');
    try {
      await window.bluetalk.plugins.reseedBundled();
      await refresh();
      toast({ variant: 'success', title: 'Standard-Erweiterungen wiederhergestellt' });
    } finally {
      setBusy('');
      closeMenu();
    }
  };

  const toggle = async (plugin) => {
    if (!window.bluetalk?.plugins) return;
    if (!plugin.enabled) {
      const name = plugin.manifest?.name || plugin.id;
      const confirmed = window.confirm(
        `„${name}“ aktivieren? Erweiterungen laufen mit Zugriff auf Chats, Kontakte und Netzwerk. Aktiviere nur vertrauenswürdigen Code.`
      );
      if (!confirmed) return;
    }
    setBusy(`toggle:${plugin.id}`);
    try {
      await window.bluetalk.plugins.setEnabled(plugin.id, !plugin.enabled);
      await refresh();
    } finally {
      setBusy('');
      closeMenu();
    }
  };

  const uninstall = async (plugin) => {
    if (!window.bluetalk?.plugins) return;
    const name = plugin.manifest?.name || plugin.id;
    const ok = window.confirm(`„${name}“ wirklich entfernen? Gespeicherte Daten dieser Erweiterung werden gelöscht.`);
    if (!ok) return;
    setBusy(`remove:${plugin.id}`);
    try {
      await window.bluetalk.plugins.uninstall(plugin.id);
      await refresh();
      toast({ variant: 'success', title: 'Erweiterung entfernt', message: name });
    } finally {
      setBusy('');
      closeMenu();
    }
  };

  const copyPluginId = async (plugin) => {
    try {
      await navigator.clipboard.writeText(plugin.id);
      toast({ variant: 'success', title: 'Kopiert', message: 'Erweiterungs-ID in die Zwischenablage.' });
    } catch {
      toast({ variant: 'error', title: 'Kopieren fehlgeschlagen', message: 'Zwischenablage nicht verfügbar.' });
    }
    closeMenu();
  };

  const menuPortal = menu ? ReactDOM.createPortal(
    <div
      ref={menuRef}
      className="chat-list-context-menu plugin-context-menu animate-scale"
      role="menu"
      style={{ left: menu.x, top: menu.y, position: 'fixed', zIndex: 10000 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.type === 'page' ? (
        <>
          <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={installFromDialog} disabled={busy === 'install'}>
            <Plus size={15} strokeWidth={ICON_STROKE} aria-hidden />
            Erweiterung hinzufügen
          </button>
          <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={openDir}>
            <FolderOpen size={15} strokeWidth={ICON_STROKE} aria-hidden />
            Ordner öffnen
          </button>
          <div className="chat-list-context-menu-sep" role="separator" />
          <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={rescan} disabled={busy === 'rescan'}>
            <RefreshCw size={15} strokeWidth={ICON_STROKE} aria-hidden />
            {busy === 'rescan' ? 'Wird aktualisiert…' : 'Neu scannen'}
          </button>
          <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={reseedBundled} disabled={busy === 'reseed'}>
            <Package size={15} strokeWidth={ICON_STROKE} aria-hidden />
            {busy === 'reseed' ? 'Wird wiederhergestellt…' : 'Standard wiederherstellen'}
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="chat-list-context-menu-item"
            role="menuitem"
            onClick={() => toggle(menu.plugin)}
            disabled={busy === `toggle:${menu.plugin.id}`}
          >
            <Power size={15} strokeWidth={ICON_STROKE} aria-hidden />
            {menu.plugin.enabled ? 'Deaktivieren' : 'Aktivieren'}
          </button>
          <button
            type="button"
            className="chat-list-context-menu-item chat-list-context-menu-item--danger"
            role="menuitem"
            onClick={() => uninstall(menu.plugin)}
            disabled={busy === `remove:${menu.plugin.id}`}
          >
            <Trash2 size={15} strokeWidth={ICON_STROKE} aria-hidden />
            {busy === `remove:${menu.plugin.id}` ? 'Wird entfernt…' : 'Entfernen'}
          </button>
          {debugMode ? (
            <>
              <div className="chat-list-context-menu-sep" role="separator" />
              <button type="button" className="chat-list-context-menu-item" role="menuitem" onClick={() => copyPluginId(menu.plugin)}>
                <Copy size={15} strokeWidth={ICON_STROKE} aria-hidden />
                ID kopieren
              </button>
            </>
          ) : null}
        </>
      )}
    </div>,
    document.body
  ) : null;

  return (
    <div className="page page-plugins" onContextMenu={openPageMenu}>
      <div className="page-header">
        <div>
          <h2>
            <Blocks size={18} strokeWidth={ICON_STROKE} />
            Erweiterungen
          </h2>
          <p>
            Füge Spiele, Tools und Extras hinzu. Aktivierte Erweiterungen erscheinen in der Seitenleiste.
          </p>
          {!debugMode ? (
            <p className="plugin-page-hint text-sm text-muted">Rechtsklick für Installation und Verwaltung</p>
          ) : null}
        </div>
        <div className="page-header-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={installFromDialog} disabled={busy === 'install'}>
            <Plus size={15} strokeWidth={ICON_STROKE} />
            {busy === 'install' ? 'Wird hinzugefügt…' : 'Hinzufügen'}
          </button>
          {debugMode ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" onClick={openDir}>
                <FolderOpen size={15} strokeWidth={ICON_STROKE} />
                Ordner
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={rescan} disabled={busy === 'rescan'}>
                <RefreshCw size={15} strokeWidth={ICON_STROKE} />
                {busy === 'rescan' ? 'Scan…' : 'Rescan'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={reseedBundled} disabled={busy === 'reseed'}>
                <Package size={15} strokeWidth={ICON_STROKE} />
                Restore bundled
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={installFromDialog} disabled={busy === 'install'}>
                <Upload size={15} strokeWidth={ICON_STROKE} />
                Install folder
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="plugin-grid">
        {plugins.length === 0 ? (
          <div className="plugin-empty">
            <h3>Noch keine Erweiterungen</h3>
            <p>
              Klicke auf <strong>Hinzufügen</strong> oder nutze den Rechtsklick, um eine Erweiterung zu installieren.
            </p>
          </div>
        ) : null}
        {plugins.map((plugin) => (
          <article
            key={plugin.id}
            className={`plugin-card ${plugin.enabled ? 'is-enabled' : ''}`}
            onContextMenu={(e) => openPluginMenu(e, plugin)}
          >
            <header className="plugin-card-head">
              <div>
                <h4>{plugin.manifest?.name || plugin.id}</h4>
                {debugMode ? (
                  <span className="plugin-card-meta">
                    v{plugin.manifest?.version || '0.0.0'} · {plugin.manifest?.author || 'Unknown author'}
                  </span>
                ) : null}
              </div>
              <label className="toggle" onContextMenu={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={Boolean(plugin.enabled)}
                  onChange={() => toggle(plugin)}
                  disabled={busy === `toggle:${plugin.id}`}
                />
                <span className="toggle-slider" />
              </label>
            </header>
            {plugin.manifest?.description ? (
              <p className="plugin-card-desc">{plugin.manifest.description}</p>
            ) : null}
            {debugMode ? (
              <div className="plugin-card-caps">
                {plugin.hasUi ? <span className="plugin-cap">UI</span> : null}
                {plugin.hasMain ? <span className="plugin-cap">Main</span> : null}
                {Array.isArray(plugin.manifest?.permissions)
                  ? plugin.manifest.permissions.map((perm) => (
                      <span key={perm} className="plugin-cap plugin-cap-perm">{perm}</span>
                    ))
                  : null}
              </div>
            ) : null}
            {plugin.lastError ? (
              <div className="plugin-error-banner" role="alert">
                {debugMode ? plugin.lastError : 'Diese Erweiterung konnte nicht geladen werden.'}
              </div>
            ) : null}
            <footer className="plugin-card-foot">
              {debugMode ? (
                <span className="plugin-card-id">{plugin.id}</span>
              ) : (
                <span className={`plugin-status ${plugin.enabled ? 'plugin-status--on' : ''}`}>
                  {plugin.enabled ? 'Aktiv' : 'Aus'}
                </span>
              )}
              {debugMode ? (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={() => uninstall(plugin)}
                  disabled={busy === `remove:${plugin.id}`}
                >
                  <Trash2 size={14} strokeWidth={ICON_STROKE} />
                  {busy === `remove:${plugin.id}` ? 'Removing…' : 'Uninstall'}
                </button>
              ) : null}
            </footer>
          </article>
        ))}
      </div>

      {menuPortal}
    </div>
  );
}
