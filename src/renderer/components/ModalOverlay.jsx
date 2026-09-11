import React from 'react';
import { createPortal } from 'react-dom';

/**
 * Vollflächiges Dialog-Backdrop. Wird an document.body gehängt, damit
 * `position: fixed` nicht im Content-Panel (view-transition / overflow)
 * stecken bleibt und die Seitenleiste mit abdeckt.
 */
export function ModalOverlay({
  className = '',
  children,
  onClick,
  onMouseDown,
  role = 'presentation',
  ...rest
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className={['modal-overlay', className].filter(Boolean).join(' ')}
      onClick={onClick}
      onMouseDown={onMouseDown}
      role={role}
      {...rest}
    >
      {children}
    </div>,
    document.body
  );
}
