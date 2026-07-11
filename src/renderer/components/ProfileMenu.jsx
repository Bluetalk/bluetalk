import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Cloud, User } from 'lucide-react';
import { useApp } from '../App';
import { useToast } from './ToastProvider';

const MAX_AVATAR_BYTES = 380 * 1024;

function readImageDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Not an image'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      reject(new Error(`Use an image under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Read failed'));
    reader.readAsDataURL(file);
  });
}

export default function ProfileMenu({ variant = 'default' }) {
  const isSidebar = variant === 'sidebar';
  const { toast } = useToast();
  const { settings, updateSettings } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(settings.displayName || '');
  const [bioDraft, setBioDraft] = useState(settings.bio || '');
  const wrapRef = useRef(null);
  const fileRef = useRef(null);
  const prevOpenRef = useRef(false);
  const openRef = useRef(false);
  const commitDraftsRef = useRef(() => {});

  // Kept in a ref (updated every render) so the unmount cleanup below
  // always commits the latest drafts without stale closures.
  commitDraftsRef.current = () => {
    const nextName = nameDraft.trim() || 'Anonymous';
    if (nextName !== (settings.displayName || '').trim()) {
      updateSettings({ displayName: nextName });
    }
    const nextBio = bioDraft.slice(0, 500);
    if (nextBio !== (settings.bio || '')) {
      updateSettings({ bio: nextBio });
    }
  };

  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    if (open && !wasOpen) {
      setNameDraft(settings.displayName || '');
      setBioDraft(settings.bio || '');
    }
    if (wasOpen && !open) {
      commitDraftsRef.current();
    }
    prevOpenRef.current = open;
    openRef.current = open;
  }, [open, settings.displayName, settings.bio]);

  // Commit pending drafts when the component unmounts while still open
  // (e.g. sidebar collapse). openRef guards against a double commit after
  // a normal close already committed.
  useEffect(() => () => {
    if (openRef.current) {
      openRef.current = false;
      commitDraftsRef.current();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const initial = (settings.displayName || '?')[0].toUpperCase();

  const onAvatarPick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageDataUrl(file);
      updateSettings({ profilePicture: dataUrl });
    } catch (err) {
      toast({
        variant: 'error',
        title: 'Profile photo',
        message: err.message || 'Could not use this image.',
      });
    }
  };

  const clearAvatar = () => {
    updateSettings({ profilePicture: '' });
  };

  return (
    <div
      className={`profile-menu-wrap${isSidebar ? ' profile-menu-wrap--sidebar' : ''}${open ? ' profile-menu-wrap--open' : ''}`}
      ref={wrapRef}
    >
      <button
        type="button"
        className={`profile-menu-trigger${isSidebar ? ' profile-menu-trigger--sidebar' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Profile"
      >
        {settings.profilePicture ? (
          <img src={settings.profilePicture} alt="" className="profile-menu-trigger-avatar" />
        ) : (
          <span className="profile-menu-trigger-letter">{initial}</span>
        )}
        {isSidebar ? (
          <span className="profile-menu-sidebar-label">Profile</span>
        ) : (
          open ? <ChevronDown size={15} strokeWidth={1.75} /> : <ChevronUp size={15} strokeWidth={1.75} />
        )}
      </button>

      {open && (
        <div className="profile-menu-dropdown animate-scale">
          <div className="profile-menu-header">
            <User size={14} strokeWidth={1.75} aria-hidden />
            <span>Your profile</span>
          </div>

          <div className="profile-menu-body">
            <div className="profile-menu-avatar-row">
              {settings.profilePicture ? (
                <img src={settings.profilePicture} alt="" className="profile-menu-preview" />
              ) : (
                <div className="profile-menu-preview profile-menu-preview-placeholder">{initial}</div>
              )}
              <div className="profile-menu-avatar-actions">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
                  Change photo
                </button>
                {settings.profilePicture ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={clearAvatar}>
                    Remove
                  </button>
                ) : null}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={onAvatarPick}
              />
            </div>
            <div className="input-group">
              <label htmlFor="profile-menu-name">Display name</label>
              <p className="profile-menu-field-note">
                This is how you appear to others.
              </p>
              <input
                id="profile-menu-name"
                className="input"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder="Your name"
              />
            </div>

            <div className="input-group">
              <label htmlFor="profile-menu-bio">Bio</label>
              <textarea
                id="profile-menu-bio"
                className="input profile-menu-bio"
                rows={3}
                placeholder="A short line about you…"
                value={bioDraft}
                maxLength={500}
                onChange={(e) => setBioDraft(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="btn btn-cloud-sync w-full"
              onClick={() => {
                setOpen(false);
                navigate('/cloud-sync');
              }}
            >
              <Cloud size={16} strokeWidth={1.75} />
              Cloud sync
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
