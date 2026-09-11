import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, Link2, RefreshCw, Search, Trash2, UserPlus, X } from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';
import { ConnectDialog } from './chats/dialogs/ConnectDialog.jsx';
import { CHAT_ICON_STROKE, PeerAvatar } from './chats/messageHelpers.jsx';

function requestPreviewLine(message) {
  if (!message) return 'Neue Nachricht';
  if (message.kind === 'file' || message.kind === 'file-link') return `Datei: ${message.fileName || message.content || 'Anhang'}`;
  return message.content || 'Nachricht';
}

function shortPeerId(id) {
  const value = String(id || '');
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}…${value.slice(-6)}`;
}

export default function NewConnectionsPage() {
  const { toast } = useToast();
  const {
    peers,
    contacts,
    chatMeta,
    refreshDiscovery,
    upsertContact,
    acceptMessageRequest,
    deleteChat,
    connectToAddress,
  } = useApp();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [, setWarning] = useState('');

  const messageRequests = useMemo(() => {
    return contacts
      .filter((c) => c.pendingMessageRequest === true)
      .map((c) => {
        const peer = peers.find((p) => p.id === c.id);
        const baseName = c.name || peer?.name || c.id;
        return {
          id: c.id,
          displayName: c.nickname || baseName,
          profilePicture: c.profilePicture || peer?.profilePicture || '',
          offline: !peer,
          lastMessage: chatMeta[c.id]?.lastMessage || null,
        };
      })
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
  }, [contacts, peers, chatMeta]);

  const acceptRequest = (peerId) => {
    acceptMessageRequest(peerId);
    navigate('/', { state: { openPeerId: peerId } });
  };

  const dismissRequest = async (peerId) => {
    const ok = window.confirm('Anfrage ablehnen und alle Nachrichten dieses Kontakts löschen?');
    if (!ok) return;
    await deleteChat(peerId);
  };

  const newPeerRows = useMemo(() => {
    const rows = [];
    for (const peer of peers) {
      if (!peer?.id || peer.id === 'self') continue;

      const count = chatMeta[peer.id]?.count || 0;
      const contact = contacts.find((c) => c.id === peer.id);
      if (count > 0) continue;
      if (contact?.pendingMessageRequest) continue;
      if (contact?.hasOutgoing) continue;

      const baseName = contact?.name || peer.name || peer.id;
      rows.push({
        id: peer.id,
        peer,
        contact,
        displayName: contact?.nickname || baseName,
        baseName,
        profilePicture: contact?.profilePicture || peer?.profilePicture || '',
      });
    }

    return rows.sort((a, b) =>
      (a.displayName || '').localeCompare(b.displayName || '', undefined, { sensitivity: 'base' })
    );
  }, [peers, contacts, chatMeta]);

  const filtered = useMemo(
    () =>
      newPeerRows.filter((row) =>
        `${row.displayName} ${row.baseName} ${row.id}`.toLowerCase().includes(search.toLowerCase())
      ),
    [newPeerRows, search]
  );

  const startChat = (peerId) => {
    upsertContact({ id: peerId, hasOutgoing: true });
    navigate('/', { state: { openPeerId: peerId } });
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshDiscovery();
    } catch (err) {
      const msg = err?.message || 'Aktualisierung fehlgeschlagen';
      toast({ variant: 'error', title: 'Aktualisierung fehlgeschlagen', message: msg });
    } finally {
      setRefreshing(false);
    }
  };

  const emptyNearby = filtered.length === 0;
  const emptyAll = emptyNearby && messageRequests.length === 0;

  return (
    <div className="page page-inset">
      <div className="page-shell">
        <header className="page-shell-header">
          <div className="page-shell-copy">
            <h1>Neu</h1>
            <p>Geräte im selben Netz und Nachrichten von Unbekannten.</p>
          </div>
          <div className="page-shell-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setShowConnect(true)}
            >
              <Link2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              Peer verbinden
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-icon btn-sm"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              title="Erneut im lokalen Netz suchen"
              aria-label="Aktualisieren"
            >
              <RefreshCw
                size={15}
                strokeWidth={CHAT_ICON_STROKE}
                className={refreshing ? 'page-shell-spin is-spinning' : 'page-shell-spin'}
                aria-hidden
              />
            </button>
          </div>
        </header>

        <div className="page-shell-search">
          <div className="search-bar">
            <Search size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
            <input
              className="input"
              placeholder="Namen oder Peer-ID suchen…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search ? (
              <button
                type="button"
                className="search-bar-clear"
                aria-label="Suche zurücksetzen"
                onClick={() => setSearch('')}
              >
                <X size={13} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div className="page-shell-body">
          {messageRequests.length > 0 ? (
            <section className="new-section" aria-label="Nachrichtenanfragen">
              <div className="new-section-title">
                <Bell size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Anfragen
                <span className="new-section-count">{messageRequests.length}</span>
              </div>
              <div className="new-request-list">
                {messageRequests.map((r) => (
                  <div key={r.id} className="new-request-row">
                    <PeerAvatar pictureUrl={r.profilePicture} name={r.displayName} size={40} />
                    <div className="new-request-copy">
                      <div className="new-person-name">
                        {r.displayName}
                        <span
                          className={r.offline ? 'offline-dot' : 'online-dot'}
                          title={r.offline ? 'Offline' : 'Online'}
                        />
                      </div>
                      <div className="new-person-meta">{requestPreviewLine(r.lastMessage)}</div>
                    </div>
                    <div className="new-request-actions">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => acceptRequest(r.id)}>
                        <Check size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                        Annehmen
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon"
                        title="Ablehnen und Nachrichten löschen"
                        aria-label="Ablehnen"
                        onClick={() => void dismissRequest(r.id)}
                      >
                        <Trash2 size={15} strokeWidth={CHAT_ICON_STROKE} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {emptyAll ? (
            <div className="page-empty">
              <UserPlus size={28} strokeWidth={1.5} aria-hidden />
              <p className="empty-state-title">{search ? 'Keine Treffer' : 'Keine neuen Kontakte'}</p>
              <p>
                {search
                  ? `Niemand passt zu „${search.trim()}“.`
                  : 'Andere Geräte mit BlueTalk erscheinen hier automatisch. Du kannst auch per Adresse verbinden.'}
              </p>
              {!search ? (
                <div className="empty-state-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowConnect(true)}>
                    <Link2 size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    Peer verbinden
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleRefresh()}
                    disabled={refreshing}
                  >
                    <RefreshCw size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                    Aktualisieren
                  </button>
                </div>
              ) : null}
            </div>
          ) : emptyNearby ? (
            <div className="page-empty page-empty--inline">
              <p className="empty-state-title">{search ? 'Keine Treffer' : 'Niemand Neues im Netz'}</p>
              <p>
                {search
                  ? `Niemand passt zu „${search.trim()}“.`
                  : 'Stelle sicher, dass andere Geräte BlueTalk im selben Netz nutzen.'}
              </p>
            </div>
          ) : (
            <section className="new-section" aria-label="Geräte im Netzwerk">
              <div className="new-section-title">
                <UserPlus size={14} strokeWidth={CHAT_ICON_STROKE} aria-hidden />
                Im Netzwerk
                <span className="new-section-count">{filtered.length}</span>
              </div>
              <div className="new-people-grid">
                {filtered.map((row) => {
                  const blocked = Boolean(row.contact?.blocked || row.contact?.blockedByPeer);
                  return (
                    <article
                      key={row.id}
                      className={`new-person-card${row.contact?.blocked ? ' is-blocked' : ''}${row.contact?.blockedByPeer ? ' is-blocked-by-peer' : ''}`}
                    >
                      <PeerAvatar pictureUrl={row.profilePicture} name={row.displayName} size={52} />
                      <div className="new-person-name">{row.displayName}</div>
                      <div className="new-person-meta">
                        Online
                        {row.id !== row.displayName ? ` · ${shortPeerId(row.id)}` : ''}
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => startChat(row.id)}
                        disabled={blocked}
                        title={
                          row.contact?.blocked
                            ? 'Kontakt ist blockiert'
                            : row.contact?.blockedByPeer
                              ? 'Du wurdest blockiert'
                              : undefined
                        }
                      >
                        {blocked ? 'Blockiert' : 'Chat starten'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      <ConnectDialog
        open={showConnect}
        onClose={() => setShowConnect(false)}
        connectToAddress={connectToAddress}
        onConnected={(peerId) => {
          upsertContact({ id: peerId, hasOutgoing: true });
          navigate('/', { state: { openPeerId: peerId } });
        }}
        setWarning={setWarning}
        toast={toast}
      />
    </div>
  );
}
