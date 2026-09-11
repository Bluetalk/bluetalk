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
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';
import { pluginRuntime } from '../plugins/pluginRuntime';

const ICON_STROKE = 1.75;

// Rohe Permission-Codes aus dem Manifest in menschenlesbare Labels übersetzen.
const PERMISSION_LABELS = {
  'peer:send': 'Nachrichten senden',
  'peer:sendmany': 'Nachrichten senden',
  'peer:broadcast': 'An alle senden',
  'peer:connect': 'Verbindungen aufbauen',
  'chat:send': 'Chat-Nachrichten senden',
  'chat:delete': 'Nachrichten löschen',
  'contacts:read': 'Kontakte lesen',
  'contacts:write': 'Kontakte ändern',
  'ui:tab': 'Sidebar-Tab',
  'ui:screen': 'Eigene Ansichten',
  'ui:composer': 'Composer-Aktion',
  notify: 'Benachrichtigungen',
  storage: 'Lokaler Speicher',
};

function humanizePermission(code) {
  const key = String(code).toLowerCase().trim();
  if (PERMISSION_LABELS[key]) return PERMISSION_LABELS[key];
  const cleaned = key.replace(/[:._-]+/g, ' ').trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : code;
}

// Deduplizierte, menschenlesbare Berechtigungen einer Erweiterung.
function describePermissions(plugin) {
  const perms = Array.isArray(plugin.manifest?.permissions) ? plugin.manifest.permissions : [];
  const seen = new Set();
  const out = [];
  for (const raw of perms) {
    const label = humanizePermission(raw);
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ code: String(raw), label });
  }
  return out;
}

