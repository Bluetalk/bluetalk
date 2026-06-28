import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Check, Crown, LogOut, Plus, Shield, Trash2, Users, X } from 'lucide-react';
import groupChat from '../../shared/group-chat.js';

const { getGroupMember, isActiveGroupMember, isGroupAdmin } = groupChat;

const MAX_GROUP_IMAGE_BYTES = 380 * 1024;

function useEscapeClose(open, busy, onClose) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, busy, onClose]);
}

function readGroupImage(file) {
  return new Promise((resolve, reject) => {
    if (!file?.type?.startsWith('image/')) {
      reject(new Error('Bitte eine Bilddatei auswählen.'));
      return;
    }
    if (file.size > MAX_GROUP_IMAGE_BYTES) {
      reject(new Error('Das Gruppenbild darf höchstens 380 KB groß sein.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

function MemberAvatar({ picture, name, group = false }) {
  if (picture) return <img className="group-member-avatar" src={picture} alt="" />;
  return (
    <span className={`group-member-avatar group-member-avatar--fallback${group ? ' group-member-avatar--group' : ''}`} aria-hidden>
      {group ? <Users size={22} /> : String(name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

function ContactChoice({ contact, checked, online, onToggle, disabled = false }) {
  const name = contact.nickname || contact.name || contact.id;
  return (
    <label className={`group-contact-choice${checked ? ' group-contact-choice--selected' : ''}`}>
      <input type="checkbox" checked={checked} onChange={onToggle} disabled={disabled} />
      <MemberAvatar picture={contact.profilePicture} name={name} />
      <span className="group-contact-choice-copy">
        <span className="group-contact-choice-name">{name}</span>
        <span className="group-contact-choice-meta">{online ? 'Online' : 'Offline · Einladung wird vorgemerkt'}</span>
      </span>
      <span className="group-contact-choice-check" aria-hidden>{checked ? <Check size={14} /> : null}</span>
    </label>
  );
}

export function CreateGroupModal({ open, contacts, peers, onCreate, onClose }) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  const onlineIds = useMemo(() => new Set((peers || []).map((peer) => peer.id)), [peers]);
  const choices = useMemo(
    () => (contacts || []).filter((contact) => contact?.id && !contact.blocked && !contact.blockedByPeer),
    [contacts]
  );
  useEscapeClose(open, busy, () => onClose(''));

  useEffect(() => {
    if (!open) return;
    setName('');
    setImage('');
    setSelected(new Set());
    setBusy(false);
    setError('');
  }, [open]);

  if (!open) return null;

  const toggle = (peerId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Gib der Gruppe einen Namen.');
      return;
    }
    if (selected.size === 0) {
      setError('Wähle mindestens einen Kontakt aus.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const group = await onCreate({ name: trimmed, image, memberIds: [...selected] });
      onClose(group?.id || '');
    } catch (cause) {
      setError(cause?.message || 'Die Gruppe konnte nicht erstellt werden.');
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose('')}>
      <form className="modal animate-scale group-create-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-label="Neue Gruppe">
        <div className="group-modal-toolbar">
          <div>
            <h2>Neue Gruppe</h2>
            <p>Ein gemeinsamer, Ende-zu-Ende-verschlüsselter Chat.</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => onClose('')} disabled={busy} aria-label="Schließen">
            <X size={18} />
          </button>
        </div>

        <div className="group-create-profile">
          <button type="button" className="group-image-picker" onClick={() => fileRef.current?.click()} title="Gruppenbild auswählen">
            <MemberAvatar picture={image} name={name} group />
            <span className="group-image-picker-badge"><Camera size={14} /></span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={async (event) => {
              try {
                const next = await readGroupImage(event.target.files?.[0]);
                setImage(next);
                setError('');
              } catch (cause) {
                setError(cause.message);
              }
              event.target.value = '';
            }}
          />
          <label className="group-name-field">
            <span>Gruppenname</span>
            <input className="input" value={name} onChange={(event) => setName(event.target.value.slice(0, 80))} autoFocus placeholder="Zum Beispiel Projektteam" />
          </label>
        </div>

        <div className="group-modal-section-head">
          <span>Kontakte</span>
          <span>{selected.size} ausgewählt</span>
        </div>
        <div className="group-contact-list">
          {choices.length ? choices.map((contact) => (
            <ContactChoice
              key={contact.id}
              contact={contact}
              online={onlineIds.has(contact.id)}
              checked={selected.has(contact.id)}
              onToggle={() => toggle(contact.id)}
              disabled={busy}
            />
          )) : <p className="group-modal-empty">Füge zuerst Kontakte hinzu, um eine Gruppe zu erstellen.</p>}
        </div>
        {error ? <div className="group-modal-error" role="alert">{error}</div> : null}
        <div className="modal-actions group-modal-actions">
          <button type="button" className="btn btn-secondary" onClick={() => onClose('')} disabled={busy}>Abbrechen</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !choices.length}>
            {busy ? <span className="spinner spinner--sm" /> : <Users size={16} />}
            Gruppe erstellen
          </button>
        </div>
      </form>
    </div>
  );
}

export function GroupInfoModal({ open, group, ownPeerId, contacts, peers, onUpdate, onLeave, onDelete, onClose }) {
  const [name, setName] = useState('');
  const [image, setImage] = useState('');
  const [addIds, setAddIds] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef(null);
  const contactMap = useMemo(() => new Map((contacts || []).map((contact) => [contact.id, contact])), [contacts]);
  const onlineIds = useMemo(() => new Set((peers || []).map((peer) => peer.id)), [peers]);
  const selfMember = group ? getGroupMember(group, ownPeerId) : null;
  const admin = group ? isGroupAdmin(group, ownPeerId) : false;
  const active = group ? isActiveGroupMember(group, ownPeerId) : false;
  const presentIds = useMemo(
    () => new Set((group?.members || []).filter((member) => ['active', 'invited'].includes(member.state)).map((member) => member.peerId)),
    [group]
  );
  const addable = useMemo(
    () => (contacts || []).filter((contact) => contact?.id && !presentIds.has(contact.id) && !contact.blocked && !contact.blockedByPeer),
    [contacts, presentIds]
  );
  useEscapeClose(open, busy, onClose);

  useEffect(() => {
    if (!open || !group) return;
    setName(group.name || '');
    setImage(group.image || '');
    setAddIds(new Set());
    setBusy(false);
    setError('');
    setConfirmLeave(false);
    setConfirmDelete(false);
  }, [open, group]);

  if (!open || !group) return null;

  const saveInfo = async () => {
    setBusy(true);
    setError('');
    try {
      await onUpdate(group.id, { name: name.trim(), image, reason: 'group-info' });
    } catch (cause) {
      setError(cause?.message || 'Änderungen konnten nicht gespeichert werden.');
    } finally {
      setBusy(false);
    }
  };

  const addMembers = async () => {
    if (!addIds.size) return;
    setBusy(true);
    setError('');
    try {
      await onUpdate(group.id, { addMemberIds: [...addIds], reason: 'members-added' });
      setAddIds(new Set());
    } catch (cause) {
      setError(cause?.message || 'Mitglieder konnten nicht hinzugefügt werden.');
    } finally {
      setBusy(false);
    }
  };

  const removeMember = async (peerId) => {
    setBusy(true);
    setError('');
    try {
      await onUpdate(group.id, { removeMemberIds: [peerId], reason: 'member-removed' });
    } catch (cause) {
      setError(cause?.message || 'Mitglied konnte nicht entfernt werden.');
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    setError('');
    try {
      await onLeave(group.id);
      onClose();
    } catch (cause) {
      setError(cause?.message || 'Die Gruppe konnte nicht verlassen werden.');
      setBusy(false);
    }
  };

  const removeGroup = async () => {
    setBusy(true);
    setError('');
    try {
      await onDelete(group.id);
      onClose();
    } catch (cause) {
      setError(cause?.message || 'Die Gruppe konnte nicht gelöscht werden.');
      setBusy(false);
    }
  };

  const sortedMembers = [...group.members].sort((a, b) => {
    const rank = (member) => member.state === 'active' ? (member.role === 'admin' ? 0 : 1) : member.state === 'invited' ? 2 : 3;
    return rank(a) - rank(b) || a.displayName.localeCompare(b.displayName);
  });

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="modal animate-scale group-info-modal" role="dialog" aria-modal="true" aria-label="Gruppeninfo">
        <div className="group-modal-toolbar">
          <div>
            <h2>Gruppeninfo</h2>
            <p>Version {group.protocolVersion} · Änderung {group.revision}</p>
          </div>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} disabled={busy} aria-label="Schließen"><X size={18} /></button>
        </div>

        <div className="group-info-scroll">
          <div className="group-info-hero">
            <button type="button" className="group-image-picker" onClick={() => admin && fileRef.current?.click()} disabled={!admin} title={admin ? 'Gruppenbild ändern' : undefined}>
              <MemberAvatar picture={image} name={name} group />
              {admin ? <span className="group-image-picker-badge"><Camera size={14} /></span> : null}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={async (event) => {
                try {
                  setImage(await readGroupImage(event.target.files?.[0]));
                  setError('');
                } catch (cause) {
                  setError(cause.message);
                }
                event.target.value = '';
              }}
            />
            {admin ? (
              <div className="group-info-name-edit">
                <input className="input" value={name} onChange={(event) => setName(event.target.value.slice(0, 80))} />
                <button type="button" className="btn btn-primary btn-sm" onClick={saveInfo} disabled={busy || !name.trim()}>Speichern</button>
              </div>
            ) : <h3>{group.name}</h3>}
            <span className={`group-membership-badge group-membership-badge--${selfMember?.state || 'removed'}`}>
              {active
                ? `${group.members.filter((member) => member.state === 'active').length} Mitglieder`
                : selfMember?.state === 'invited'
                  ? 'Beitritt wird bestätigt'
                  : 'Nicht mehr Mitglied'}
            </span>
          </div>

          <section className="group-info-section">
            <div className="group-modal-section-head"><span>Mitglieder</span><span>{group.members.length}</span></div>
            <div className="group-member-list">
              {sortedMembers.map((member) => {
                const contact = contactMap.get(member.peerId);
                const displayName = member.peerId === ownPeerId ? `${member.displayName} (Du)` : (contact?.nickname || member.displayName);
                const inactive = member.state === 'left' || member.state === 'removed';
                return (
                  <div className={`group-member-row${inactive ? ' group-member-row--inactive' : ''}`} key={member.peerId}>
                    <MemberAvatar picture={contact?.profilePicture} name={displayName} />
                    <div className="group-member-copy">
                      <span className="group-member-name">{displayName}</span>
                      <span className="group-member-status">
                        {member.state === 'invited' ? 'Einladung ausstehend' : member.state === 'left' ? 'Ausgetreten' : member.state === 'removed' ? 'Entfernt' : onlineIds.has(member.peerId) || member.peerId === ownPeerId ? 'Online' : 'Offline'}
                      </span>
                    </div>
                    {member.role === 'admin' && !inactive ? <span className="group-admin-badge"><Crown size={12} /> Admin</span> : null}
                    {admin && member.peerId !== ownPeerId && !inactive ? (
                      <button type="button" className="btn btn-ghost btn-icon btn-sm group-member-remove" onClick={() => removeMember(member.peerId)} disabled={busy} title="Mitglied entfernen" aria-label={`${displayName} entfernen`}>
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          {admin && active && addable.length ? (
            <section className="group-info-section">
              <div className="group-modal-section-head"><span>Mitglieder hinzufügen</span><span>{addIds.size} ausgewählt</span></div>
              <div className="group-contact-list group-contact-list--compact">
                {addable.map((contact) => (
                  <ContactChoice
                    key={contact.id}
                    contact={contact}
                    online={onlineIds.has(contact.id)}
                    checked={addIds.has(contact.id)}
                    disabled={busy}
                    onToggle={() => setAddIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(contact.id)) next.delete(contact.id);
                      else next.add(contact.id);
                      return next;
                    })}
                  />
                ))}
              </div>
              <button type="button" className="btn btn-secondary btn-sm group-add-members-btn" onClick={addMembers} disabled={busy || !addIds.size}>
                <Plus size={15} /> Mitglieder hinzufügen
              </button>
            </section>
          ) : null}

          <div className="group-security-note"><Shield size={16} /><span>Nachrichten werden für jedes Mitglied separat mit der paarweisen E2EE-Sitzung verschlüsselt.</span></div>
          {error ? <div className="group-modal-error" role="alert">{error}</div> : null}
        </div>

        {active || selfMember ? (
          <div className="group-info-footer">
            {active && !confirmDelete ? (
              confirmLeave ? (
                <div className="group-leave-confirm">
                  <span>Gruppe wirklich verlassen?</span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmLeave(false)} disabled={busy}>Abbrechen</button>
                  <button type="button" className="btn btn-danger btn-sm" onClick={leave} disabled={busy}>Verlassen</button>
                </div>
              ) : (
                <button type="button" className="btn btn-ghost group-leave-btn" onClick={() => setConfirmLeave(true)} disabled={busy}>
                  <LogOut size={16} /> Gruppe verlassen
                </button>
              )
            ) : null}
            {!confirmLeave ? (
              confirmDelete ? (
                <div className="group-leave-confirm">
                  <span>
                    {active
                      ? 'Gruppe verlassen und alle Nachrichten auf diesem Gerät löschen?'
                      : 'Gruppe und alle Nachrichten auf diesem Gerät löschen?'}
                  </span>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmDelete(false)} disabled={busy}>Abbrechen</button>
                  <button type="button" className="btn btn-danger btn-sm" onClick={removeGroup} disabled={busy}>Löschen</button>
                </div>
              ) : (
                <button type="button" className="btn btn-ghost group-leave-btn" onClick={() => setConfirmDelete(true)} disabled={busy}>
                  <Trash2 size={16} /> Gruppe löschen
                </button>
              )
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
