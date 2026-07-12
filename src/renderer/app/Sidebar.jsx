// Seitenleiste inkl. Resize-Handling und Plugin-Tabs, ausgelagert aus App.jsx (Verhalten identisch).
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { MessageCircle, Settings as SettingsIcon, UserPlus, Blocks, Plug, FolderOpen, FileText, Palette, Sparkles, Spade } from 'lucide-react';
import ProfileMenu from '../components/ProfileMenu';
import PresenceStatusToggle from '../components/PresenceStatusToggle';
import VerticalResizeHandle from '../components/VerticalResizeHandle';
import { pluginRuntime } from '../plugins/pluginRuntime';
import { useApp } from './appContext';

function resolveLucideIcon(name) {
  if (!name || typeof name !== 'string') return Plug;
  return { Plug, Palette, Sparkles, Spade, Blocks, MessageCircle, FolderOpen }[name] || Plug;
}

const SIDEBAR_WIDTH_DEFAULT = 56;
const SIDEBAR_WIDTH_MIN = 56;
const SIDEBAR_WIDTH_MAX = 280;

export default function Sidebar() {
  const { settings, updateSettings, contacts } = useApp();
  const pendingRequestCount = contacts.filter((c) => c?.pendingMessageRequest === true).length;
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const storedSidebar = settings.uiResize?.sidebar;
  const sidebarCommitted =
    typeof storedSidebar === 'number'
      ? Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, storedSidebar))
      : SIDEBAR_WIDTH_DEFAULT;
  const [sidebarPreview, setSidebarPreview] = useState(null);
  const sidebarDragRef = useRef(sidebarCommitted);

  useEffect(() => {
    sidebarDragRef.current = sidebarCommitted;
  }, [sidebarCommitted]);

  const [pluginTabs, setPluginTabs] = useState(() => pluginRuntime.listTabs());

  useEffect(() => {
    const off = pluginRuntime.onTabsChanged((tabs) => setPluginTabs(tabs));
    setPluginTabs(pluginRuntime.listTabs());
    return off;
  }, []);

  const sidebarDisplayWidth = sidebarPreview ?? sidebarCommitted;

  const onSidebarResizeBegin = useCallback(() => {
    sidebarDragRef.current = sidebarPreview ?? sidebarCommitted;
  }, [sidebarPreview, sidebarCommitted]);

  const onSidebarResizeDelta = useCallback((dx) => {
    sidebarDragRef.current = Math.min(
      SIDEBAR_WIDTH_MAX,
      Math.max(SIDEBAR_WIDTH_MIN, sidebarDragRef.current + dx)
    );
    setSidebarPreview(sidebarDragRef.current);
  }, []);

  const commitSidebarWidth = useCallback(() => {
    const w = sidebarDragRef.current;
    if (w !== sidebarCommitted) {
      updateSettings({ uiResize: { sidebar: w } });
    }
    setSidebarPreview(null);
  }, [sidebarCommitted, updateSettings]);

  const resetSidebarWidth = useCallback(() => {
    setSidebarPreview(null);
    updateSettings({ uiResize: { sidebar: SIDEBAR_WIDTH_DEFAULT } });
  }, [updateSettings]);

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
    <>
      <nav
        className="sidebar sidebar--resizable"
        style={{ width: sidebarDisplayWidth }}
      >
        <div className="sidebar-nav">
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
              title={to === '/new' && pendingRequestCount > 0
                ? `${label} — ${pendingRequestCount} Anfrage${pendingRequestCount === 1 ? '' : 'n'}`
                : label}
            >
              <Icon size={15} strokeWidth={2} />
              <span>{label}</span>
              {to === '/new' && pendingRequestCount > 0 ? (
                <span className="sidebar-link-badge" aria-hidden>
                  {pendingRequestCount > 9 ? '9+' : pendingRequestCount}
                </span>
              ) : null}
            </NavLink>
          ))}
          {pluginTabs.length > 0 ? <div className="sidebar-nav-divider" role="separator" aria-hidden="true" /> : null}
          {pluginTabs.map((tab) => {
            const Icon = resolveLucideIcon(tab.icon);
            return (
              <NavLink
                key={tab.tabId}
                to={tab.path}
                className={({ isActive }) => `sidebar-link sidebar-link-plugin ${isActive ? 'active' : ''}`}
                title={tab.label}
              >
                <Icon size={15} strokeWidth={2} />
                <span className="sidebar-link-label">
                  <span>{tab.label}</span>
                  {tab.tag ? <span className="plugin-tag-badge">{tab.tag}</span> : null}
                </span>
              </NavLink>
            );
          })}
        </div>
        <div className="sidebar-footer">
          <div className="sidebar-profile-cluster">
            <ProfileMenu variant="sidebar" />
            <PresenceStatusToggle compact />
          </div>
        </div>
      </nav>
      <VerticalResizeHandle
        onBegin={onSidebarResizeBegin}
        onDelta={onSidebarResizeDelta}
        onCommit={commitSidebarWidth}
        onDoubleClick={resetSidebarWidth}
      />
    </>
  );
}
