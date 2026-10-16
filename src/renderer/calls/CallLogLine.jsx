import React from 'react';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOff } from 'lucide-react';
import { CHAT_ICON_STROKE } from '../pages/chats/messageHelpers.jsx';
import { formatDurationMs } from '../voice/format.js';

export function isCallLogMessage(message) {
  return message?.kind === 'call-log';
}

export function callLogPreviewText(message) {
  return callLogLabel(message);
}

export function CallLogLine({ message }) {
  const Icon = iconFor(message);
  return (
    <div className="call-log-line" role="note">
      <Icon size={13} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
      <span>{callLogLabel(message)}</span>
    </div>
  );
}

function callLogLabel(message) {
  const outcome = message?.outcome;
  const direction = message?.direction;
  if (outcome === 'missed') return 'Verpasster Anruf';
  if (outcome === 'rejected') return direction === 'out' ? 'Anruf abgelehnt' : 'Anruf abgelehnt';
  if (outcome === 'busy' ) return 'Besetzt';
  if (outcome === 'failed') return 'Anruf fehlgeschlagen';
  const duration = formatDurationMs(message?.durationMs || 0);
  return `${message?.video ? 'Videoanruf' : 'Sprachanruf'} · ${duration}`;
}

function iconFor(message) {
  const outcome = message?.outcome;
  if (outcome === 'missed') return PhoneMissed;
  if (outcome === 'rejected' || outcome === 'failed' || outcome === 'busy') return PhoneOff;
  if (message?.direction === 'in') return PhoneIncoming;
  return Phone;
}
