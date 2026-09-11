import React, { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const SHELL_PROFILE_SLOT_ID = 'shell-profile-slot';

/** Rendert Kinder in die Chrome-Ecke außerhalb des Content-Rahmens. */
export function ShellProfile({ children }) {
  const [slot, setSlot] = useState(null);

  useLayoutEffect(() => {
    setSlot(document.getElementById(SHELL_PROFILE_SLOT_ID));
  }, []);

  if (!slot) return null;
  return createPortal(children, slot);
}
