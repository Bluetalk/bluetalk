/** Pro Stream höchstens so viele kodierte Frames gleichzeitig unterwegs. */
export const VIDEO_MAX_IN_FLIGHT = 5;
export const CAMERA_BITRATE_BPS = 600_000;
export const SCREEN_BITRATE_BPS = 1_200_000;
export const MIN_VIDEO_BITRATE_BPS = 80_000;

/**
 * Staukontrolle: bei voller Sendewarteschlange Frames auslassen und Bitrate
 * senken. `audioBusy` hat Vorrang — dann wird kein Video gesendet.
 */
export function createCongestionController({
  maxInFlight = VIDEO_MAX_IN_FLIGHT,
  cameraBitrate = CAMERA_BITRATE_BPS,
  screenBitrate = SCREEN_BITRATE_BPS,
  audioBusy = () => false,
} = {}) {
  const inFlight = { camera: 0, screen: 0 };
  const bitrate = { camera: cameraBitrate, screen: screenBitrate };

  function keyOf(stream) {
    return stream === 'screen' ? 'screen' : 'camera';
  }

  function canSend(stream) {
    if (typeof audioBusy === 'function' && audioBusy()) return false;
    const key = keyOf(stream);
    return inFlight[key] < maxInFlight;
  }

  function onQueued(stream) {
    const key = keyOf(stream);
    inFlight[key] += 1;
  }

  function onDone(stream) {
    const key = keyOf(stream);
    inFlight[key] = Math.max(0, inFlight[key] - 1);
  }

  function onCongested(stream) {
    const key = keyOf(stream);
    bitrate[key] = Math.max(MIN_VIDEO_BITRATE_BPS, Math.round(bitrate[key] * 0.75));
    return bitrate[key];
  }

  function currentBitrate(stream) {
    return bitrate[keyOf(stream)];
  }

  return {
    canSend,
    onQueued,
    onDone,
    onCongested,
    currentBitrate,
    inFlight,
  };
}
