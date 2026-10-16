import { useEffect } from 'react';
import { DEFAULT_APP_SETTINGS } from '../chatConstants';
import groupChat from '../../../shared/group-chat.js';
import { getAccount, requestPull, startSync, stopSync } from '../../cloudAccount/index.js';
import { buildProfilePayload } from '../profileShare.js';
import { buildUserPresencePayload } from '../../../shared/user-presence.js';

const { normalizeGroup } = groupChat;

export function useCloudAccountSync({
  loadChatMessages,
  setContacts,
  setSettings,
  setTheme,
  setGroups,
  groupsRef,
  setPeerReadReceipts,
  setChatLastViewedPeerTs,
  setChatMeta,
  setMessages,
  setLoadedChats,
  setE2eeBootNonce,
  messageCacheRef,
}) {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const account = await getAccount();
        if (!cancelled && account) await startSync();
      } catch {
        /* Sync startet später nach Login */
      }
    })();
    const offSync = window.bluetalk?.cloud?.onSync?.(() => {
      requestPull();
    });
    return () => {
      cancelled = true;
      offSync?.();
      stopSync();
    };
  }, []);

  useEffect(() => {
    const onApplied = (event) => {
      const detail = event?.detail || {};
      const storeKeys = Array.isArray(detail.storeKeys) ? detail.storeKeys : [];
      const peers = Array.isArray(detail.peers) ? detail.peers : [];
      void reloadFromStore({
        storeKeys,
        peers,
        loadChatMessages,
        setContacts,
        setSettings,
        setTheme,
        setGroups,
        groupsRef,
        setPeerReadReceipts,
        setChatLastViewedPeerTs,
        setChatMeta,
        setMessages,
        setLoadedChats,
        setE2eeBootNonce,
        messageCacheRef,
      });
    };
    window.addEventListener('bluetalk:sync-applied', onApplied);
    return () => window.removeEventListener('bluetalk:sync-applied', onApplied);
  }, [
    loadChatMessages,
    setContacts,
    setSettings,
    setTheme,
    setGroups,
    groupsRef,
    setPeerReadReceipts,
    setChatLastViewedPeerTs,
    setChatMeta,
    setMessages,
    setLoadedChats,
    setE2eeBootNonce,
    messageCacheRef,
  ]);
}

async function reloadFromStore({
  storeKeys,
  peers,
  loadChatMessages,
  setContacts,
  setSettings,
  setTheme,
  setGroups,
  groupsRef,
  setPeerReadReceipts,
  setChatLastViewedPeerTs,
  setChatMeta,
  setMessages,
  setLoadedChats,
  setE2eeBootNonce,
  messageCacheRef,
}) {
  if (!window.bluetalk?.store) return;
  const keys = new Set(storeKeys);
  try {
    if (keys.has('contacts')) {
      const contacts = await window.bluetalk.store.get('contacts', []);
      setContacts(Array.isArray(contacts) ? contacts : []);
    }
    if (keys.has('settings')) {
      const stored = await window.bluetalk.store.get('settings', {});
      const merged = { ...DEFAULT_APP_SETTINGS, ...(stored && typeof stored === 'object' ? stored : {}) };
      setSettings(merged);
      if (merged.theme) setTheme(merged.theme);
      try {
        window.bluetalk.peer?.broadcast?.(buildProfilePayload(merged));
        window.bluetalk.peer?.broadcast?.(buildUserPresencePayload(merged));
      } catch {
        /* Peers ggf. noch nicht verbunden */
      }
    }
    if (keys.has('groups')) {
      const storedGroups = await window.bluetalk.store.get('groups', []);
      const normalized = [];
      for (const raw of Array.isArray(storedGroups) ? storedGroups : []) {
        try {
          normalized.push(normalizeGroup(raw));
        } catch {
          /* skip */
        }
      }
      groupsRef.current = normalized;
      setGroups(normalized);
    }
    if (keys.has('chatReadReceipts')) {
      const receipts = await window.bluetalk.store.get('chatReadReceipts', {});
      setPeerReadReceipts(receipts && typeof receipts === 'object' ? receipts : {});
    }
    if (keys.has('chatLastViewedPeerTs')) {
      const viewed = await window.bluetalk.store.get('chatLastViewedPeerTs', {});
      setChatLastViewedPeerTs(viewed && typeof viewed === 'object' ? viewed : {});
    }
    if (keys.has('e2eeSessions')) {
      setE2eeBootNonce((n) => n + 1);
    }
  } catch {
    /* Store-Reload best effort */
  }

  if (peers.length && window.bluetalk.messages) {
    try {
      const meta = await window.bluetalk.messages.getMeta();
      setChatMeta(meta || {});
    } catch {
      /* ignore */
    }
    for (const peerId of peers) {
      if (!peerId) continue;
      try {
        await loadChatMessages(peerId, { reset: true });
      } catch {
        setMessages((prev) => {
          const next = { ...prev };
          delete next[peerId];
          messageCacheRef.current = next;
          return next;
        });
        setLoadedChats((prev) => {
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      }
    }
  }
}
