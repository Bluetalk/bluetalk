// Mobile-Layout und Touch-Gesten (Long-Press, Wischen-zum-Antworten).
// Desktop bleibt unberührt: Helper greifen nur unter MOBILE_MQ bzw. Pointer-Typ touch/pen.
import { useCallback, useEffect, useRef, useState } from 'react';

export const MOBILE_BREAKPOINT = 768;
export const MOBILE_MQ = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
export const LONG_PRESS_MS = 450;
export const SWIPE_REPLY_PX = 56;
export const GESTURE_MOVE_CANCEL_PX = 10;

/** Ob das Ein-Spalten-Layout gerade aktiv ist (Fenster schmaler als 768 px). */
export function isMobileLayout() {
  return typeof window !== 'undefined' && window.matchMedia(MOBILE_MQ).matches;
}

/** Reaktives Pendant zu isMobileLayout(); folgt matchMedia. */
export function useMobileLayout() {
  const [mobile, setMobile] = useState(isMobileLayout);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return mobile;
}

/** Baut aus einem Pointer-Event das Minimum, das die bestehenden Kontextmenüs erwarten. */
export function pointerToMenuEvent(e) {
  return {
    preventDefault() {
      e.preventDefault?.();
    },
    stopPropagation() {
      e.stopPropagation?.();
    },
    clientX: e.clientX,
    clientY: e.clientY,
  };
}

function isTouchLikePointer(e) {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
}

/**
 * Long-Press (~450 ms) für Touch/Stift. Maus nutzt weiterhin das native
 * contextmenu. Nach dem Auslösen wird der folgende click unterdrückt.
 */
export function useLongPress(onLongPress, { disabled = false, delay = LONG_PRESS_MS } = {}) {
  const timerRef = useRef(0);
  const firedRef = useRef(false);
  const startRef = useRef({ x: 0, y: 0 });

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
  }, []);

  useEffect(() => () => clearTimer(), [clearTimer]);

  const onPointerDown = useCallback((e) => {
    if (disabled || !onLongPress) return;
    if (!isTouchLikePointer(e) || e.button !== 0) return;
    firedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY };
    clearTimer();
    const snapshot = pointerToMenuEvent(e);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = 0;
      firedRef.current = true;
      try {
        navigator.vibrate?.(12);
      } catch {
        /* ignore */
      }
      onLongPress(snapshot);
    }, delay);
  }, [clearTimer, delay, disabled, onLongPress]);

  const onPointerMove = useCallback((e) => {
    if (!timerRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if ((dx * dx) + (dy * dy) > GESTURE_MOVE_CANCEL_PX * GESTURE_MOVE_CANCEL_PX) {
      clearTimer();
    }
  }, [clearTimer]);

  const onPointerUp = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  const onPointerCancel = useCallback(() => {
    clearTimer();
    firedRef.current = false;
  }, [clearTimer]);

  const onClickCapture = useCallback((e) => {
    if (!firedRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    firedRef.current = false;
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture,
  };
}

/**
 * Wischen nach rechts auf einer Nachricht = Antworten.
 * Gibt { handlers, swipeX, swiping } zurück; CSS nutzt --swipe-x.
 */
export function useSwipeReply(onReply, { disabled = false, threshold = SWIPE_REPLY_PX } = {}) {
  const startRef = useRef({ x: 0, y: 0, active: false });
  const [swipeX, setSwipeX] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const triggeredRef = useRef(false);

  const reset = useCallback(() => {
    startRef.current.active = false;
    triggeredRef.current = false;
    setSwipeX(0);
    setSwiping(false);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (disabled || !onReply) return;
    if (!isTouchLikePointer(e) || e.button !== 0) return;
    startRef.current = { x: e.clientX, y: e.clientY, active: true };
    triggeredRef.current = false;
  }, [disabled, onReply]);

  const onPointerMove = useCallback((e) => {
    if (!startRef.current.active) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (!swiping) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.7) {
        startRef.current.active = false;
        return;
      }
      setSwiping(true);
    }
    const next = Math.max(0, Math.min(72, dx));
    setSwipeX(next);
  }, [swiping]);

  const onPointerUp = useCallback(() => {
    if (!startRef.current.active) return;
    const shouldReply = swipeX >= threshold && !triggeredRef.current;
    if (shouldReply) {
      triggeredRef.current = true;
      try {
        navigator.vibrate?.(8);
      } catch {
        /* ignore */
      }
      onReply();
    }
    reset();
  }, [onReply, reset, swipeX, threshold]);

  const onPointerCancel = useCallback(() => {
    reset();
  }, [reset]);

  return {
    swipeX,
    swiping,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
    },
  };
}
