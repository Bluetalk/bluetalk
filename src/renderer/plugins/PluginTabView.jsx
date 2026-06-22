import React, { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../App';
import { pluginRuntime } from './pluginRuntime';

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
      errorNode.textContent = `Plugin tab failed to render: ${String(e?.message || e)}`;
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
      <div className="plugin-host-empty">
        <h2>Plugin tab not available</h2>
        <p>
          Die zugehörige Erweiterung ist deaktiviert oder wurde entfernt. Unter Erweiterungen kannst du sie wieder aktivieren.
        </p>
      </div>
    );
  }

  return (
    <div className="plugin-host">
      {debugMode ? (
        <div className="plugin-host-header">
          <span className="plugin-host-title">{tab.label}</span>
          <span className="plugin-host-sub">from {tab.pluginId}</span>
        </div>
      ) : null}
      <div ref={containerRef} className="plugin-host-body" />
    </div>
  );
}
