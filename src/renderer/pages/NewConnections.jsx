import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, RefreshCw, Search, Trash2, UserPlus } from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';

function requestPreviewLine(message) {
  if (!message) return 'Neue Nachricht';
  if (message.kind === 'file') return `Datei: ${message.fileName || message.content || 'Anhang'}`;
  return message.content || 'Nachricht';
}

export default function NewConnectionsPage() {
  const { toast } = useToast();
  const { peers, contacts, chatMeta, refreshDiscovery, upsertContact, acceptMessageRequest, deleteChat } = useApp();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Offene Nachrichtenanfragen (frühere Glocke in der Sidebar).
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
      const msg = err?.message || 'Refresh failed';
      toast({ variant: 'error', title: 'Refresh failed', message: msg });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title-row">
          <span className="page-title-icon">
            <UserPlus size={18} strokeWidth={1.75} />
          </span>
          New connections
        </h1>
        <p>
          Peers on your network connect automatically. Use Refresh to scan again. Open a conversation here first;
          incoming messages from people you have not started with appear under message requests.
        </p>
      </div>
      <div className="page-body">
        {messageRequests.length > 0 ? (
          <section className="mb-4" aria-label="Nachrichtenanfragen">
            <div className="section-title">
              <h3>
                <span className="section-title-icon" aria-hidden>
                  <Bell size={15} strokeWidth={1.75} />
                </span>
                Nachrichtenanfragen
                <span className="badge badge-muted">{messageRequests.length}</span>
              </h3>
            </div>
            <div className="flex flex-col gap-2">
              {messageRequests.map((r) => (
                <div key={r.id} className="card card-row">
                  <div className="flex items-center gap-3 min-w-0">
                    {r.profilePicture ? (
                      <img src={r.profilePicture} alt="" className="list-item-avatar" style={{ objectFit: 'cover' }} />
                    ) : (
                      <div className="list-item-avatar">{(r.displayName || '?')[0].toUpperCase()}</div>
                    )}
                    <div className="min-w-0">
                      <div className="font-medium truncate flex items-center gap-2">
                        {r.displayName}
                        <span className={r.offline ? 'offline-dot' : 'online-dot'} title={r.offline ? 'Offline' : 'Online'} />
                      </div>
                      <div className="text-xs text-muted truncate">{requestPreviewLine(r.lastMessage)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => acceptRequest(r.id)}>
                      <Check size={14} />
                      Annehmen
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      title="Ablehnen und Nachrichten löschen"
                      onClick={() => void dismissRequest(r.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
          <div className="search-bar flex-1" style={{ minWidth: 200, maxWidth: 360 }}>
            <Search size={14} />
            <input
              className="input"
              placeholder="Search..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Send a discovery broadcast on the LAN"
          >
            <RefreshCw size={14} style={refreshing ? { opacity: 0.7 } : undefined} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="card">
            <p className="text-muted text-sm">
              No new connections yet. Ensure other devices are running BlueTalk on the same network, then tap Refresh.
              Nachrichtenanfragen neuer Absender erscheinen oben auf dieser Seite.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((row) => (
              <div
                key={row.id}
                className={`card card-row${row.contact?.blocked ? ' card-row--blocked' : ''}${row.contact?.blockedByPeer ? ' card-row--blocked-by-peer' : ''}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="list-item-avatar">{(row.displayName || '?')[0].toUpperCase()}</div>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{row.displayName}</div>
                    <div className="text-xs text-muted truncate">
                      Online
                      {row.id !== row.displayName ? ` · ${row.id}` : ''}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => startChat(row.id)}
                  disabled={Boolean(row.contact?.blocked || row.contact?.blockedByPeer)}
                  title={
                    row.contact?.blocked
                      ? 'Kontakt ist blockiert'
                      : row.contact?.blockedByPeer
                        ? 'Du wurdest blockiert'
                        : undefined
                  }
                >
                  {row.contact?.blocked ? 'Blockiert' : row.contact?.blockedByPeer ? 'Blockiert' : 'Start chat'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
