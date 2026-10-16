import React, { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
} from 'lucide-react';
import { CHAT_ICON_STROKE, PeerAvatar } from '../pages/chats/messageHelpers.jsx';
import { formatDurationMs } from '../voice/format.js';
import { callHasVideo, videoControlHint } from './callState.js';

function qualityFromRtt(rttMs) {
  if (rttMs == null) return { label: 'Verbinden…', kind: 'unknown' };
  if (rttMs < 80) return { label: 'Sehr gut', kind: 'great' };
  if (rttMs < 150) return { label: 'Gut', kind: 'good' };
  if (rttMs < 300) return { label: 'Okay', kind: 'ok' };
  return { label: 'Schwach', kind: 'poor' };
}

export function VideoStage({
  call,
  name,
  picture,
  transport,
  muted,
  videoCapable,
  peerVideoCapable,
  onToggleMute,
  onToggleCamera,
  onToggleScreen,
  onHangup,
  onMinimize,
  getLocalStreams,
  setVideoSink,
}) {
  const remoteCamRef = useRef(null);
  const remoteScreenRef = useRef(null);
  const localVideoRef = useRef(null);
  const localTileRef = useRef(null);
  const stageRef = useRef(null);
  const [elapsed, setElapsed] = useState(() => Date.now() - (call.connectedAt || Date.now()));
  const [pip, setPip] = useState({ x: 16, y: 16 });
  const [fullscreen, setFullscreen] = useState(false);
  const drag = useRef(null);

  const screenFocus = Boolean(call.remoteScreen || call.localScreen);
  const showRemoteCam = Boolean(call.remoteCamera);
  const showLocalCam = Boolean(call.localCamera);

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Date.now() - (call.connectedAt || Date.now()));
    }, 250);
    return () => window.clearInterval(id);
  }, [call.connectedAt]);

  useEffect(() => {
    setVideoSink?.('camera', remoteCamRef.current);
    setVideoSink?.('screen', remoteScreenRef.current);
    return () => {
      setVideoSink?.('camera', null);
      setVideoSink?.('screen', null);
    };
  }, [setVideoSink, screenFocus, showRemoteCam]);

  useEffect(() => {
    const el = localVideoRef.current;
    const stream = getLocalStreams?.()?.camera;
    if (el) el.srcObject = showLocalCam ? stream : null;
    return () => {
      if (el) el.srcObject = null;
    };
  }, [getLocalStreams, showLocalCam, call.localCamera]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  function onPipPointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const tile = localTileRef.current;
    const stage = stageRef.current;
    if (!tile || !stage) return;
    const rect = tile.getBoundingClientRect();
    drag.current = {
      dx: event.clientX - rect.left,
      dy: event.clientY - rect.top,
    };
    tile.setPointerCapture?.(event.pointerId);
  }

  function onPipPointerMove(event) {
    if (!drag.current) return;
    const stage = stageRef.current;
    const tile = localTileRef.current;
    if (!stage || !tile) return;
    const stageRect = stage.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    const barReserve = 72;
    const maxX = Math.max(8, stageRect.width - tileRect.width - 8);
    const maxY = Math.max(8, stageRect.height - tileRect.height - barReserve);
    const x = Math.min(maxX, Math.max(8, event.clientX - stageRect.left - drag.current.dx));
    const y = Math.min(maxY, Math.max(8, event.clientY - stageRect.top - drag.current.dy));
    setPip({ x, y });
  }

  function onPipPointerUp(event) {
    drag.current = null;
    localTileRef.current?.releasePointerCapture?.(event.pointerId);
  }

  async function toggleFullscreen() {
    const node = stageRef.current;
    if (!node) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await node.requestFullscreen();
    } catch {
      /* WebView/Browser ohne Fullscreen */
    }
  }

  const quality = qualityFromRtt(call.rttMs);
  const viaCloud = transport === 'relay';
  const canVideo = Boolean(videoCapable && peerVideoCapable);
  const videoDisabledHint = videoControlHint(videoCapable, peerVideoCapable);
  const hasVideo = callHasVideo(call);

  return (
    <div
      className={`call-stage${fullscreen ? ' is-fullscreen' : ''}`}
      role="dialog"
      aria-label="Videoanruf"
    >
      <div className="call-stage-surface" ref={stageRef}>
        <div className={`call-stage-main${screenFocus ? ' is-screen' : ''}`}>
          {screenFocus ? (
            <>
              <canvas
                ref={remoteScreenRef}
                className="call-stage-canvas call-stage-canvas--screen"
                aria-label="Bildschirm des Gegenübers"
              />
              {!call.remoteScreen && call.localScreen ? (
                <div className="call-stage-placeholder">
                  <Monitor size={28} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                  <span>Dein Bildschirm wird übertragen</span>
                </div>
              ) : null}
            </>
          ) : showRemoteCam ? (
            <canvas
              ref={remoteCamRef}
              className="call-stage-canvas"
              aria-label="Kamera des Gegenübers"
            />
          ) : (
            <div className="call-stage-placeholder call-stage-placeholder--peer">
              <PeerAvatar pictureUrl={picture} name={name} size={96} />
              <span>{hasVideo ? 'Warte auf Video…' : name}</span>
            </div>
          )}
        </div>

        {showLocalCam ? (
          <div
            ref={localTileRef}
            className={`call-stage-pip${screenFocus ? ' call-stage-pip--tile' : ''}`}
            style={{ transform: `translate(${pip.x}px, ${pip.y}px)` }}
            onPointerDown={onPipPointerDown}
            onPointerMove={onPipPointerMove}
            onPointerUp={onPipPointerUp}
            onPointerCancel={onPipPointerUp}
          >
            <video ref={localVideoRef} className="call-stage-local-video" muted playsInline autoPlay />
            <span className="call-stage-pip-label">Du</span>
          </div>
        ) : null}

        {screenFocus && showRemoteCam ? (
          <div className="call-stage-cam-tile">
            <canvas ref={remoteCamRef} className="call-stage-canvas" aria-label="Kamera des Gegenübers" />
          </div>
        ) : null}

        <div className="call-stage-top">
          <div className="call-stage-identity">
            <PeerAvatar pictureUrl={picture} name={name} size={28} />
            <div>
              <div className="call-stage-name">{name}</div>
              <div className="call-stage-sub">
                <span className="call-stage-time">{formatDurationMs(elapsed)}</span>
                <span className="call-float-dot" aria-hidden />
                <span className={`call-quality is-${quality.kind}`}>{quality.label}</span>
                <span className="call-float-dot" aria-hidden />
                <span>{viaCloud ? 'Cloud' : 'Direkt'}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="call-stage-bar">
          <button
            type="button"
            className={`call-stage-btn${muted ? ' is-off' : ''}`}
            onClick={onToggleMute}
            title={muted ? 'Mikrofon an' : 'Stummschalten'}
          >
            {muted
              ? <MicOff size={18} strokeWidth={CHAT_ICON_STROKE} />
              : <Mic size={18} strokeWidth={CHAT_ICON_STROKE} />}
          </button>
          <button
            type="button"
            className={`call-stage-btn${!call.localCamera ? ' is-off' : ''}`}
            onClick={onToggleCamera}
            disabled={!canVideo}
            title={videoDisabledHint || (call.localCamera ? 'Kamera aus' : 'Kamera an')}
          >
            {call.localCamera
              ? <Video size={18} strokeWidth={CHAT_ICON_STROKE} />
              : <VideoOff size={18} strokeWidth={CHAT_ICON_STROKE} />}
          </button>
          <button
            type="button"
            className={`call-stage-btn${!call.localScreen ? ' is-off' : ''}`}
            onClick={onToggleScreen}
            disabled={!canVideo}
            title={videoDisabledHint || (call.localScreen ? 'Bildschirm beenden' : 'Bildschirm teilen')}
          >
            {call.localScreen
              ? <MonitorOff size={18} strokeWidth={CHAT_ICON_STROKE} />
              : <Monitor size={18} strokeWidth={CHAT_ICON_STROKE} />}
          </button>
          <button
            type="button"
            className="call-stage-btn"
            onClick={toggleFullscreen}
            title={fullscreen ? 'Vollbild beenden' : 'Vollbild'}
          >
            <Maximize2 size={18} strokeWidth={CHAT_ICON_STROKE} />
          </button>
          <button
            type="button"
            className="call-stage-btn"
            onClick={onMinimize}
            title="Minimieren"
          >
            <Minimize2 size={18} strokeWidth={CHAT_ICON_STROKE} />
          </button>
          <button
            type="button"
            className="call-stage-btn call-stage-btn--hangup"
            onClick={onHangup}
            title="Auflegen"
          >
            <PhoneOff size={18} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
      </div>
    </div>
  );
}
