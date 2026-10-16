// Seitenleiste inkl. Plugin-Tabs, ausgelagert aus App.jsx (Verhalten identisch).
import React, { useState, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import { Cloud, MessageCircle, Settings as SettingsIcon, UserPlus, Blocks, Plug, FolderOpen, Palette, Sparkles, Spade } from 'lucide-react';
import ProfileMenu from '../components/ProfileMenu';
import { pluginRuntime } from '../plugins/pluginRuntime';
import { useApp } from './appContext';
import { useOpenGameInvites } from './hooks/useOpenGameInvites';
import { formatOwnPresenceLabel } from '../../shared/user-presence.js';

function resolveLucideIcon(name) {
  if (!name || typeof name !== 'string') return Plug;
  return { Plug, Palette, Sparkles, Spade, Blocks, MessageCircle, FolderOpen }[name] || Plug;
}

export default function Sidebar() {
  const { settings, contacts } = useApp();
  const pendingRequestCount = contacts.filter((c) => c?.pendingMessageRequest === true).length;
  const openGameInviteCount = useOpenGameInvites().length;
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const [pluginTabs, setPluginTabs] = useState(() => pluginRuntime.listTabs());
  const [hoverTip, setHoverTip] = useState(null);
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

  const showTip = useCallback((event, label) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverTip({
      label,
      top: Math.round(rect.top + rect.height / 2),
      left: Math.round(rect.right + 10),
    });
  }, []);

  const hideTip = useCallback(() => setHoverTip(null), []);

  const bindTip = useCallback((label) => ({
    onMouseEnter: (event) => showTip(event, label),
    onMouseLeave: hideTip,
    onFocus: (event) => showTip(event, label),
    onBlur: hideTip,
    onMouseDown: hideTip,
  }), [showTip, hideTip]);

  const links = [
    { to: '/', label: 'Chats', icon: MessageCircle },
    { to: '/new', label: 'Neu', icon: UserPlus },
    { to: '/library', label: 'Bibliothek', icon: FolderOpen },
    { to: '/games', label: 'Spiele', icon: Sparkles },
    { to: '/plugins', label: 'Erweiterungen', icon: Blocks },
    { to: '/cloud-sync', label: 'Cloud-Nachrichten', icon: Cloud },
    { to: '/settings', label: 'Einstellungen', icon: SettingsIcon },
  ];

  if (sidebarCollapsed) {
    return null;
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-nav" onScroll={hideTip}>
        {links.map(({ to, label, icon: Icon }) => {
          const badgeCount = to === '/new' ? pendingRequestCount : to === '/games' ? openGameInviteCount : 0;
          const badgeNoun = to === '/games'
            ? (badgeCount === 1 ? 'Einladung' : 'Einladungen')
            : (badgeCount === 1 ? 'Anfrage' : 'Anfragen');
          const cloudTip = to === '/cloud-sync' && cloudState
            ? (cloudState === 'online' ? 'Online' : cloudState === 'connecting' ? 'Verbindet…' : cloudState === 'error' ? 'Fehler' : cloudState === 'disabled' ? 'Aus' : 'Offline')
            : '';
          const tip = badgeCount > 0
            ? `${label} — ${badgeCount} ${badgeNoun}`
            : (cloudTip ? `${label} — ${cloudTip}` : label);
          return (
            <NavLink
              key={to}
              to={to}
              viewTransition
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              aria-label={tip}
              {...bindTip(tip)}
            >
              <Icon size={18} strokeWidth={2} />
              {to === '/cloud-sync' && cloudState ? (
                <span className={`sidebar-cloud-dot is-${cloudState}`} aria-hidden />
              ) : null}
              {badgeCount > 0 ? (
                <span className={`sidebar-link-badge${to === '/games' ? ' sidebar-link-badge--info' : ''}`} aria-hidden>
                  {badgeCount > 9 ? '9+' : badgeCount}
                </span>
              ) : null}
            </NavLink>
          );
        })}
        {pluginTabs.length > 0 ? <div className="sidebar-nav-divider" role="separator" aria-hidden="true" /> : null}
        {pluginTabs.map((tab) => {
          const Icon = resolveLucideIcon(tab.icon);
          const tip = tab.tag ? `${tab.label} · ${tab.tag}` : tab.label;
          return (
            <NavLink
              key={tab.tabId}
              to={tab.path}
              viewTransition
              className={({ isActive }) => `sidebar-link sidebar-link-plugin ${isActive ? 'active' : ''}`}
              aria-label={tip}
              {...bindTip(tip)}
            >
              <Icon size={18} strokeWidth={2} />
            </NavLink>
          );
        })}
      </div>
      <div className="sidebar-footer">
        <div className="sidebar-profile-cluster">
          <div className="sidebar-tip-anchor" {...bindTip(`Profil · ${formatOwnPresenceLabel(settings)}`)}>
            <ProfileMenu variant="sidebar" />
          </div>
        </div>
      </div>
      {hoverTip ? (
        <div
          className="sidebar-tooltip"
          style={{ top: hoverTip.top, left: hoverTip.left }}
          role="tooltip"
        >
          {hoverTip.label}
        </div>
      ) : null}
    </nav>
  );
}
