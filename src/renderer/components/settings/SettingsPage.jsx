import React from 'react';

export default function SettingsPage({ title, children }) {
  return (
    <div className="settings-panel">
      {title ? <h2 className="settings-panel-title">{title}</h2> : null}
      {children}
    </div>
  );
}
