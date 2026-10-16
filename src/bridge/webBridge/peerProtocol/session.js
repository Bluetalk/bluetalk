import { bytesToHex, randomBytes } from './bytes.js';
import { HEARTBEAT_MS, IDLE_TIMEOUT_MS, MAX_FRAME_BYTES } from './constants.js';
import { ByteAssembler, decodeWireFrame, encodePrefixed, encodeWireFrame } from './frames.js';
import { initiatorHandshake, responderHandshake, createStreamTransport } from './handshake.js';
import { randomHex } from './identity.js';

export function peerInfoFromSession(session, remoteAddress, direction) {
  return {
    id: session.remotePeerId,
    name: session.remoteDisplayName,
    address: remoteAddress,
    port: 0,
    ports: [],
    connectedAt: Date.now(),
    direction,
    encrypted: true,
    supportsHeartbeat: true,
    transport: remoteAddress.startsWith('relay://') ? 'relay' : 'direct',
  };
}

export class PeerSession {
  constructor({
    transport,
    session,
    info,
    maxFrameBytes = MAX_FRAME_BYTES,
    onMessage,
    onClose,
  }) {
    this.transport = transport;
    this.session = session;
    this.info = info;
    this.maxFrameBytes = maxFrameBytes;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.closed = false;
    this.idleTimer = null;
    this.heartbeatTimer = null;
    this.reader = this.readLoop();
    this.armIdle();
    this.heartbeatTimer = setInterval(() => {
      void this.sendPing();
    }, HEARTBEAT_MS);
  }

  armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      void this.close('idle timeout');
    }, IDLE_TIMEOUT_MS);
  }

  async sendPayload(payload) {
    if (this.closed) return false;
    const frame = {
      type: 'message',
      messageId: bytesToHex(randomBytes(12)),
      sentAtMs: Date.now(),
      payload,
    };
    return this.sendFrame(frame);
  }

  async sendFrame(frame) {
    if (this.closed) return false;
    const encoded = encodeWireFrame(frame, this.maxFrameBytes);
    const record = this.session.send.encrypt(encoded);
    await this.transport.write(encodePrefixed(record, this.session.send.maxPlaintextBytes + 8 + 16));
    return true;
  }

  async sendPing() {
    try {
      await this.sendFrame({ type: 'ping', nonce: randomHex(8) });
    } catch {
      await this.close('heartbeat write failed');
    }
  }

  async readLoop() {
    try {
      while (!this.closed) {
        const record = await this.transport.readPrefixed(this.session.receive.maximumRecordBytes());
        this.armIdle();
        const plaintext = this.session.receive.decrypt(record);
        const frame = decodeWireFrame(plaintext, this.maxFrameBytes);
        if (frame.type === 'message') {
          this.onMessage?.({
            fromPeerId: this.info.id,
            messageId: frame.messageId,
            sentAtMs: frame.sentAtMs,
            payload: frame.payload,
          });
        } else if (frame.type === 'ping') {
          void this.sendFrame({ type: 'pong', nonce: frame.nonce });
        } else if (frame.type === 'pong') {
          // keepalive
        } else if (frame.type === 'close') {
          await this.close(frame.reason || 'closed by peer', { notifyRemote: false });
          return;
        }
      }
    } catch (error) {
      await this.close(error?.message || 'connection closed', { notifyRemote: false });
    }
  }

  async close(reason = 'closed locally', { notifyRemote = true } = {}) {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (notifyRemote) {
      try {
        const encoded = encodeWireFrame({ type: 'close', reason }, this.maxFrameBytes);
        const record = this.session.send.encrypt(encoded);
        await this.transport.write(encodePrefixed(record, this.session.send.maxPlaintextBytes + 8 + 16));
      } catch {
        // best-effort
      }
    }
    this.transport.close();
    this.onClose?.(reason);
  }
}

export async function openInitiatorSession({
  sendBytes,
  identity,
  displayName,
  expectedPeerId,
  remoteAddress,
  maxFrameBytes = MAX_FRAME_BYTES,
  onMessage,
  onClose,
}) {
  const transport = createStreamTransport(sendBytes, () => {});
  const handshake = initiatorHandshake(transport, identity, displayName, expectedPeerId, maxFrameBytes);
  return { transport, ready: finishOpen(handshake, transport, remoteAddress, 'outbound', maxFrameBytes, onMessage, onClose) };
}

export async function openResponderSession({
  sendBytes,
  identity,
  displayName,
  remoteAddress,
  maxFrameBytes = MAX_FRAME_BYTES,
  onMessage,
  onClose,
}) {
  const transport = createStreamTransport(sendBytes, () => {});
  const handshake = responderHandshake(transport, identity, displayName, maxFrameBytes);
  return { transport, ready: finishOpen(handshake, transport, remoteAddress, 'inbound', maxFrameBytes, onMessage, onClose) };
}

async function finishOpen(handshakePromise, transport, remoteAddress, direction, maxFrameBytes, onMessage, onClose) {
  const session = await handshakePromise;
  const info = peerInfoFromSession(session, remoteAddress, direction);
  const peer = new PeerSession({
    transport,
    session,
    info,
    maxFrameBytes,
    onMessage,
    onClose,
  });
  return { session, info, peer };
}

export { ByteAssembler };
