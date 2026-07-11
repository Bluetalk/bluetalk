// Toast-Bridges, ausgelagert aus App.jsx (Verhalten identisch).
import { useEffect } from 'react';
import { useToast } from '../components/ToastProvider';
import { pluginRuntime } from '../plugins/pluginRuntime';

export function PluginRuntimeToastBridge() {
  const { toast } = useToast();
  useEffect(() => {
    const current = pluginRuntime._host || {};
    pluginRuntime.setHost({ ...current, toast });
    return () => {
      const latest = pluginRuntime._host || {};
      if (latest.toast === toast) {
        pluginRuntime.setHost({ ...latest, toast: null });
      }
    };
  }, [toast]);
  return null;
}

/** Ref wird gesetzt, damit `peer:message`-Handler in `App` Toasts anzeigen kann (liegt außerhalb von `ToastProvider`). */
export function InboundToastBridge({ toastRef }) {
  const { toast } = useToast();
  useEffect(() => {
    toastRef.current = toast;
    return () => {
      toastRef.current = null;
    };
  }, [toast, toastRef]);
  return null;
}
