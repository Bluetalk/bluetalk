import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Blocks } from 'lucide-react';
import { useApp } from '../App';
import { pluginRuntime } from './pluginRuntime';

const ICON_STROKE = 1.75;

/**
 * Mounts a plugin-registered tab. The plugin's `render(container, ctx)` callback
 * is invoked with a DOM container; any value returned from that callback is
 * treated as a cleanup function.
 */
export default function PluginTabView() {
  const { tabId } = useParams();
  const { settings } = useApp();
  const debugMode = settings.debugMode ?? false;
  const containerRef = useRef(null);
  const [tab, setTab] = useState(() => pluginRuntime.getTab(decodeURIComponent(tabId || '')));

  useEffect(() => {
    const off = pluginRuntime.onTabsChanged(() => {
      setTab(pluginRuntime.getTab(decodeURIComponent(tabId || '')));
    });
    setTab(pluginRuntime.getTab(decodeURIComponent(tabId || '')));
    return off;
  }, [tabId]);

  useEffect(() => {
    if (!tab || !containerRef.current) return undefined;
    const container = containerRef.current;
    container.innerHTML = '';
    let cleanup = null;
    try {
      cleanup = tab.render(container, { tabId: tab.tabId, pluginId: tab.pluginId });
    } catch (e) {
      console.error('[PluginTabView] render failed:', e);
      container.replaceChildren();
      const errorNode = document.createElement('div');
      errorNode.className = 'plugin-error';
      errorNode.textContent = `Plugin-Tab konnte nicht geladen werden: ${String(e?.message || e)}`;
      container.appendChild(errorNode);
    }
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch (err) {
        console.error('[PluginTabView] cleanup:', err);
      }
      container.innerHTML = '';
    };
  }, [tab]);

  if (!tab) {
    return (
      <div className="page page-inset">
        <div className="page-shell">
          <div className="page-empty">
            <Blocks size={28} strokeWidth={ICON_STROKE} aria-hidden />
            <p className="empty-state-title">Erweiterung nicht verfügbar</p>
            <p>
              Die zugehörige Erweiterung ist deaktiviert oder wurde entfernt. Unter Erweiterungen kannst du sie wieder aktivieren.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page page-inset page-plugin-host">
      <div className="page-shell">
        <header className="page-shell-header">
          <div className="page-shell-copy">
            <h1>{tab.label}</h1>
            {debugMode ? <p>{tab.pluginId}</p> : null}
          </div>
        </header>
        <div ref={containerRef} className="page-shell-body plugin-host-body" />
      </div>
    </div>
  );
}
