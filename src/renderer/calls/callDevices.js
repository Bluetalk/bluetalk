/**
 * Geräte-Bindung für Anrufe (ab 2.4): Offer an alle, nach accept nur noch
 * das annehmende Gerät. Reine Logik, ohne I/O.
 */

export function uniqueDevices(list) {
  const out = [];
  for (const id of list || []) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Gebundener Anruf: Nachrichten anderer Geräte verwerfen. Alte Clients ohne fromDevice durchlassen. */
export function shouldDropBoundMessage(remoteDevice, fromDevice) {
  if (!remoteDevice) return false;
  if (!fromDevice) return false;
  return fromDevice !== remoteDevice;
}

/**
 * busy eines Geräts beendet den Anruf nur, wenn alle bekannten klingelnden
 * Geräte busy gemeldet haben. Ohne fromDevice (alte Clients) bleibt das
 * bisherige 1-Geräte-Verhalten: sofort besetzt.
 */
export function applyRemoteBusy(state, fromDevice) {
  const ringing = uniqueDevices(state?.ringingDevices);
  if (!fromDevice) {
    return { ringing, busy: uniqueDevices(state?.busyDevices), endBusy: true };
  }
  const busy = uniqueDevices([...(state?.busyDevices || []), fromDevice]);
  const waiting = ringing.filter((id) => !busy.includes(id));
  const endBusy = ringing.length > 0 && waiting.length === 0;
  return { ringing, busy, endBusy };
}

export function devicesToCancel(ringingDevices, exceptDevice) {
  return uniqueDevices(ringingDevices).filter((id) => id !== exceptDevice);
}

export function isAnsweredElsewhere(reason) {
  return reason === 'answered-elsewhere';
}
