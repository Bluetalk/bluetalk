import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, Check, Trash2, X } from 'lucide-react';
import { useApp } from '../App';

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function previewLine(message) {
  if (!message) return 'New message';
  if (message.kind === 'file') return `File: ${message.fileName || message.content || 'Attachment'}`;
  return message.content || 'Message';
}

export default function NotificationCenter() {
  const { contacts, peers, chatMeta, acceptMessageRequest, deleteChat } = useApp();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const requests = useMemo(() => {
    return contacts
      .filter((c) => c.pendingMessageRequest === true)
      .map((c) => {
        const peer = peers.find((p) => p.id === c.id);
        const meta = chatMeta[c.id];
        const baseName = c.name || peer?.name || c.id;
        return {
          id: c.id,
          displayName: c.nickname || baseName,
          baseName,
          profilePicture: c.profilePicture || peer?.profilePicture || '',
          offline: !peer,
          lastMessage: meta?.lastMessage || null,
        };
      })
      .sort((a, b) => (b.lastMessage?.timestamp || 0) - (a.lastMessage?.timestamp || 0));
  }, [contacts, peers, chatMeta]);

  const count = requests.length;

  const handleAccept = (peerId) => {
    acceptMessageRequest(peerId);
    setOpen(false);
    navigate('/', { state: { openPeerId: peerId } });
  };

  const handleDismiss = async (peerId) => {
    const ok = window.confirm('Delete this message request and all messages from this contact?');
    if (!ok) return;
    await deleteChat(peerId);
  };

  return (
    <div className="notif-center-wrap">
      <button
        type="button"
        className={`notif-center-fab ${count > 0 ? 'notif-center-fab-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={count > 0 ? `${count} message request${count !== 1 ? 's' : ''}` : 'Notifications'}
        aria-label={
          count > 0
            ? `Notifications, ${count} pending message request${count !== 1 ? 's' : ''}`
            : 'Notifications'
        }
        aria-expanded={open}
      >
        <Bell size={18} strokeWidth={1.75} />
        {count > 0 && <span className="notif-center-request-dot" aria-hidden />}
      </button>

      {open && (
        <>
          <button type="button" className="notif-center-backdrop" aria-label="Close notifications" onClick={() => setOpen(false)} />
          <div className="notif-center-panel animate-scale">
            <div className="notif-center-header">
              <span className="notif-center-title">Message requests</span>
              <button type="button" className="btn btn-ghost btn-icon" onClick={() => setOpen(false)} title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="notif-center-body">
              {requests.length === 0 && (
                <div className="notif-center-empty text-muted text-sm">No pending requests</div>
              )}
              {requests.map((r) => (
                <div key={r.id} className="notif-center-item">
                  <div className="notif-center-item-top">
                    {r.profilePicture ? (
                      <img
                        src={r.profilePicture}
                        alt=""
                        className="notif-center-avatar-img"
                        width={32}
                        height={32}
                      />
                    ) : (
                      <div className="list-item-avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
                        {(r.displayName || '?')[0].toUpperCase()}
                      </div>
                    )}
                    <div className="notif-center-item-info">
                      <div className="notif-center-item-name-row">
                        <span className="notif-center-item-name">{r.displayName}</span>
                        <span className={r.offline ? 'offline-dot' : 'online-dot'} title={r.offline ? 'Offline' : 'Online'} />
                      </div>
                      <div className="notif-center-item-preview">{previewLine(r.lastMessage)}</div>
                      {r.lastMessage?.timestamp && (
                        <div className="notif-center-item-time text-xs text-muted">{formatTime(r.lastMessage.timestamp)}</div>
                      )}
                    </div>
                  </div>
                  <div className="notif-center-item-actions">
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => handleAccept(r.id)}>
                      <Check size={14} />
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      title="Dismiss"
                      onClick={() => handleDismiss(r.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