function pluginInitial(plugin) {
  const name = String(plugin.manifest?.name || plugin.id || '?').trim();
  return (name[0] || '?').toUpperCase();
}

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
  const [search, setSearch] = useState('');
  const menuRef = useRef(null);

  const query = search.trim().toLowerCase();
  const visiblePlugins = query
    ? plugins.filter((plugin) =>
        `${plugin.manifest?.name || ''} ${plugin.manifest?.description || ''} ${plugin.id}`
          .toLowerCase()
          .includes(query)
      )
    : plugins;

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
    <div className="page page-inset page-plugins" onContextMenu={openPageMenu}>
      <div className="page-shell">
        <header className="page-shell-header">
          <div className="page-shell-copy">
            <h1>Erweiterungen</h1>
            <p>Spiele, Tools und Extras. Aktivierte Einträge erscheinen in der Seitenleiste.</p>
          </div>
          <div className="page-shell-actions">
            {debugMode ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon btn-sm"
                  onClick={openDir}
                  title="Ordner öffnen"
                  aria-label="Ordner öffnen"
                >
                  <FolderOpen size={15} strokeWidth={ICON_STROKE} />
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon btn-sm"
                  onClick={rescan}
                  disabled={busy === 'rescan'}
                  title="Erneut scannen"
                  aria-label="Erneut scannen"
                >
                  <RefreshCw size={15} strokeWidth={ICON_STROKE} className={busy === 'rescan' ? 'page-shell-spin is-spinning' : undefined} />
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-icon btn-sm"
                  onClick={reseedBundled}
                  disabled={busy === 'reseed'}
                  title="Standard wiederherstellen"
                  aria-label="Standard wiederherstellen"
                >
                  <Package size={15} strokeWidth={ICON_STROKE} />
                </button>
              </>
            ) : null}
            <button type="button" className="btn btn-primary btn-sm" onClick={installFromDialog} disabled={busy === 'install'}>
              <Plus size={15} strokeWidth={ICON_STROKE} />
              {busy === 'install' ? 'Wird hinzugefügt…' : 'Hinzufügen'}
            </button>
          </div>
        </header>

        <div className="page-shell-search">
          <div className="search-bar">
            <Search size={14} strokeWidth={ICON_STROKE} aria-hidden />
            <input
              className="input"
              placeholder="Erweiterungen durchsuchen…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="search-bar-clear"
                aria-label="Suche zurücksetzen"
                onClick={() => setSearch('')}
              >
                <X size={13} strokeWidth={ICON_STROKE} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div className="page-shell-body">
          <div className="plugin-grid">
          {plugins.length === 0 ? (
            <div className="page-empty">
              <Blocks size={28} strokeWidth={ICON_STROKE} aria-hidden />
              <p className="empty-state-title">Noch keine Erweiterungen</p>
              <p>Klicke auf Hinzufügen oder nutze den Rechtsklick, um eine Erweiterung zu installieren.</p>
            </div>
          ) : null}
          {plugins.length > 0 && visiblePlugins.length === 0 ? (
            <div className="page-empty">
              <Search size={28} strokeWidth={ICON_STROKE} aria-hidden />
              <p className="empty-state-title">Keine Treffer</p>
              <p>Keine Erweiterung passt zur Suche.</p>
            </div>
          ) : null}
        {visiblePlugins.map((plugin) => {
          const permissions = describePermissions(plugin);
          const extraPerms = Math.max(0, permissions.length - 3);
          const shownPerms = permissions.slice(0, 3);
          return (
          <article
            key={plugin.id}
            className={`plugin-card${plugin.enabled ? ' is-enabled' : ' is-off'}`}
            onContextMenu={(e) => openPluginMenu(e, plugin)}
          >
            <header className="plugin-card-head">
              <span className="plugin-card-mark" aria-hidden>{pluginInitial(plugin)}</span>
              <div className="plugin-card-heading">
                <h4>
                  {plugin.manifest?.name || plugin.id}
                  {plugin.manifest?.tag ? (
                    <span className="plugin-tag-badge plugin-tag-badge--card">{plugin.manifest.tag}</span>
                  ) : null}
                </h4>
                {debugMode ? (
                  <span className="plugin-card-meta">
                    v{plugin.manifest?.version || '0.0.0'} · {plugin.manifest?.author || 'Unbekannt'}
                  </span>
                ) : (
                  <span className={`plugin-status ${plugin.enabled ? 'plugin-status--on' : 'plugin-status--off'}`}>
                    <span className="plugin-status-dot" aria-hidden />
                    {plugin.enabled ? 'Aktiv' : 'Inaktiv'}
                  </span>
                )}
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
            {plugin.manifest?.tag === 'alpha' ? (
              <p className="plugin-alpha-notice" role="note">
                Alpha: Diese Erweiterung ist noch in Entwicklung und funktioniert möglicherweise nicht wie erwartet.
              </p>
            ) : null}
            {debugMode && (shownPerms.length || plugin.hasUi || plugin.hasMain) ? (
              <div className="plugin-card-caps" aria-label="Berechtigungen">
                {shownPerms.map((perm) => (
                  <span
                    key={perm.code}
                    className="plugin-cap plugin-cap-perm"
                    title={debugMode ? perm.code : undefined}
                  >
                    {perm.label}
                  </span>
                ))}
                {extraPerms > 0 ? (
                  <span className="plugin-cap">+{extraPerms}</span>
                ) : null}
                {debugMode && plugin.hasUi ? <span className="plugin-cap">UI</span> : null}
                {debugMode && plugin.hasMain ? <span className="plugin-cap">Main</span> : null}
              </div>
            ) : null}
            {plugin.lastError ? (
              <div className="plugin-error-banner" role="alert">
                {debugMode ? plugin.lastError : 'Diese Erweiterung konnte nicht geladen werden.'}
              </div>
            ) : null}
            {debugMode ? (
              <footer className="plugin-card-foot">
                <span className="plugin-card-id">{plugin.id}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => uninstall(plugin)}
                  disabled={busy === `remove:${plugin.id}`}
                  title="Entfernen"
                  aria-label="Entfernen"
                >
                  <Trash2 size={14} strokeWidth={ICON_STROKE} />
                </button>
              </footer>
            ) : null}
          </article>
          );
        })}
          </div>
        </div>
      </div>

      {menuPortal}
    </div>
  );
}
