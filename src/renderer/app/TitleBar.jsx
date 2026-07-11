// Titlebar inkl. Fensterkontrollen, ausgelagert aus App.jsx (Verhalten identisch).
import React, { useState, useEffect, useCallback } from 'react';
import { Minus, Maximize2, SquareStack, X, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useApp } from './appContext';

export default function TitleBar() {
  const { peerCount, settings, updateSettings } = useApp();
  const sidebarCollapsed = settings.uiCollapse?.sidebar === true;
  const [isMaximized, setIsMaximized] = useState(false);

  const toggleSidebarCollapse = useCallback(() => {
    updateSettings({ uiCollapse: { sidebar: !sidebarCollapsed } });
  }, [sidebarCollapsed, updateSettings]);

  useEffect(() => {
    const api = window.bluetalk?.window;
    if (!api?.getMaximized || !api?.onMaximizedChange) return undefined;
    let cancelled = false;
    api.getMaximized().then((m) => {
      if (!cancelled) setIsMaximized(m);
    });
    const unsub = api.onMaximizedChange((m) => {
      if (!cancelled) setIsMaximized(m);
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar-drag">
        <button
          type="button"
          className="tb-btn titlebar-sidebar-toggle"
          onClick={toggleSidebarCollapse}
          title={sidebarCollapsed ? 'Seitenleiste einblenden' : 'Seitenleiste einklappen'}
          aria-label={sidebarCollapsed ? 'Seitenleiste einblenden' : 'Seitenleiste einklappen'}
          aria-expanded={!sidebarCollapsed}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen size={15} strokeWidth={2} aria-hidden />
          ) : (
            <PanelLeftClose size={15} strokeWidth={2} aria-hidden />
          )}
        </button>
        <div className="titlebar-brand">
          <span>BlueTalk</span>
        </div>
      </div>
      <div className="titlebar-status">
        <span className={peerCount > 0 ? 'online-dot' : 'offline-dot'} />
        <span>{peerCount} peer{peerCount !== 1 ? 's' : ''}</span>
      </div>
      <div className="titlebar-controls">
        <button type="button" onClick={() => window.bluetalk?.window.minimize()} className="tb-btn" title="Minimize" aria-label="Minimize">
          <Minus size={14} strokeWidth={2} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => window.bluetalk?.window.maximize()}
          className="tb-btn"
          title={isMaximized ? 'Restore' : 'Maximize'}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <SquareStack size={14} strokeWidth={2} aria-hidden /> : <Maximize2 size={14} strokeWidth={2} aria-hidden />}
        </button>
        <button type="button" onClick={() => window.bluetalk?.window.close()} className="tb-btn tb-close" title="Close" aria-label="Close">
          <X size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
