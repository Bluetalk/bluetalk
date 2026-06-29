import React from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.DEV) {
      console.error('ErrorBoundary', error, info);
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error?.message || 'Something went wrong.';

    return (
      <div className="error-page">
        <div className="error-page-card animate-scale">
          <div className="error-page-icon" aria-hidden>
            <AlertTriangle size={28} strokeWidth={1.75} />
          </div>
          <h1 className="error-page-title">This view crashed</h1>
          <p className="error-page-lead text-muted">
            BlueTalk hit an unexpected error. You can reload the window or return to chats. If this keeps happening, try
            restarting the app.
          </p>
          <pre className="error-page-detail">{message}</pre>
          <div className="error-page-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => window.location.reload()}
            >
              <RefreshCw size={15} strokeWidth={1.75} aria-hidden />
              Reload
            </button>
            {this.props.showHomeAction !== false ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  this.setState({ error: null });
                  window.location.hash = '#/';
                }}
              >
                <Home size={15} strokeWidth={1.75} aria-hidden />
                Back to chats
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }
}
