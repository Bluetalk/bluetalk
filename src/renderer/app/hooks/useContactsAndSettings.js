// Kontakte, Settings, Theme und kleinere App-Aktionen, 1:1 aus App.jsx ausgelagert.
import { useEffect, useCallback } from 'react';
import { buildUserPresencePayload } from '../../../shared/user-presence.js';

export function useContactsAndSettings({
  theme,
  setTheme,
  setContacts,
  setSettings,
  setPeers,
  setChatLastViewedPeerTs,
  setShowUsernameOnboarding,
}) {
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const applyContactPatch = useCallback((prev, patch) => {
    if (!patch?.id) return prev;
    const idx = prev.findIndex((c) => c.id === patch.id);
    const base = idx >= 0 ? prev[idx] : { id: patch.id, addedAt: Date.now() };
    const merged = { ...base, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedUntil') && patch.notifyMutedUntil === undefined) {
      delete merged.notifyMutedUntil;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'notifyMutedManual') && patch.notifyMutedManual === false) {
      delete merged.notifyMutedManual;
    }
    return idx >= 0
      ? prev.map((contact, i) => (i === idx ? merged : contact))
      : [...prev, merged];
  }, []);

  const upsertContact = useCallback((patch) => {
    if (!patch?.id) return;
    setContacts((prev) => {
      const updated = applyContactPatch(prev, patch);
      if (window.bluetalk) void window.bluetalk.store.set('contacts', updated);
      return updated;
    });
  }, [applyContactPatch]);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    // Auch den settings-State mitziehen, sonst überschreibt ein späteres
    // updateSettings (persistiert das ganze Objekt) das Theme mit dem alten Wert.
    setSettings((prev) => ({ ...prev, theme: next }));
    if (window.bluetalk) window.bluetalk.store.set('settings.theme', next);
  }, [theme]);

  const markPeerChatViewed = useCallback((peerId, upToPeerMessageTimestamp) => {
    if (!peerId || typeof upToPeerMessageTimestamp !== 'number' || upToPeerMessageTimestamp <= 0) return;
    setChatLastViewedPeerTs((prev) => {
      const cur = typeof prev[peerId] === 'number' ? prev[peerId] : 0;
      if (upToPeerMessageTimestamp <= cur) return prev;
      const next = { ...prev, [peerId]: upToPeerMessageTimestamp };
      if (window.bluetalk) window.bluetalk.store.set('chatLastViewedPeerTs', next);
      return next;
    });
  }, []);

  const connectToAddress = useCallback(async (address) => {
    if (!window.bluetalk || !address?.trim()) {
      throw new Error('Address is required');
    }

    const peerInfo = await window.bluetalk.peer.connect(address.trim());
    upsertContact({
      id: peerInfo.id,
      name: peerInfo.name || peerInfo.id,
      address: address.trim(),
      hasOutgoing: true,
      bio: peerInfo.bio,
      profilePicture: peerInfo.profilePicture,
    });

    return peerInfo;
  }, [upsertContact]);

  const refreshDiscovery = useCallback(async () => {
    if (!window.bluetalk) return;
    await window.bluetalk.peer.refreshDiscovery();
    const list = await window.bluetalk.peer.getPeers();
    setPeers(list || []);
  }, []);

  const acceptMessageRequest = useCallback((peerId) => {
    if (!peerId) return;
    upsertContact({ id: peerId, pendingMessageRequest: false });
  }, [upsertContact]);

  const setContactNickname = useCallback((contactId, nickname) => {
    if (!contactId) return;
    upsertContact({ id: contactId, nickname: (nickname || '').trim() });
  }, [upsertContact]);

  const setChatPinned = useCallback((contactId, pinned) => {
    if (!contactId) return;
    upsertContact({ id: contactId, pinned: Boolean(pinned) });
  }, [upsertContact]);

  /**
   * @param {string} contactId
   * @param {{ clear?: boolean, manual?: boolean, until?: number }} opts
   *   clear: Mitteilungen wieder an; manual: stumm bis manuell aufheben; until: Stummschaltung bis Zeitstempel (ms)
   */
  const setContactNotificationMute = useCallback((contactId, opts = {}) => {
    if (!contactId) return;
    if (opts.clear) {
      upsertContact({ id: contactId, notifyMutedManual: false, notifyMutedUntil: undefined });
      return;
    }
    if (opts.manual === true) {
      upsertContact({ id: contactId, notifyMutedManual: true, notifyMutedUntil: undefined });
      return;
    }
    if (typeof opts.until === 'number') {
      upsertContact({ id: contactId, notifyMutedManual: false, notifyMutedUntil: opts.until });
    }
  }, [upsertContact]);

  const removeContact = useCallback((contactId) => {
    setContacts((prev) => {
      const updated = prev.filter((c) => c.id !== contactId);
      if (window.bluetalk) window.bluetalk.store.set('contacts', updated);
      return updated;
    });
  }, []);

  const updateSettings = useCallback((newSettings) => {
    setSettings((prev) => {
      const merged = { ...prev, ...newSettings };
      if (newSettings.uiResize && typeof newSettings.uiResize === 'object') {
        merged.uiResize = {
          ...(prev.uiResize || {}),
          ...newSettings.uiResize,
        };
      }
      if (newSettings.uiCollapse && typeof newSettings.uiCollapse === 'object') {
        merged.uiCollapse = {
          ...(prev.uiCollapse || {}),
          ...newSettings.uiCollapse,
        };
      }
      if (window.bluetalk) {
        window.bluetalk.store.set('settings', merged);
        const profileKeys = ['displayName', 'bio', 'profilePicture'];
        if (profileKeys.some((k) => Object.prototype.hasOwnProperty.call(newSettings, k))) {
          window.bluetalk.peer.broadcast({
            kind: 'profile',
            displayName: merged.displayName,
            bio: merged.bio || '',
            profilePicture: merged.profilePicture || '',
            sender: merged.displayName,
          });
        }
        if (Object.prototype.hasOwnProperty.call(newSettings, 'doNotDisturb')) {
          window.bluetalk.peer.broadcast(buildUserPresencePayload(merged));
        }
      }
      return merged;
    });
  }, []);

  const completeUsernameOnboarding = useCallback((name) => {
    updateSettings({ displayName: name, onboardingUsernameDone: true });
    setShowUsernameOnboarding(false);
  }, [updateSettings]);

  return {
    applyContactPatch,
    upsertContact,
    toggleTheme,
    markPeerChatViewed,
    connectToAddress,
    refreshDiscovery,
    acceptMessageRequest,
    setContactNickname,
    setChatPinned,
    setContactNotificationMute,
    removeContact,
    updateSettings,
    completeUsernameOnboarding,
  };
}
