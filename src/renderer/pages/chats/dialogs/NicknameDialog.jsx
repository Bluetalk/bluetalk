import React from 'react';
import { X } from 'lucide-react';
import { CHAT_ICON_STROKE } from '../messageHelpers.jsx';

/**
 * "Set Nickname"-Dialog. Der Eingabewert bleibt im Parent (er wird dort vor
 * dem Öffnen aus dem jeweiligen Chat vorbelegt) — exakt wie zuvor.
 *
 * Props: open, selectedPeer, value, onChange(value), onSave(), onClose()
 */
export function NicknameDialog({ open, selectedPeer, value, onChange, onSave, onClose }) {
  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal animate-scale" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2">
          <h3 style={{ margin: 0 }}>Set Nickname</h3>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Schließen">
            <X size={16} strokeWidth={CHAT_ICON_STROKE} />
          </button>
        </div>
        <div className="input-group">
          <label>Nickname</label>
          <input
            className="input"
            placeholder={`Current: ${selectedPeer.baseName}`}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSave()}
            autoFocus
          />
          <span className="text-xs text-muted">Leave empty to clear the nickname.</span>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
