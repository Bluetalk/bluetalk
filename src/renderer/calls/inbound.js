/**
 * Frühe Weiterleitung aus peerMessageHandler — ohne React-State.
 * CallManager registriert sich beim Start des CallProviders.
 */
let handler = null;

export function setCallInboundHandler(fn) {
  handler = typeof fn === 'function' ? fn : null;
}

export function dispatchCallInbound(fromId, msg) {
  if (!handler) return;
  try {
    handler(fromId, msg);
  } catch (error) {
    console.warn('[calls] inbound failed', error);
  }
}
