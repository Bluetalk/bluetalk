import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export default function SettingsBackHeader({ title, subtitle, icon: Icon }) {
  const navigate = useNavigate();

  return (
    <div className="page-header settings-subpage-header">
      <button
        type="button"
        className="btn btn-ghost btn-sm settings-subpage-back"
        onClick={() => navigate('/settings')}
      >
        <ArrowLeft size={16} strokeWidth={2} />
        Settings
      </button>
      <h1 className="page-title-row">
        {Icon ? (
          <span className="page-title-icon" aria-hidden>
            <Icon size={18} strokeWidth={1.75} />
          </span>
        ) : null}
        {title}
      </h1>
      {subtitle ? <p>{subtitle}</p> : null}
    </div>
  );
}
