const STAY_KEY = 'bluetalk-web-stay';
const ALIVE_KEY = 'bluetalk-web-alive';

function storageGet(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    /* privater Modus / Quota */
  }
}

function storageRemove(store, key) {
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** true = Sitzung über Tab-Schließung hinweg behalten (Standard). */
export function setStayLoggedIn(stay) {
  if (stay) {
    storageSet(localStorage, STAY_KEY, '1');
    storageRemove(sessionStorage, ALIVE_KEY);
  } else {
    storageSet(localStorage, STAY_KEY, '0');
    storageSet(sessionStorage, ALIVE_KEY, '1');
  }
}

export function clearStayFlags() {
  storageRemove(localStorage, STAY_KEY);
  storageRemove(sessionStorage, ALIVE_KEY);
}

export function shouldPurgeEphemeral() {
  if (storageGet(localStorage, STAY_KEY) !== '0') return false;
  return !storageGet(sessionStorage, ALIVE_KEY);
}
