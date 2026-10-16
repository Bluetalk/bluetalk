import React from 'react';
import { createPortal } from 'react-dom';
import { useMobileLayout } from '../../../utils/touch.js';

/** Dunkler Hintergrund hinter dem Bottom-Sheet-Kontextmenü (nur < 768 px). */
export function ContextMenuBackdrop({ open, onClose }) {
  const mobile = useMobileLayout();
  if (!open || !mobile) return null;
  return createPortal(
    <div
      className="context-menu-backdrop"
      onPointerDown={(event) => {
        event.preventDefault();
        onClose?.();
      }}
    />,
    document.body,
  );
}
