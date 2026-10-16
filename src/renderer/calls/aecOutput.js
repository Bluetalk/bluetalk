/**
 * Chromium/WebView2 nimmt Audio aus AudioContext.destination NICHT als
 * AEC-Referenz. Workaround: Wiedergabe über MediaStreamDestination →
 * lokales RTCPeerConnection-Paar → <audio>, damit der Pfad durch WebRTC läuft.
 * Scheitert das (kein RTCPeerConnection, Autoplay, …), direkt ausgeben.
 */
export async function attachAecOutput(audioContext, sourceNode) {
  const fallback = () => {
    sourceNode.connect(audioContext.destination);
    return {
      close() {
        try { sourceNode.disconnect(); } catch { /* ignore */ }
      },
    };
  };

  const canLoopback = typeof RTCPeerConnection === 'function'
    && typeof audioContext.createMediaStreamDestination === 'function';
  if (!canLoopback) return fallback();

  let dest = null;
  let pcOut = null;
  let pcIn = null;
  let audio = null;
  try {
    dest = audioContext.createMediaStreamDestination();
    sourceNode.connect(dest);
    pcOut = new RTCPeerConnection();
    pcIn = new RTCPeerConnection();
    for (const track of dest.stream.getAudioTracks()) {
      pcOut.addTrack(track, dest.stream);
    }
    const remote = new MediaStream();
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.muted = false;
    audio.style.display = 'none';
    document.body.appendChild(audio);
    pcIn.ontrack = (event) => {
      if (event.track) remote.addTrack(event.track);
      audio.srcObject = remote;
      void audio.play().catch(() => { /* Autoplay; Nutzer hat den Anruf gestartet */ });
    };
    pcOut.onicecandidate = (event) => {
      if (event.candidate) void pcIn.addIceCandidate(event.candidate);
    };
    pcIn.onicecandidate = (event) => {
      if (event.candidate) void pcOut.addIceCandidate(event.candidate);
    };
    const offer = await pcOut.createOffer();
    await pcOut.setLocalDescription(offer);
    await pcIn.setRemoteDescription(offer);
    const answer = await pcIn.createAnswer();
    await pcIn.setLocalDescription(answer);
    await pcOut.setRemoteDescription(answer);
    return {
      close() {
        try { sourceNode.disconnect(dest); } catch { /* ignore */ }
        try { pcOut.close(); } catch { /* ignore */ }
        try { pcIn.close(); } catch { /* ignore */ }
        if (audio) {
          try { audio.pause(); } catch { /* ignore */ }
          try { audio.srcObject = null; } catch { /* ignore */ }
          try { audio.remove(); } catch { /* ignore */ }
        }
      },
    };
  } catch {
    try { sourceNode.disconnect(); } catch { /* ignore */ }
    try { pcOut?.close(); } catch { /* ignore */ }
    try { pcIn?.close(); } catch { /* ignore */ }
    if (audio) {
      try { audio.remove(); } catch { /* ignore */ }
    }
    return fallback();
  }
}
