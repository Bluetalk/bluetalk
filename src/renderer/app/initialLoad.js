// Initiales Laden der persistierten Daten (Kontakte, Settings, Gruppen, …),
// 1:1 aus dem useLayoutEffect in App.jsx ausgelagert.
import { DEFAULT_APP_SETTINGS } from './chatConstants';
import { buildUserPresencePayload } from '../../shared/user-presence.js';
import groupChat from '../../shared/group-chat.js';

const { normalizeGroup } = groupChat;

/**
 * @param {object} deps Setter/Refs aus App()
 * @param {() => boolean} isCancelled Ersetzt die frühere `cancelled`-Closure-Variable.
 */
export async function loadInitialData(deps, isCancelled) {
  const {
    setContacts,
    setChatMeta,
    setGroups,
    setOwnPeerId,
    setChatLastViewedPeerTs,
    setPeerReadReceipts,
    setGameInviteKeys,
    setDocInvites,
    setSettings,
    setTheme,
    setShowUsernameOnboarding,
    setUsernameOnboardingGateReady,
    setPeers,
    setLoadError,
    groupsRef,
    ownPeerIdRef,
    groupOutboxRef,
    groupEventIdsRef,
  } = deps;

  try {
    const [
      storedContacts,
      storedChatMeta,
      storedSettings,
      storedReadReceipts,
      currentPeers,
      storedInviteKeys,
      storedGroups,
      peerInfo,
      storedGroupOutbox,
      storedGroupEventIds,
      storedDocInvites,
    ] = await Promise.all([
      window.bluetalk.store.get('contacts', []),
      window.bluetalk.messages.getMeta(),
      window.bluetalk.store.get('settings', {}),
      window.bluetalk.store.get('chatReadReceipts', {}),
      window.bluetalk.peer.getPeers(),
      window.bluetalk.store.get('gameInviteKeys', []),
      window.bluetalk.store.get('groups', []),
      window.bluetalk.peer.getInfo(),
      window.bluetalk.store.get('groupOutbox', []),
      window.bluetalk.store.get('groupEventIds', []),
      window.bluetalk.store.get('liveDocsInvites', []),
    ]);

    if (isCancelled()) return;

    const meta = storedChatMeta || {};
    let migrated = false;
    const normalized = (storedContacts || []).map((c) => {
      if (!c?.id) return c;
      const count = meta[c.id]?.count || 0;
      if (count > 0 && c.hasOutgoing !== true && c.pendingMessageRequest !== true) {
        migrated = true;
        return { ...c, hasOutgoing: true };
      }
      return c;
    });
    if (migrated) {
      window.bluetalk.store.set('contacts', normalized);
    }

    setContacts(normalized);
    setChatMeta(meta);
    const normalizedGroups = [];
    for (const rawGroup of Array.isArray(storedGroups) ? storedGroups : []) {
      try {
        normalizedGroups.push(normalizeGroup(rawGroup));
      } catch {
        /* skip invalid persisted group */
      }
    }
    groupsRef.current = normalizedGroups;
    setGroups(normalizedGroups);
    ownPeerIdRef.current = peerInfo?.id || '';
    setOwnPeerId(peerInfo?.id || '');
    groupOutboxRef.current = Array.isArray(storedGroupOutbox) ? storedGroupOutbox : [];
    groupEventIdsRef.current = Array.isArray(storedGroupEventIds) ? storedGroupEventIds : [];

    const storedViewed = await window.bluetalk.store.get('chatLastViewedPeerTs', {});
    const viewedRaw = storedViewed && typeof storedViewed === 'object' ? storedViewed : {};
    const viewed = {};
    for (const [k, v] of Object.entries(viewedRaw)) {
      if (typeof v === 'number' && !Number.isNaN(v)) viewed[k] = v;
    }
    let viewedDirty = false;
    for (const [peerId, row] of Object.entries(meta || {})) {
      if (peerId === 'self') continue;
      if (viewed[peerId] != null) continue;
      const lm = row?.lastMessage;
      if (!lm || typeof lm.timestamp !== 'number') continue;
      if (lm.from === 'self') {
        viewed[peerId] = lm.timestamp;
        viewedDirty = true;
      }
    }
    if (viewedDirty) window.bluetalk.store.set('chatLastViewedPeerTs', viewed);
    setChatLastViewedPeerTs(viewed);

    setPeerReadReceipts(storedReadReceipts && typeof storedReadReceipts === 'object' ? storedReadReceipts : {});

    if (Array.isArray(storedInviteKeys) && storedInviteKeys.length) {
      setGameInviteKeys(new Set(storedInviteKeys.filter((key) => typeof key === 'string' && key.length)));
    }

    if (Array.isArray(storedDocInvites) && storedDocInvites.length) {
      setDocInvites?.(storedDocInvites.filter((entry) => entry && typeof entry.roomId === 'string' && entry.roomId));
    }

    const stored = storedSettings && typeof storedSettings === 'object' ? storedSettings : {};
    let mergedSettings = { ...DEFAULT_APP_SETTINGS, ...stored };
    mergedSettings.uiResize = {
      ...(DEFAULT_APP_SETTINGS.uiResize || {}),
      ...(stored.uiResize && typeof stored.uiResize === 'object' ? stored.uiResize : {}),
    };
    mergedSettings.uiCollapse = {
      ...(DEFAULT_APP_SETTINGS.uiCollapse || {}),
      ...(stored.uiCollapse && typeof stored.uiCollapse === 'object' ? stored.uiCollapse : {}),
    };
    const displayNameTrim = (mergedSettings.displayName || '').trim();
    if (mergedSettings.onboardingUsernameDone !== true && displayNameTrim && displayNameTrim !== 'Anonymous') {
      mergedSettings = { ...mergedSettings, onboardingUsernameDone: true };
      window.bluetalk.store.set('settings', mergedSettings);
    }
    setSettings(mergedSettings);
    if (mergedSettings.theme) setTheme(mergedSettings.theme);
    void window.bluetalk.peer.broadcast(buildUserPresencePayload(mergedSettings));

    const needsUsernameOnboarding = mergedSettings.onboardingUsernameDone !== true
      && (displayNameTrim === '' || displayNameTrim === 'Anonymous');
    setShowUsernameOnboarding(needsUsernameOnboarding);
    setUsernameOnboardingGateReady(true);

    setPeers(currentPeers || []);
    setLoadError('');
  } catch (e) {
    if (!isCancelled()) {
      setLoadError(e?.message || 'Could not load your local data.');
    }
  }
}
