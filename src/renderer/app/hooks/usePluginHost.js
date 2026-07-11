// pluginRuntime-Host: stellt dem Plugin-System App-Funktionen bereit,
// 1:1 aus App.jsx ausgelagert.
import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { pluginRuntime } from '../../plugins/pluginRuntime';

export function usePluginHost({
  peers,
  messages,
  ownPeerIdRef,
  contactsRef,
  setOwnPeerId,
  sendMessage,
  deleteMessage,
  deleteChat,
  upsertContact,
  removeContact,
  setContactBlocked,
  setContactNickname,
  setChatPinned,
}) {
  const peersRef = useRef(peers);
  const messagesRef = useRef(messages);
  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    if (!window.bluetalk?.plugins) return undefined;
    let cancelled = false;
    const host = {
      getOwnPeerId: () => ownPeerIdRef.current,
      getPeers: () => peersRef.current,
      getContacts: () => contactsRef.current,
      getMessages: (peerId) => (peerId ? messagesRef.current[peerId] || [] : messagesRef.current),
      sendMessage,
      deleteMessage,
      deleteChat,
      upsertContact,
      removeContact,
      setContactBlocked,
      setContactNickname,
      setChatPinned,
      toast: null,
    };
    pluginRuntime.setHost(host);
    pluginRuntime.injectReact(React, ReactDOM);
    void (async () => {
      if (!ownPeerIdRef.current) {
        try {
          const info = await window.bluetalk.peer.getInfo();
          ownPeerIdRef.current = info?.id || '';
          if (!cancelled) setOwnPeerId(info?.id || '');
        } catch {
          /* Realtime liest die ID später erneut aus dem aktuellen Ref. */
        }
      }
      if (!cancelled) await pluginRuntime.boot(host);
    })();
    return () => { cancelled = true; };
  }, [sendMessage, deleteMessage, deleteChat, upsertContact, removeContact, setContactBlocked, setContactNickname, setChatPinned]);
}
