import React, { useEffect, useRef } from 'react';
import { ModalOverlay } from './ModalOverlay.jsx';

export default function VersionWelcomeModal({ open, title, items, onContinue }) {
  const continueRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const t = requestAnimationFrame(() => {
      continueRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onContinue?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onContinue]);

  if (!open) return null;

  return (
    <ModalOverlay
      className="modal-overlay-welcome"
      role="dialog"
      aria-modal="true"
      aria-labelledby="version-welcome-title"
    >
      <div className="modal modal-welcome animate-scale">
        <h3 id="version-welcome-title">{title}</h3>
        <div className="modal-welcome-body">
          <ul className="release-notes-list">
            {(items || []).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="modal-actions">
          <button ref={continueRef} type="button" className="btn btn-primary" onClick={() => onContinue?.()}>
            Continue
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
