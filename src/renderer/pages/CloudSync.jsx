import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Cloud } from 'lucide-react';

export default function CloudSyncPage() {
  const navigate = useNavigate();

  return (
    <div className="page cloud-sync-page">
      <div className="cloud-sync-inner">
        <div className="cloud-sync-hero">
          <div className="cloud-sync-hero-copy">
            <div className="cloud-sync-icon-wrap" aria-hidden>
              <Cloud size={40} strokeWidth={1.5} />
            </div>
            <h1 className="cloud-sync-title">Cloud messaging</h1>
            <p className="cloud-sync-lead">
              Blazingly fast, end-to-end encrypted messages synced through the cloud are coming to BlueTalk soon.
            </p>
            <p className="cloud-sync-sub text-muted">
              Your local peer-to-peer chats stay as they are; this will be an optional layer when it lands.
            </p>
          </div>
          <button type="button" className="btn btn-cloud-sync cloud-sync-back" onClick={() => navigate(-1, { viewTransition: true })}>
            <ArrowLeft size={18} strokeWidth={2} />
            Back
          </button>
        </div>
      </div>
    </div>
  );
}
