import { utf8 } from './bytes.js';

export const PROTOCOL_VERSION = 2;
export const HANDSHAKE_MAGIC = 'BLUETALK_SECURE_SESSION';
export const HANDSHAKE_ENVELOPE_VERSION = 1;
export const MAX_HANDSHAKE_BYTES = 64 * 1024;
export const MAX_HANDSHAKE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const CLIENT_SIGNATURE_DOMAIN = utf8('BlueTalk/v2/client-hello\0');
export const SERVER_SIGNATURE_DOMAIN = utf8('BlueTalk/v2/server-hello\0');
export const RECORD_AAD_DOMAIN = utf8('BlueTalk/v2/record\0');
export const TRANSCRIPT_DOMAIN = utf8('BlueTalk/v2/transcript/1\0');
export const SESSION_KDF_INFO = utf8('BlueTalk/v2/session-keys/1');
export const HEARTBEAT_MS = 25_000;
export const IDLE_TIMEOUT_MS = 90_000;
export const WRITE_TIMEOUT_MS = 10_000;
export const HANDSHAKE_TIMEOUT_MS = 8_000;
