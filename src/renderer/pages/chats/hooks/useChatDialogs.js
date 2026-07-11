import { useCallback, useEffect, useMemo, useState } from 'react';
import { isAiChatPeerId } from '../../../aiChatConstants';
import groupChat from '../../../../shared/group-chat.js';

const { isGroupChatId } = groupChat;

/**
 * Dialog-Zustände der Chats-Seite (Connect, Gruppe, Profile, Spitzname,
 * Löschen-/Verlauf-leeren-Bestätigung) inkl. Openern, Confirm-Handlern und
 * den Aufräum-Effekten. Logik 1:1 aus Chats.jsx — nur gebündelt.
 */
export function useChatDialogs({
  selectedPeer,
  selectedPeerId,
  setSelectedPeerId,
  chatList,
  closeListContextMenu,
  deleteChat,
  deleteGroupChat,
  clearAiChatContext,
  setAiAgents,
  setContactNickname,
  setWarning,
  setPendingFile,
  toast,
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [showPeerProfile, setShowPeerProfile] = useState(false);

  const [showNickname, setShowNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTargetPeerId, setDeleteTargetPeerId] = useState(null);
  const [deletingChat, setDeletingChat] = useState(false);
  const [showClearContextConfirm, setShowClearContextConfirm] = useState(false);
  const [clearContextTargetPeerId, setClearContextTargetPeerId] = useState(null);
  const [clearingContext, setClearingContext] = useState(false);

  const peerPendingDelete = useMemo(
    () => (deleteTargetPeerId ? chatList.find((c) => c.id === deleteTargetPeerId) || null : null),
    [chatList, deleteTargetPeerId]
  );

  const peerPendingClear = useMemo(
    () => (clearContextTargetPeerId ? chatList.find((c) => c.id === clearContextTargetPeerId) || null : null),
    [chatList, clearContextTargetPeerId]
  );

  useEffect(() => {
    setShowPeerProfile(false);
    setShowGroupInfo(false);
  }, [selectedPeerId]);

  useEffect(() => {
    if (showDeleteConfirm && deleteTargetPeerId && !peerPendingDelete) {
      setShowDeleteConfirm(false);
      setDeleteTargetPeerId(null);
    }
  }, [showDeleteConfirm, deleteTargetPeerId, peerPendingDelete]);

  useEffect(() => {
    if (showClearContextConfirm && clearContextTargetPeerId && !peerPendingClear) {
      setShowClearContextConfirm(false);
      setClearContextTargetPeerId(null);
    }
  }, [showClearContextConfirm, clearContextTargetPeerId, peerPendingClear]);

  const closePeerProfile = useCallback(() => setShowPeerProfile(false), []);

  const openNicknameDialog = () => {
    if (!selectedPeer) return;
    setNicknameInput(selectedPeer.contact?.nickname || '');
    setShowNickname(true);
  };

  const saveNickname = () => {
    if (!selectedPeer) return;
    setContactNickname(selectedPeer.id, nicknameInput);
    setShowNickname(false);
  };

  const openNicknameForChat = (chat) => {
    setSelectedPeerId(chat.id);
    setNicknameInput(chat.contact?.nickname || '');
    setShowNickname(true);
    closeListContextMenu();
  };

  const openAiProfileEditor = (chat) => {
    if (chat?.id) setSelectedPeerId(chat.id);
    setShowPeerProfile(true);
    closeListContextMenu();
  };

  const openDeleteForPeer = (peerId) => {
    setDeleteTargetPeerId(peerId);
    setShowDeleteConfirm(true);
    closeListContextMenu();
  };

  const closeDeleteConfirm = () => {
    setShowDeleteConfirm(false);
    setDeleteTargetPeerId(null);
  };

  const confirmDeleteChat = async () => {
    if (!deleteTargetPeerId) return;
    setDeletingChat(true);
    try {
      if (isGroupChatId(deleteTargetPeerId)) {
        await deleteGroupChat(deleteTargetPeerId);
      } else {
        await deleteChat(deleteTargetPeerId);
        if (isAiChatPeerId(deleteTargetPeerId)) {
          setAiAgents((prev) => prev.filter((agent) => agent.id !== deleteTargetPeerId));
        }
      }
      if (selectedPeerId === deleteTargetPeerId) {
        setSelectedPeerId(null);
      }
      setShowGroupInfo(false);
      setWarning('');
      setPendingFile(null);
      setShowDeleteConfirm(false);
      setDeleteTargetPeerId(null);
    } finally {
      setDeletingChat(false);
    }
  };

  const openClearContextForPeer = (peerId) => {
    if (!isAiChatPeerId(peerId)) return;
    setClearContextTargetPeerId(peerId);
    setShowClearContextConfirm(true);
    closeListContextMenu();
  };

  const closeClearContextConfirm = () => {
    setShowClearContextConfirm(false);
    setClearContextTargetPeerId(null);
  };

  const confirmClearContext = async () => {
    if (!clearContextTargetPeerId) return;
    setClearingContext(true);
    try {
      await clearAiChatContext(clearContextTargetPeerId);
      toast({
        variant: 'success',
        title: 'Verlauf geleert',
        message: 'Chatverlauf und Agent-Kontext wurden zurückgesetzt.',
      });
      setWarning('');
      setShowClearContextConfirm(false);
      setClearContextTargetPeerId(null);
    } catch (err) {
      const msg = err?.message || 'Verlauf konnte nicht geleert werden.';
      setWarning(msg);
      toast({ variant: 'error', title: 'Fehler', message: msg });
    } finally {
      setClearingContext(false);
    }
  };

  return {
    showConnect,
    setShowConnect,
    showCreateGroup,
    setShowCreateGroup,
    showGroupInfo,
    setShowGroupInfo,
    showPeerProfile,
    setShowPeerProfile,
    closePeerProfile,
    showNickname,
    setShowNickname,
    nicknameInput,
    setNicknameInput,
    openNicknameDialog,
    saveNickname,
    openNicknameForChat,
    openAiProfileEditor,
    showDeleteConfirm,
    deleteTargetPeerId,
    deletingChat,
    peerPendingDelete,
    openDeleteForPeer,
    closeDeleteConfirm,
    confirmDeleteChat,
    showClearContextConfirm,
    clearingContext,
    peerPendingClear,
    openClearContextForPeer,
    closeClearContextConfirm,
    confirmClearContext,
  };
}
