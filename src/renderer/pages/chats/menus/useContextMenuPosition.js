import { useLayoutEffect, useRef, useState } from 'react';

const VIEWPORT_PAD = 8;

/**
 * Positioniert ein Rechtsklick-Menü am Cursor und hält es im Viewport.
 * Misst nach dem Mount die echte Menügröße und klappt es wie ein OS-Menü
 * nach oben/links um, wenn es sonst über den Rand hinausragen würde.
 *
 * Wichtig: Das Menü muss per Portal an document.body hängen — innerhalb
 * animierter Seiten (transform) zeigt position:fixed sonst nicht auf den
 * Viewport.
 *
 * - menu: { x, y, … } | null (rohe clientX/clientY des Klicks)
 * Rückgabe: { ref, style } — style enthält left/top/transformOrigin.
 */
export function useContextMenuPosition(menu) {
  const ref = useRef(null);
  const [placement, setPlacement] = useState(null);

  useLayoutEffect(() => {
    if (!menu) {
      setPlacement(null);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const flipX = menu.x + width > window.innerWidth - VIEWPORT_PAD;
    const flipY = menu.y + height > window.innerHeight - VIEWPORT_PAD;
    let x = flipX ? menu.x - width : menu.x;
    let y = flipY ? menu.y - height : menu.y;
    x = Math.min(Math.max(VIEWPORT_PAD, x), Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD));
    y = Math.min(Math.max(VIEWPORT_PAD, y), Math.max(VIEWPORT_PAD, window.innerHeight - height - VIEWPORT_PAD));
    setPlacement({
      x,
      y,
      origin: `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`,
    });
  }, [menu]);

  return {
    ref,
    style: {
      left: placement ? placement.x : menu?.x ?? 0,
      top: placement ? placement.y : menu?.y ?? 0,
      transformOrigin: placement?.origin || 'top left',
    },
  };
}
