import { useCallback, useEffect, useState } from 'react';
import { isAiChatPeerId } from '../../../aiChatConstants';
import { MOBILE_MQ, isMobileLayout } from '../../../utils/touch.js';

function chatIdFromSearch(search) {
  return new URLSearchParams(search || '').get('chat') || '';
}

/**
 * Auswahl des aktiven Chats inkl. Navigation-Sync (openPeerId), Auto-Auswahl
 * des ersten Chats (nur Desktop) und Bereinigung verwaister Auswahl.
 *
 * Unter 768 px ist die URL (`?chat=`) Quelle der Wahrheit, damit Browser-
 * und Android-Zurück die Chatliste wiederherstellen.
 */
export function useChatSelection({ location, navigate, mainChatList, chatList, aiAgentsLoaded }) {
  const [selectedPeerId, setSelectedPeerIdState] = useState(null);

  const setSelectedPeerId = useCallback((id) => {
    if (!isMobileLayout()) {
      setSelectedPeerIdState(id || null);
      return;
    }
    const params = new URLSearchParams(location.search);
    const current = params.get('chat');
    if (id) {
      if (current === id) {
        setSelectedPeerIdState(id);
        return;
      }
      params.set('chat', id);
      navigate({ pathname: location.pathname || '/', search: `?${params.toString()}` });
      return;
    }
    if (current) {
      params.delete('chat');
      const next = params.toString();
      navigate(
        { pathname: location.pathname || '/', search: next ? `?${next}` : '' },
        { replace: true }
      );
      return;
    }
    setSelectedPeerIdState(null);
  }, [location.pathname, location.search, navigate]);

  const closeMobileChat = useCallback(() => {
    if (!isMobileLayout()) {
      setSelectedPeerIdState(null);
      return;
    }
    if (chatIdFromSearch(location.search) && window.history.length > 1) {
      navigate(-1);
      return;
    }
    setSelectedPeerId(null);
  }, [location.search, navigate, setSelectedPeerId]);

  const openPeerFromNav = location.state?.openPeerId;
  useEffect(() => {
    if (!openPeerFromNav) return;
    if (isMobileLayout()) {
      const params = new URLSearchParams(location.search);
      params.set('chat', openPeerFromNav);
      navigate(
        { pathname: '/', search: `?${params.toString()}` },
        { replace: true, state: {} }
      );
      return;
    }
    setSelectedPeerIdState(openPeerFromNav);
    navigate('.', { replace: true, state: {} });
  }, [openPeerFromNav, navigate, location.search]);

  // Mobile: URL → Auswahl. Desktop ignoriert ?chat=, damit sich dort nichts ändert.
  useEffect(() => {
    if (!isMobileLayout()) return;
    const fromUrl = chatIdFromSearch(location.search);
    setSelectedPeerIdState(fromUrl || null);
  }, [location.search]);

  useEffect(() => {
    if (openPeerFromNav) return;
    if (selectedPeerId != null) return;
    if (isMobileLayout()) return;
    const first = mainChatList[0];
    if (first) setSelectedPeerIdState(first.id);
  }, [openPeerFromNav, selectedPeerId, mainChatList]);

  useEffect(() => {
    if (selectedPeerId && !chatList.find((chat) => chat.id === selectedPeerId)) {
      // KI-Agenten erst verwerfen, wenn die Agentenliste geladen ist — sonst
      // geht die Auswahl eines frisch erstellten Agenten (openPeerId aus der
      // Navigation) verloren, bevor er in chatList auftauchen kann.
      if (isAiChatPeerId(selectedPeerId) && !aiAgentsLoaded) return;
      setSelectedPeerId(null);
    }
  }, [chatList, selectedPeerId, aiAgentsLoaded, setSelectedPeerId]);

  // Schmal ziehen: aktuelle Auswahl in die History legen, damit Zurück greift.
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const onChange = () => {
      if (!mq.matches) return;
      if (!selectedPeerId) return;
      if (chatIdFromSearch(window.location.hash.split('?')[1] || '') === selectedPeerId) return;
      const params = new URLSearchParams(location.search);
      params.set('chat', selectedPeerId);
      navigate({ pathname: location.pathname || '/', search: `?${params.toString()}` }, { replace: true });
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [selectedPeerId, navigate, location.pathname, location.search]);

  return { selectedPeerId, setSelectedPeerId, closeMobileChat };
}
