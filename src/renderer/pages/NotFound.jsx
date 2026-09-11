import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Home, SearchX } from 'lucide-react';

export default function NotFoundPage() {
  const navigate = useNavigate();

  return (
    <div className="page">
      <div className="error-page error-page--embed error-page--muted">
        <div className="error-page-card animate-scale">
          <div className="error-page-icon error-page-icon--muted" aria-hidden>
            <SearchX size={28} strokeWidth={1.75} />
          </div>
          <h1 className="error-page-title">Page not found</h1>
          <p className="error-page-lead text-muted">
            That route does not exist in BlueTalk. Check the sidebar or return to your chats.
          </p>
          <div className="error-page-actions">
            <button type="button" className="btn btn-primary" onClick={() => navigate('/', { replace: true, viewTransition: true })}>
              <Home size={15} strokeWidth={1.75} aria-hidden />
              Go to chats
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
