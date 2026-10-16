/**
 * Worklets als Vite-Assets (eigene Dateien, nicht inline, kein Blob).
 * `script-src 'self'` reicht — auch in BlueTalk Web ohne blob:.
 */
import captureWorkletUrl from './worklets/capture.worklet.js?url&no-inline';
import playbackWorkletUrl from './worklets/playback.worklet.js?url&no-inline';

export function getWorkletUrls() {
  return {
    capture: captureWorkletUrl,
    playback: playbackWorkletUrl,
  };
}

export async function addCallWorklets(audioContext) {
  const { capture, playback } = getWorkletUrls();
  await audioContext.audioWorklet.addModule(capture);
  await audioContext.audioWorklet.addModule(playback);
}
