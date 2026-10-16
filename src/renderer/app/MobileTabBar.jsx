// Untere Tab-Leiste für das Ein-Spalten-Layout (< 768 px). Ersetzt die Sidebar,
// ändert Desktop nicht (sichtbar nur per CSS / bt-mobile).
import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  Blocks,
  Cloud,
  FolderOpen,
  MessageCircle,
  MoreHorizontal,
  Plug,
  Settings as SettingsIcon,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import { useApp } from './appContext';
import { useOpenGameInvites } from './hooks/useOpenGameInvites';
import { pluginRuntime } from '../plugins/pluginRuntime';

const TAB_ICON_STROKE = 2;
const TAB_ICON_SIZE = 22;

const PRIMARY_TABS = [
  { to: '/', label: 'Chats', icon: MessageCircle, end: true },
  { to: '/games', label: 'Spiele', icon: Sparkles },
  { to: '/cloud-sync', label: 'Cloud', icon: Cloud, title: 'BlueTalk Cloud' },
  { to: '/settings', label: 'Einstellungen', icon: SettingsIcon, matchPrefix: '/settings' },
];

const MORE_LINKS = [
  { to: '/new', label: 'Neu', icon: UserPlus },
  { to: '/library', label: 'Bibliothek', icon: FolderOpen },
  ...(__BLUETALK_WEB__ ? [] : [{ to: '/plugins', label: 'Erweiterungen', icon: Blocks }]),
];

const MORE_PREFIXES = __BLUETALK_WEB__
  ? ['/new', '/library']
  : ['/new', '/library', '/plugins', '/plugin'];

function TabBadge({ count, info }) {
  if (!count) return null;
  return (
    <span className={`mobile-tab-badge${info ? ' mobile-tab-badge--info' : ''}`} aria-hidden>
      {count > 9 ? '9+' : count}
    </span>
  );
}

export default function MobileTabBar() {
  const { contacts } = useApp();
  const location = useLocation();
  const pendingRequestCount = contacts.filter((c) => c?.pendingMessageRequest === true).length;
  const openGameInviteCount = useOpenGameInvites().length;
  const [moreOpen, setMoreOpen] = useState(false);
  const [pluginTabs, setPluginTabs] = useState(() => pluginRuntime.listTabs());
  const [cloudState, setCloudState] = useState('');

  useEffect(() => {
    const off = pluginRuntime.onTabsChanged((tabs) => setPluginTabs(tabs));
    setPluginTabs(pluginRuntime.listTabs());
    return off;
  }, []);

  useEffect(() => {
    if (!window.bluetalk?.cloud) return undefined;
    let cancelled = false;
    void window.bluetalk.cloud.getStatus().then((status) => {
      if (!cancelled && status?.state) setCloudState(status.state);
    }).catch(() => {});
    const off = window.bluetalk.cloud.onStatus((status) => {
      if (!cancelled && status?.state) setCloudState(status.state);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  const moreActive = MORE_PREFIXES.some((p) => (
    p === '/plugin'
      ? location.pathname.startsWith('/plugin')
      : location.pathname === p || location.pathname.startsWith(`${p}/`)
  ));

  return (
    <>
      <nav className="mobile-tab-bar" aria-label="Hauptnavigation">
        {PRIMARY_TABS.map(({ to, label, icon: Icon, end, matchPrefix, title }) => {
          const badgeCount = to === '/games' ? openGameInviteCount : 0;
          const cloudTip = to === '/cloud-sync' && cloudState
            ? (cloudState === 'online' ? 'Online' : cloudState === 'connecting' ? 'Verbindet…' : cloudState === 'error' ? 'Fehler' : cloudState === 'disabled' ? 'Aus' : cloudState === 'replaced' ? 'Anderes Gerät' : 'Offline')
            : '';
          return (
            <NavLink
              key={to}
              to={to}
              end={Boolean(end)}
              title={cloudTip ? `${title || label} — ${cloudTip}` : (title || label)}
              className={({ isActive }) => {
                const active = matchPrefix
                  ? location.pathname === matchPrefix || location.pathname.startsWith(`${matchPrefix}/`)
                  : isActive;
                return `mobile-tab-link${active ? ' active' : ''}`;
              }}
            >
              <span className="mobile-tab-icon-wrap">
                <Icon size={TAB_ICON_SIZE} strokeWidth={TAB_ICON_STROKE} aria-hidden />
                {to === '/cloud-sync' && cloudState ? (
                  <span className={`sidebar-cloud-dot is-${cloudState}`} aria-hidden />
                ) : null}
                <TabBadge count={badgeCount} info={to === '/games'} />
              </span>
              <span className="mobile-tab-label">{label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          className={`mobile-tab-link${moreActive || moreOpen ? ' active' : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
        >
          <span className="mobile-tab-icon-wrap">
            <MoreHorizontal size={TAB_ICON_SIZE} strokeWidth={TAB_ICON_STROKE} aria-hidden />
            <TabBadge count={pendingRequestCount} />
          </span>
          <span className="mobile-tab-label">Mehr</span>
        </button>
      </nav>

      {moreOpen ? (
        <div className="mobile-sheet-overlay" role="presentation" onClick={() => setMoreOpen(false)}>
          <div
            className="mobile-sheet"
            role="dialog"
            aria-label="Weitere Seiten"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mobile-sheet-handle" aria-hidden />
            <div className="mobile-sheet-header">
              <h2>Weitere Seiten</h2>
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label="Schließen"
                onClick={() => setMoreOpen(false)}
              >
                <X size={18} strokeWidth={2} aria-hidden />
              </button>
            </div>
            <div className="mobile-sheet-body">
              {MORE_LINKS.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => `mobile-sheet-link${isActive ? ' active' : ''}`}
                  onClick={() => setMoreOpen(false)}
                >
                  <Icon size={18} strokeWidth={TAB_ICON_STROKE} aria-hidden />
                  <span>{label}</span>
                  {to === '/new' ? <TabBadge count={pendingRequestCount} /> : null}
                </NavLink>
              ))}
              {!__BLUETALK_WEB__ && pluginTabs.length > 0 ? (
                <>
                  <div className="mobile-sheet-sep" role="separator" />
                  {pluginTabs.map((tab) => (
                    <NavLink
                      key={tab.tabId}
                      to={tab.path}
                      className={({ isActive }) => `mobile-sheet-link${isActive ? ' active' : ''}`}
                      onClick={() => setMoreOpen(false)}
                    >
                      <Plug size={18} strokeWidth={TAB_ICON_STROKE} aria-hidden />
                      <span>{tab.label}</span>
                    </NavLink>
                  ))}
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
