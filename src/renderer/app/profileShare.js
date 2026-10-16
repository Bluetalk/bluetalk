import { OWN_PEER_FEATURES } from '../../shared/chat-features.js';

/** Profil-Frame (Name + Bio + Bild), das nach dem Handshake an Peers geht. */
export function buildProfilePayload(settings) {
  return {
    kind: 'profile',
    displayName: settings?.displayName || '',
    bio: settings?.bio || '',
    profilePicture: settings?.profilePicture || '',
    sender: settings?.displayName || '',
    features: [...OWN_PEER_FEATURES],
  };
}
