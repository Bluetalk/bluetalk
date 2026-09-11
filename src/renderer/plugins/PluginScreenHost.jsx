import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ModalOverlay } from '../components/ModalOverlay';
import { pluginRuntime } from './pluginRuntime';

/**
 * Global modal host for plugin-registered screens. A plugin opens a screen by
 * calling `BlueTalkPlugin.ui.openScreen('my-screen', ctx)`.
 */
export default function PluginScreenHost() {
  const [state, setState] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    const offOpen = pluginRuntime.onScreenOpen(({ screen, ctx }) => {
      setState({ screen, ctx });
    });
    const offClose = pluginRuntime.onScreenClose(() => setState(null));
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  useEffect(() => {
    if (!state || !containerRef.current) return undefined;
    const container = containerRef.current;
    container.innerHTML = '';
    let cleanup = null;
    try {
      cleanup = state.screen.render(container, {
        ...state.ctx,
        close: () => setState(null),
      });
    } catch (e) {
      console.error('[PluginScreenHost] render failed:', e);
    }
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup();
      } catch {
        /* ignore */
      }
      container.innerHTML = '';
    };
  }, [state]);

  if (!state) return null;

  return (
    <ModalOverlay
      className="plugin-screen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={state.screen.title}
      onClick={() => setState(null)}
    >
      <div className="plugin-screen-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="plugin-screen-header">
          <span className="plugin-screen-title">{state.screen.title}</span>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setState(null)}
            aria-label="Schließen"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>
        <div ref={containerRef} className="plugin-screen-body" />
      </div>
    </ModalOverlay>
  );
}
