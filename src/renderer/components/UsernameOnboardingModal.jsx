import React, { useEffect, useRef, useState } from 'react';
import { ModalOverlay } from './ModalOverlay.jsx';

export default function UsernameOnboardingModal({ open, onSubmit }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    setValue('');
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  if (!open) return null;

  const trimmed = value.trim();
  const canSubmit = trimmed.length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit?.(trimmed);
  };

  return (
    <ModalOverlay
      className="modal-overlay-onboarding"
      role="dialog"
      aria-modal="true"
      aria-labelledby="username-onboarding-title"
    >
      <div className="modal modal-welcome modal-onboarding animate-scale">
        <h3 id="username-onboarding-title">Welcome to BlueTalk</h3>
        <p className="modal-onboarding-lead">
          Choose a display name so other peers can recognize you in chats and when connecting.
        </p>
        <form onSubmit={handleSubmit}>
          <div className="input-group" style={{ marginBottom: 4 }}>
            <label htmlFor="username-onboarding-input">Username</label>
            <input
              ref={inputRef}
              id="username-onboarding-input"
              className="input"
              type="text"
              autoComplete="username"
              maxLength={64}
              placeholder="e.g. Alex"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              Continue
            </button>
          </div>
        </form>
      </div>
    </ModalOverlay>
  );
}
