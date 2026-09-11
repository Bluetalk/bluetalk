import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { MessageCircle, UserPlus } from 'lucide-react';
import { useApp, useAiProgress } from '../App';
import { useToast } from '../components/ToastProvider';
import { CreateGroupModal, GroupInfoModal } from '../components/GroupChatDialogs';
import { isAiChatPeerId, botHasRemoteApi, modelSupportsVision, resolveBotModel } from '../aiChatConstants';
import { isTypingActive } from '../../shared/chat-typing.js';
import {
  // Präsentations-Bausteine
  contactOutgoingBlocked,
  SubagentChatView,
  MediaLightbox,
  // Seiten-Bausteine
  ChatListPanel,
  ChatHeader,
  MessageList,
  Composer,
  AiSetupView,
  // Dialoge & Menüs
  ConnectDialog,
  AiProfileDialog,
  BotWorklogPanel,
  PeerProfileDialog,
  NicknameDialog,
  ClearContextConfirmDialog,
  DeleteChatConfirmDialog,
  ForwardDialog,
  ChatListContextMenu,
  MessageContextMenu,
  // Hooks
  useOllamaAi,
  useAiAgents,
  useChatListWidth,
  useChatListData,
  useChatSelection,
  useSubagents,
  useChatScroll,
  useMessageSelection,
  useAttachments,
  useForwarding,
  useChatMessagesLoader,
  useOfflineReconnect,
  useChatDialogs,
  useChatActions,
} from './chats/index.js';

