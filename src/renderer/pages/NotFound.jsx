import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, SearchX } from 'lucide-react';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="page page-inset">
      <div className="page-shell">
        <div className="error-page error-page--embed error-page--muted">
          <div className="error-page-card animate-scale">
            <div className="error-page-icon error-page-icon--muted" aria-hidden>
              <SearchX size={28} strokeWidth={1.75} />
            </div>
            <h1 className="error-page-title">Seite nicht gefunden</h1>
            <p className="error-page-lead text-muted">
              Diese Adresse gibt es in BlueTalk nicht. Nutze die Seitenleiste oder kehre zu deinen Chats zurück.
            </p>
            <div className="error-page-actions">
              <button type="button" className="btn btn-primary" onClick={() => navigate('/', { replace: true, viewTransition: true })}>
                <Home size={15} strokeWidth={1.75} aria-hidden />
                Zu den Chats
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
