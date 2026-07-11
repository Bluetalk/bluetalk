import React, { useState } from 'react';
import { X } from 'lucide-react';
import { CHAT_ICON_STROKE } from '../messageHelpers.jsx';

/**
 * "Connect to Peer"-Dialog. Adresse/Connecting-Zustand leben lokal; die
 * Komponente bleibt dauerhaft gemountet (return null bei !open), damit die
 * zuletzt eingegebene Adresse — wie zuvor — über Schließen/Öffnen erhalten bleibt.
 *
 * Props: open, onClose(), connectToAddress(address), onConnected(peerId),
 * setWarning(msg), toast
 */
export function ConnectDialog({ open, onClose, connectToAddress, onConnected, setWarning, toast }) {
  const [connectAddress, setConnectAddress] = useState('');
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    if (!connectAddress.trim()) return;
    setConnecting(true);
    setWarning('');
    try {
      let dial = connectAddress.trim();
      if (window.bluetalk?.peer?.normalizeAddress) {
        const norm = await window.bluetalk.peer.normalizeAddress(dial);
        if (norm?.ok && norm.normalized) {
          dial = norm.normalized;
        }
      }
      const peerInfo = await connectToAddress(dial);
      onConnected(peerInfo.id);
      onClose();
      setConnectAddress('');
    } catch (err) {
      const msg = err.message || 'Connection failed';
      setWarning(msg);
      toast({ variant: 'error', title: 'Connection failed', message: msg });
    } finally {
      setConnecting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 style={{ margin: 0 }}>Connect to Peer</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Schließen">
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <div className="input-group">
          <label>Address or IP</label>
          <input
            className="input font-mono"
            placeholder="e.g. 192.168.1.42 or 192.168.1.42:8080"
            value={connectAddress}
            onChange={(e) => setConnectAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleConnect()}
            autoFocus
          />
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleConnect} disabled={!connectAddress.trim() || connecting}>
            {connecting ? (
              <span className="spinner-label">
                <span className="spinner spinner--sm spinner--accent" />
                <span>Connecting</span>
              </span>
            ) : 'Connect'}
          </button>
        </div>
      </div>
    </div>
  );
}
