import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle, Info, X, XCircle } from 'lucide-react';

const ToastContext = createContext(null);

/** Abstand & Stufe für Apple-ähnlichen Kartenstapel (unten rechts). */
const SOLID_BR_STACK_OFFSET_PX = 11;
const SOLID_BR_STACK_SCALE = 0.028;
const SOLID_BR_STACK_MIN_SCALE = 0.9;

function toastId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ToastProvider({ children, solidBottomRight = false }) {
  const [toasts, setToasts] = useState([]);
  /** Auto-Dismiss-Timer pro Toast-ID, damit sie aufgeräumt werden können. */
  const timersRef = useRef(new Map());

  const dismissToast = useCallback((id) => {
    const timer = timersRef.current.get(id);
    if (timer != null) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input) => {
      const opts = typeof input === 'string' ? { message: input } : input || {};
      const id = opts.id || toastId();
      const {
        title,
        message = '',
        variant = 'info',
        duration = 4800,
      } = opts;

      setToasts((prev) => [...prev, { id, title, message, variant }]);

      if (duration > 0) {
        const existing = timersRef.current.get(id);
        if (existing != null) window.clearTimeout(existing);
        timersRef.current.set(id, window.setTimeout(() => dismissToast(id), duration));
      }
      return id;
    },
    [dismissToast]
  );

  // Offene Timer beim Unmount des Providers aufräumen.
  useEffect(() => () => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  const value = useMemo(() => ({ toast, dismissToast }), [toast, dismissToast]);

  const solidBrStackPad =
    solidBottomRight && toasts.length > 1 ? (toasts.length - 1) * SOLID_BR_STACK_OFFSET_PX : 0;

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className={`toast-stack${solidBottomRight ? ' toast-stack--solid-br' : ''}`}
        aria-live="polite"
        aria-relevant="additions text"
        style={solidBottomRight ? { paddingTop: solidBrStackPad } : undefined}
      >
        {toasts.map((t, i) => {
          const Icon =
            t.variant === 'success'
              ? CheckCircle
              : t.variant === 'error'
                ? XCircle
                : t.variant === 'warning'
                  ? AlertCircle
                  : Info;
          const depth = solidBottomRight ? toasts.length - 1 - i : 0;
          const scale = solidBottomRight
            ? Math.max(SOLID_BR_STACK_MIN_SCALE, 1 - depth * SOLID_BR_STACK_SCALE)
            : 1;
          const stackStyle = solidBottomRight
            ? {
                zIndex: 10 + i,
                transform: `translateY(${-depth * SOLID_BR_STACK_OFFSET_PX}px) scale(${scale})`,
                // Auch verdeckte Karten bleiben klickbar (Dismiss-Button erreichbar).
                pointerEvents: 'auto',
              }
            : undefined;
          return (
            <div
              key={t.id}
              className={`toast toast--${t.variant}`}
              role="status"
              style={stackStyle}
            >
              <Icon className="toast-icon" size={18} strokeWidth={2} aria-hidden />
              <div className="toast-body">
                {t.title ? <div className="toast-title">{t.title}</div> : null}
                {t.message ? <div className="toast-message">{t.message}</div> : null}
              </div>
              <button
                type="button"
                className="toast-dismiss btn btn-ghost btn-icon"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss notification"
              >
                <X size={14} strokeWidth={2} aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
