// Seitenleiste inkl. Plugin-Tabs, ausgelagert aus App.jsx (Verhalten identisch).
import React, { useState, useEffect, useCallback } from 'react';
import { NavLink } from 'react-router-dom';
import { MessageCircle, Settings as SettingsIcon, UserPlus, Blocks, Plug, FolderOpen, FileText, Palette, Sparkles, Spade } from 'lucide-react';
import ProfileMenu from '../components/ProfileMenu';
import PresenceStatusToggle from '../components/PresenceStatusToggle';
import { pluginRuntime } from '../plugins/pluginRuntime';
import { useApp } from './appContext';

function resolveLucideIcon(name) {
  if (!name || typeof name !== 'string') return Plug;
  return { Plug, Palette, Sparkles, Spade, Blocks, MessageCircle, FolderOpen }[name] || Plug;
}

export default function Sidebar() {
  const { settings, contacts } = useApp();
  const pendingRequestCount = contacts.filter((c) => c?.pendingMessageRequest === true).length;
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const [pluginTabs, setPluginTabs] = useState(() => pluginRuntime.listTabs());
  const [hoverTip, setHoverTip] = useState(null);

  useEffect(() => {
    const off = pluginRuntime.onTabsChanged((tabs) => setPluginTabs(tabs));
    setPluginTabs(pluginRuntime.listTabs());
    return off;
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
    { to: '/new', label: 'New', icon: UserPlus },
    { to: '/library', label: 'Bibliothek', icon: FolderOpen },
    { to: '/documents', label: 'Dokumente', icon: FileText },
    { to: '/games', label: 'Spiele', icon: Sparkles },
    { to: '/plugins', label: 'Erweiterungen', icon: Blocks },
    { to: '/settings', label: 'Settings', icon: SettingsIcon },
  ];

  if (sidebarCollapsed) {
    return null;
  }

  return (
    <nav className="sidebar">
      <div className="sidebar-nav" onScroll={hideTip}>
        {links.map(({ to, label, icon: Icon }) => {
          const tip = to === '/new' && pendingRequestCount > 0
            ? `${label} — ${pendingRequestCount} Anfrage${pendingRequestCount === 1 ? '' : 'n'}`
            : label;
          return (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              aria-label={tip}
              {...bindTip(tip)}
            >
              <Icon size={18} strokeWidth={2} />
              {to === '/new' && pendingRequestCount > 0 ? (
                <span className="sidebar-link-badge" aria-hidden>
                  {pendingRequestCount > 9 ? '9+' : pendingRequestCount}
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
          <div className="sidebar-tip-anchor" {...bindTip('Profil')}>
            <ProfileMenu variant="sidebar" />
          </div>
          <div className="sidebar-tip-anchor" {...bindTip(settings.doNotDisturb ? 'Nicht stören' : 'Verfügbar')}>
            <PresenceStatusToggle compact />
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