export default function ChatsPage() {
  const { toast } = useToast();
  const {
    peers,
    contacts,
    groups,
    ownPeerId,
    chatMeta,
    loadedChats,
    messages,
    isAiChatPending,
    settings,
    peerReadReceipts,
    chatLastViewedPeerTs,
    markPeerChatViewed,
    sendMessage,
    cancelAiChat,
    clearAiChatContext,
    sendReadReceipt,
    toggleMessageReaction,
    loadChatMessages,
    connectToAddress,
    createGroupChat,
    updateGroupChat,
    leaveGroupChat,
    deleteGroupChat,
    setContactNickname,
    setChatPinned,
    resetE2eeSession,
    setContactBlocked,
    setContactNotificationMute,
    deleteChat,
    deleteMessage,
    updateSettings,
    peerGamePresence,
    peerUserPresence,
    peerTyping,
    sendTyping,
    agentAskUser,
    setAgentAskUser,
  } = useApp();
  const aiChatProgress = useAiProgress();

  const debugMode = settings.debugMode ?? false;

  const location = useLocation();
  const navigate = useNavigate();

  const [warning, setWarning] = useState('');
  const [listContextMenu, setListContextMenu] = useState(null);
  const [mediaLightbox, setMediaLightbox] = useState(null);
  const [messageContextMenu, setMessageContextMenu] = useState(null);
  const [replyToMessage, setReplyToMessage] = useState(null);

  const textareaRef = useRef(null);

  const { ollamaState } = useOllamaAi(toast);
  const { aiAgents, setAiAgents, aiAgentsLoaded, updateAiAgent } = useAiAgents(chatMeta);
  const [openaiGlobal, setOpenaiGlobal] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await window.bluetalk?.store?.get('aiChat.openai', {});
      if (!cancelled) setOpenaiGlobal(stored && typeof stored === 'object' ? stored : {});
    })();
    return () => { cancelled = true; };
  }, []);

  const {
    chatListCollapsed,
    chatListWidthPx,
    onChatListResizeBegin,
    onChatListResizeDelta,
    commitChatListWidth,
    resetChatListWidth,
    toggleChatListCollapse,
  } = useChatListWidth(settings, updateSettings);

  const { contactById, resolveContact, chatList, mainChatList } = useChatListData({
    contacts,
    peers,
    chatMeta,
    groups,
    ownPeerId,
    aiAgents,
    peerGamePresence,
    peerUserPresence,
    openaiGlobal,
    ollamaState,
  });

  const { selectedPeerId, setSelectedPeerId } = useChatSelection({
    location,
    navigate,
    mainChatList,
    chatList,
    aiAgentsLoaded,
  });

  const {
    subagentsByPeer,
    expandedAgentSubs,
    selectedSubagent,
    setSelectedSubagent,
    selectedSubagentSegment,
    openSubagentChat,
    openSubagentForSelectedChat,
    closeSubagentChat,
    toggleAgentSubsExpanded,
  } = useSubagents({ messages, aiChatProgress, selectedPeerId, setSelectedPeerId });

  const selectedPeer = useMemo(
    () => chatList.find((c) => c.id === selectedPeerId) || null,
    [chatList, selectedPeerId]
  );

  const isAiChatSelected = Boolean(selectedPeer?.isAiChat || isAiChatPeerId(selectedPeer?.id));
  const isGroupSelected = Boolean(selectedPeer?.isGroup && selectedPeer.group);
  const selectedBot = useMemo(
    () => (isAiChatSelected ? aiAgents.find((agent) => agent.id === selectedPeer?.id) || null : null),
    [aiAgents, isAiChatSelected, selectedPeer?.id]
  );
  const botModel = resolveBotModel(selectedBot, {
    modelTier: ollamaState?.selectedModelTier,
    cloudModelId: ollamaState?.selectedCloudModelId,
  });
  const aiChatSupportsVision = botModel.modelSource === 'openai'
    || modelSupportsVision(botModel.modelTier, botModel.cloudModelId);
  const showAiComposerAttach = !isAiChatSelected || aiChatSupportsVision;
  const aiChatNeedsSetup = isAiChatSelected && !botHasRemoteApi(selectedBot, openaiGlobal, ollamaState);
  const aiChatPending = isAiChatPending(selectedPeer?.id);
  const peerTypingActive = Boolean(
    selectedPeer
    && !isAiChatSelected
    && !isGroupSelected
    && isTypingActive(peerTyping?.[selectedPeer.id])
  );
  const liveAiProgress = aiChatProgress?.peerId === selectedPeer?.id ? aiChatProgress : null;

  const selectedContact = useMemo(
    () => (selectedPeer ? resolveContact(selectedPeer.id) : null),
    [selectedPeer, resolveContact]
  );

  const attachments = useAttachments({ toast, setWarning });
  const { setPendingFile } = attachments;

  const { showOfflineComposerReconnect, offlineReconnectAddress } = useOfflineReconnect({
    selectedPeer,
    isAiChatSelected,
    isGroupSelected,
    connectToAddress,
  });

  const msgs = selectedPeer ? messages[selectedPeer.id] || [] : [];
  const readUpToId = selectedPeer ? peerReadReceipts[selectedPeer.id] : null;
  const hasMoreMessages = selectedPeer ? selectedPeer.messageCount > msgs.length : false;
  const newestTimestamp = msgs[msgs.length - 1]?.timestamp || 0;

  const { chatMessagesRef, endRef, updateChatPinnedState } = useChatScroll({
    selectedPeerId,
    newestTimestamp,
    aiChatProgress,
    typingActive: aiChatPending || peerTypingActive,
  });

  const { loadingMessages, loadingMore, loadOlderMessages } = useChatMessagesLoader({
    selectedPeerId,
    selectedPeer,
    msgs,
    messages,
    chatMeta,
    loadedChats,
    loadChatMessages,
    markPeerChatViewed,
    sendReadReceipt,
    sendReadReceiptsEnabled: settings.sendReadReceipts,
    toast,
  });

  const closeMessageContextMenu = useCallback(() => setMessageContextMenu(null), []);
  const closeListContextMenu = useCallback(() => setListContextMenu(null), []);

  const {
    selectionMode,
    selectedMessageIds,
    selectedCount,
    exitSelectionMode,
    startSelectionMode,
    toggleSelectedMessage,
  } = useMessageSelection({ selectedPeerId, closeMessageContextMenu });

  const {
    forwardDialog,
    setForwardDialog,
    forwardingMessages,
    forwardableChats,
    openForwardDialog,
    confirmForwardToPeer,
  } = useForwarding({
    mainChatList,
    selectedPeer,
    sendMessage,
    toast,
    closeMessageContextMenu,
    exitSelectionMode,
  });

  const dialogs = useChatDialogs({
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
  });

  const actions = useChatActions({
    toast,
    deleteMessage,
    setContactNotificationMute,
    connectToAddress,
    setSelectedPeerId,
    closeListContextMenu,
    selectedPeer,
    selectedMessageIds,
    msgs,
    exitSelectionMode,
    openForwardDialog,
  });

  // Rohe Klick-Koordinaten reichen: die Menüs clampen sich selbst anhand
  // ihrer echten Größe am Viewport (useContextMenuPosition).
  const openMessageContextMenu = useCallback((e, message) => {
    if (selectionMode) return;
    if (!message?.messageId) return;
    e.preventDefault();
    e.stopPropagation();
    setMessageContextMenu({ message, x: e.clientX, y: e.clientY });
  }, [selectionMode]);

  const openChatListContextMenu = useCallback((e, chat) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedPeerId(chat.id);
    setListContextMenu({ chat, x: e.clientX, y: e.clientY });
  }, [setSelectedPeerId]);

  const handleSelectChat = useCallback((id) => {
    setSelectedSubagent(null);
    setSelectedPeerId(id);
  }, [setSelectedSubagent, setSelectedPeerId]);

  const clearReply = useCallback(() => setReplyToMessage(null), []);

  const handleReplyToMessage = useCallback((message) => {
    if (!message) return;
    setReplyToMessage(message);
    closeMessageContextMenu();
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, [closeMessageContextMenu]);

  const togglePinnedState = () => {
    if (!selectedPeer) return;
    setChatPinned(selectedPeer.id, !selectedPeer.pinned);
  };

  // Beim Chat-Wechsel Kontextmenü und Reply-Ziel verwerfen. (Auswahlmodus,
  // Sub-Agent-Auswahl, Profil-/Gruppen-Dialog sowie die lokalen Menüs in
  // Header/Composer setzen sich in ihren Hooks/Komponenten mit demselben
  // Trigger zurück.)
  useEffect(() => {
    setMessageContextMenu(null);
    setReplyToMessage(null);
  }, [selectedPeerId]);

  useEffect(() => {
    if (!mediaLightbox) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setMediaLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mediaLightbox]);

  const composerDisabled = Boolean(
    !selectedPeer
      || (!isGroupSelected && contactOutgoingBlocked(selectedPeer?.contact))
      || (isGroupSelected && !selectedPeer.canSend)
      || showOfflineComposerReconnect
  );

  return (
    <div className="page">
      <MediaLightbox
        open={Boolean(mediaLightbox)}
        src={mediaLightbox?.src || ''}
        alt={mediaLightbox?.alt || ''}
        canSave={Boolean(mediaLightbox?.base64)}
        onClose={() => setMediaLightbox(null)}
        onSave={() => {
          if (!mediaLightbox?.base64) return;
          actions.saveAttachmentToDisk(mediaLightbox.defaultFilename || 'Bild', mediaLightbox.base64);
        }}
      />
      <CreateGroupModal
        open={dialogs.showCreateGroup}
        contacts={contacts}
        peers={peers}
        onCreate={createGroupChat}
        onClose={(groupId) => {
          dialogs.setShowCreateGroup(false);
          if (groupId) setSelectedPeerId(groupId);
        }}
      />
      <GroupInfoModal
        open={dialogs.showGroupInfo && isGroupSelected}
        group={selectedPeer?.group || null}
        ownPeerId={ownPeerId}
        contacts={contacts}
        peers={peers}
        onUpdate={updateGroupChat}
        onLeave={leaveGroupChat}
        onDelete={deleteGroupChat}
        onClose={() => dialogs.setShowGroupInfo(false)}
      />
      <div className="split-layout">
        <ChatListPanel
          collapsed={chatListCollapsed}
          widthPx={chatListWidthPx}
          onToggleCollapse={toggleChatListCollapse}
          onResizeBegin={onChatListResizeBegin}
          onResizeDelta={onChatListResizeDelta}
          onResizeCommit={commitChatListWidth}
          onResizeReset={resetChatListWidth}
          onShowCreateGroup={() => dialogs.setShowCreateGroup(true)}
          chats={mainChatList}
          listState={{
            chatLastViewedPeerTs,
            messages,
            subagentsByPeer,
            expandedAgentSubs,
            selectedPeerId: selectedPeer?.id,
            selectedSubagent,
            debugMode,
            peerTyping,
          }}
          actions={{
            resolveContact,
            isAiChatPending,
            onSelectChat: handleSelectChat,
            onChatContextMenu: openChatListContextMenu,
            onToggleAgentSubs: toggleAgentSubsExpanded,
            onOpenSubagent: openSubagentChat,
          }}
        />

        <div className="split-detail split-detail--resizable">
          {!selectedPeer ? (
            <div className="chat-empty">
              <div className="empty-state">
                <MessageCircle size={36} strokeWidth={1.5} aria-hidden />
                <p className="empty-state-title">Chat auswählen</p>
                <p>Wähle links eine Unterhaltung oder verbinde dich mit jemandem.</p>
                <div className="empty-state-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => navigate('/new')}>
                    <UserPlus size={14} strokeWidth={1.75} aria-hidden />
                    Neue Kontakte
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => dialogs.setShowConnect(true)}>
                    Peer verbinden
                  </button>
                </div>
              </div>
            </div>
          ) : selectedSubagentSegment ? (
            <SubagentChatView
              segment={selectedSubagentSegment}
              parentPeer={selectedPeer}
              live={aiChatProgress?.peerId === selectedPeer?.id}
              onBack={closeSubagentChat}
            />
          ) : aiChatNeedsSetup ? (
            <AiSetupView
              selectedPeer={selectedPeer}
              onShowProfile={dialogs.togglePeerProfile}
              onOpenSettings={() => navigate('/settings/ai')}
            />
          ) : (
            <>
              <ChatHeader
                selectedPeer={selectedPeer}
                selectedContact={selectedContact}
                isAiChatSelected={isAiChatSelected}
                isGroupSelected={isGroupSelected}
                showGroupInfo={dialogs.showGroupInfo}
                showPeerProfile={dialogs.showPeerProfile}
                ollamaState={ollamaState}
                selectedBot={selectedBot}
                aiChatPending={aiChatPending}
                clearingContext={dialogs.clearingContext}
                debugMode={debugMode}
                selection={{
                  selectionMode,
                  selectedCount,
                  onForwardSelected: actions.forwardSelectedMessages,
                  onDeleteSelected: actions.deleteSelectedMessages,
                  onExitSelection: exitSelectionMode,
                  onStartSelection: startSelectionMode,
                }}
                actions={{
                  onShowGroupInfo: () => dialogs.setShowGroupInfo(true),
                  onShowPeerProfile: dialogs.togglePeerProfile,
                  onOpenNickname: dialogs.openNicknameDialog,
                  onTogglePinned: togglePinnedState,
                  onOpenDelete: dialogs.openDeleteForPeer,
                  onOpenClearContext: dialogs.openClearContextForPeer,
                  onCopyPeerId: actions.copyPeerIdFromMenu,
                  applyNotificationMute: actions.applyNotificationMute,
                  resetE2eeSession,
                  setContactBlocked,
                  toast,
                  onSelectTier: (tierId) => {
                    if (selectedPeer?.id) void updateAiAgent(selectedPeer.id, { modelTier: tierId });
                  },
                  onSelectCloudModel: (cloudModelId) => {
                    if (selectedPeer?.id) {
                      void updateAiAgent(selectedPeer.id, { modelSource: 'cloud', modelTier: 'cloud', cloudModelId });
                    }
                  },
                  onSelectOpenai: () => {
                    if (selectedPeer?.id) void updateAiAgent(selectedPeer.id, { modelSource: 'openai', modelTier: 'cloud' });
                  },
                  onOpenCloudSettings: () => navigate('/settings/ai'),
                }}
              />

              <MessageList
                chat={{ selectedPeer, selectedContact, isAiChatSelected, isGroupSelected, ownPeerId }}
                data={{ msgs, readUpToId, hasMoreMessages, loadingMessages, loadingMore }}
                ui={{
                  debugMode,
                  settings,
                  contactById,
                  peers,
                  selectionMode,
                  selectedMessageIds,
                  aiChatPending,
                  peerTypingActive,
                  liveAiProgress,
                  workLogEnabled: Boolean(selectedBot?.workLogEnabled),
                }}
                scroll={{ chatMessagesRef, endRef, onScroll: updateChatPinnedState }}
                actions={{
                  onLoadOlder: loadOlderMessages,
                  onToggleSelectMessage: toggleSelectedMessage,
                  onOpenMessageContextMenu: openMessageContextMenu,
                  onExpandImage: setMediaLightbox,
                  onSaveFile: actions.saveFileMessage,
                  onConnectFromSharedContact: actions.connectFromSharedContact,
                  openSubagentForSelectedChat,
                  openSubagentChat,
                  onExportChat: actions.exportPeerChat,
                  onOpenDelete: dialogs.openDeleteForPeer,
                  onOpenWorklog: dialogs.openBotWorklog,
                  onReact: (message, emoji) => {
                    if (!selectedPeer?.id) return;
                    void toggleMessageReaction(selectedPeer.id, message, emoji);
                  },
                }}
              />

              <Composer
                chat={{
                  selectedPeer,
                  isAiChatSelected,
                  isGroupSelected,
                  ownPeerId,
                  aiChatPending,
                  aiChatSupportsVision,
                  showAiComposerAttach,
                  composerDisabled,
                  showOfflineComposerReconnect,
                  offlineReconnectAddress,
                  askUser: isAiChatSelected && agentAskUser?.peerId === selectedPeer?.id
                    ? agentAskUser
                    : null,
                }}
                reply={{ replyToMessage, onClearReply: clearReply }}
                attachments={attachments}
                env={{ settings, contacts, peers, debugMode, warning }}
                actions={{
                  sendMessage,
                  sendTyping,
                  cancelAiChat,
                  connectToAddress,
                  toast,
                  setWarning,
                  onAskReply: (text) => {
                    const rid = agentAskUser?.requestId;
                    if (rid) window.bluetalk?.ollama?.replyAskUser?.(rid, text || '');
                    setAgentAskUser(null);
                  },
                }}
                textareaRef={textareaRef}
              />
            </>
          )}
        </div>

        <AiProfileDialog
          open={Boolean(dialogs.showPeerProfile && selectedPeer && selectedPeer.isAiChat)}
          showPeerProfile={dialogs.showPeerProfile}
          selectedPeerId={selectedPeerId}
          selectedPeer={selectedPeer}
          aiAgents={aiAgents}
          updateAiAgent={updateAiAgent}
          onClose={dialogs.closePeerProfile}
          toast={toast}
          ollamaState={ollamaState}
          debugMode={debugMode}
        />

        <BotWorklogPanel
          open={Boolean(dialogs.showBotWorklog && selectedPeer?.isAiChat && selectedBot?.workLogEnabled)}
          peerId={selectedPeer?.id}
          liveProgress={liveAiProgress}
          onClose={dialogs.closeBotWorklog}
        />

        <PeerProfileDialog
          open={Boolean(dialogs.showPeerProfile && selectedPeer && !selectedPeer.isAiChat && !isGroupSelected)}
          selectedPeer={selectedPeer}
          selectedContact={selectedContact}
          onClose={dialogs.closePeerProfile}
          copyToClipboard={actions.copyToClipboard}
          actions={{
            onOpenNickname: dialogs.openNicknameDialog,
            onTogglePinned: togglePinnedState,
            onOpenDelete: dialogs.openDeleteForPeer,
            onStartSelection: startSelectionMode,
            applyNotificationMute: actions.applyNotificationMute,
            resetE2eeSession,
            setContactBlocked,
            toast,
          }}
        />
      </div>

      <ConnectDialog
        open={dialogs.showConnect}
        onClose={() => dialogs.setShowConnect(false)}
        connectToAddress={connectToAddress}
        onConnected={setSelectedPeerId}
        setWarning={setWarning}
        toast={toast}
      />

      <NicknameDialog
        open={Boolean(dialogs.showNickname && selectedPeer)}
        selectedPeer={selectedPeer}
        value={dialogs.nicknameInput}
        onChange={dialogs.setNicknameInput}
        onSave={dialogs.saveNickname}
        onClose={() => dialogs.setShowNickname(false)}
      />

      <ClearContextConfirmDialog
        open={Boolean(dialogs.showClearContextConfirm && dialogs.peerPendingClear)}
        peer={dialogs.peerPendingClear}
        busy={dialogs.clearingContext}
        onClose={dialogs.closeClearContextConfirm}
        onConfirm={dialogs.confirmClearContext}
      />

      <DeleteChatConfirmDialog
        open={Boolean(dialogs.showDeleteConfirm && dialogs.peerPendingDelete)}
        peer={dialogs.peerPendingDelete}
        targetPeerId={dialogs.deleteTargetPeerId}
        busy={dialogs.deletingChat}
        onClose={dialogs.closeDeleteConfirm}
        onConfirm={dialogs.confirmDeleteChat}
      />

      <ChatListContextMenu
        menu={listContextMenu}
        onClose={closeListContextMenu}
        resolveContact={resolveContact}
        applyNotificationMute={actions.applyNotificationMute}
        actions={{
          onOpenChat: setSelectedPeerId,
          onOpenAiProfile: dialogs.openAiProfileEditor,
          onOpenClearContext: dialogs.openClearContextForPeer,
          onOpenDelete: dialogs.openDeleteForPeer,
          onOpenGroupInfo: (id) => {
            setSelectedPeerId(id);
            dialogs.setShowGroupInfo(true);
          },
          setChatPinned,
          resetE2eeSession,
          setContactBlocked,
          onOpenNickname: dialogs.openNicknameForChat,
          onCopyPeerId: actions.copyPeerIdFromMenu,
          toast,
        }}
      />

      <MessageContextMenu
        menu={messageContextMenu}
        onClose={closeMessageContextMenu}
        selectedPeer={selectedPeer}
        debugMode={debugMode}
        onReply={handleReplyToMessage}
        copyToClipboard={actions.copyToClipboard}
        onForward={openForwardDialog}
        onDeleteMessage={actions.handleDeleteMessage}
        workLogEnabled={Boolean(selectedBot?.workLogEnabled)}
        onOpenWorklog={dialogs.openBotWorklog}
        onReact={(message, emoji) => {
          if (!selectedPeer?.id) return;
          void toggleMessageReaction(selectedPeer.id, message, emoji);
        }}
      />

      <ForwardDialog
        forwardDialog={forwardDialog}
        forwardableChats={forwardableChats}
        busy={forwardingMessages}
        debugMode={debugMode}
        onClose={() => setForwardDialog(null)}
        onForward={confirmForwardToPeer}
      />
    </div>
  );
}
