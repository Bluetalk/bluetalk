/** Höchstens eine Keyframe-Anforderung pro Sekunde und Stream. */
export const KEYFRAME_REQUEST_MIN_INTERVAL_MS = 1000;

/**
 * Nach einem fehlenden/beschädigten Frame Delta-Frames verwerfen, bis der
 * nächste Keyframe kommt, und maximal 1×/s `keyframe` anfordern.
 */
export function createKeyframeController({
  minIntervalMs = KEYFRAME_REQUEST_MIN_INTERVAL_MS,
} = {}) {
  let waiting = false;
  let lastRequestAt = 0;

  function onGap(now) {
    waiting = true;
    const t = Number(now) || 0;
    if (t - lastRequestAt < minIntervalMs) return { request: false };
    lastRequestAt = t;
    return { request: true };
  }

  function shouldDropDelta() {
    return waiting;
  }

  function onKeyframe() {
    waiting = false;
  }

  return {
    onGap,
    shouldDropDelta,
    onKeyframe,
    isWaiting: () => waiting,
  };
}
