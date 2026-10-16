// Verbindet Long-Press (Kontextmenü) und Wischen-nach-rechts (Antworten)
// auf einer Nachrichten-Zeile. Maus bleibt beim nativen contextmenu.
import React, { useCallback, useRef, useState } from 'react';
import {
  GESTURE_MOVE_CANCEL_PX,
  LONG_PRESS_MS,
  SWIPE_REPLY_PX,
  pointerToMenuEvent,
} from '../../utils/touch.js';

function isTouchLikePointer(e) {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
}

export function MessageTouch({
  disabled,
  onLongPress,
  onSwipeReply,
  className,
  children,
  ...rest
}) {
  const startRef = useRef({ x: 0, y: 0, active: false });
  const timerRef = useRef(0);
  const firedRef = useRef(false);
  const [swipeX, setSwipeX] = useState(0);
  const [swiping, setSwiping] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
  }, []);

  const resetSwipe = useCallback(() => {
    startRef.current.active = false;
    setSwipeX(0);
    setSwiping(false);
  }, []);

  const onPointerDown = useCallback((e) => {
    if (disabled || !isTouchLikePointer(e) || e.button !== 0) return;
    firedRef.current = false;
    startRef.current = { x: e.clientX, y: e.clientY, active: true };
    clearTimer();
    if (onLongPress) {
      const snapshot = pointerToMenuEvent(e);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = 0;
        firedRef.current = true;
        startRef.current.active = false;
        setSwiping(false);
        setSwipeX(0);
        try {
          navigator.vibrate?.(12);
        } catch {
          /* ignore */
        }
        onLongPress(snapshot);
      }, LONG_PRESS_MS);
    }
  }, [clearTimer, disabled, onLongPress]);

  const onPointerMove = useCallback((e) => {
    if (!startRef.current.active) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    const dist2 = dx * dx + dy * dy;
    if (timerRef.current && dist2 > GESTURE_MOVE_CANCEL_PX * GESTURE_MOVE_CANCEL_PX) {
      clearTimer();
    }
    if (!onSwipeReply) return;
    if (!swiping) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dy) > Math.abs(dx) * 0.7) return;
      clearTimer();
      setSwiping(true);
    }
    setSwipeX(Math.max(0, Math.min(72, dx)));
  }, [clearTimer, onSwipeReply, swiping]);

  const onPointerUp = useCallback(() => {
    const shouldReply = Boolean(onSwipeReply) && swipeX >= SWIPE_REPLY_PX && !firedRef.current;
    clearTimer();
    if (shouldReply) {
      try {
        navigator.vibrate?.(8);
      } catch {
        /* ignore */
      }
      onSwipeReply();
    }
    resetSwipe();
  }, [clearTimer, onSwipeReply, resetSwipe, swipeX]);

  const onPointerCancel = useCallback(() => {
    clearTimer();
    firedRef.current = false;
    resetSwipe();
  }, [clearTimer, resetSwipe]);

  const onClickCapture = useCallback((e) => {
    if (!firedRef.current && swipeX < 8) return;
    e.preventDefault();
    e.stopPropagation();
    firedRef.current = false;
  }, [swipeX]);

  const cls = [
    className,
    onSwipeReply ? 'msg-row--swipeable' : '',
    swiping ? 'msg-row--swiping' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      {...rest}
      className={cls}
      style={{ '--swipe-x': `${swipeX}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
    >
      {children}
    </div>
  );
}
