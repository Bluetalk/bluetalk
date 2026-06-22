import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Star, X } from 'lucide-react';
import {
  addSticker,
  addToRecent,
  DEFAULT_PACK_ID,
  getStickerDataUrl,
  loadFavorites,
  loadRecent,
  loadStickerPacks,
  readStickerFile,
  toggleFavorite,
} from '../stickers/stickerStore';

const ICON_STROKE = 1.75;

export default function StickerPicker({ open, anchorRef, onClose, onSelect, onError, disabled }) {
  const panelRef = useRef(null);
  const fileInputRef = useRef(null);
  const [position, setPosition] = useState({ bottom: 0, left: 0 });
  const [packs, setPacks] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [recent, setRecent] = useState([]);
  const [activeTab, setActiveTab] = useState('favorites');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const [p, f, r] = await Promise.all([loadStickerPacks(), loadFavorites(), loadRecent()]);
    setPacks(p);
    setFavorites(f);
    setRecent(r);
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open || !anchorRef?.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPosition({ bottom: window.innerHeight - r.top + 8, left: r.left });
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (e) => {
      const t = e.target;
      if (anchorRef?.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('mousedown', onPointer, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onPointer, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  const resolveStickers = (ids) => {
    const result = [];
    for (const id of ids) {
      for (const pack of packs) {
        const sticker = pack.stickers?.find((s) => s.id === id);
        if (sticker) {
          result.push({ ...sticker, packId: pack.id });
          break;
        }
      }
    }
    return result;
  };

  const favoriteStickers = resolveStickers(favorites);
  const recentStickers = resolveStickers(recent);
  const activePack = activeTab.startsWith('pack:')
    ? packs.find((p) => p.id === activeTab.slice(5))
    : null;
  const gridStickers =
    activeTab === 'favorites'
      ? favoriteStickers
      : activeTab === 'recent'
        ? recentStickers
        : activePack?.stickers || [];

  const handleSelect = async (sticker, packId) => {
    if (disabled) return;
    await addToRecent(sticker.id);
    onSelect?.({
      kind: 'sticker',
      stickerId: sticker.id,
      packId,
      fileName: sticker.fileName,
      fileType: sticker.fileType,
      fileData: sticker.fileData,
      fileSize: sticker.fileSize,
      content: sticker.name || 'Sticker',
    });
    onClose?.();
  };

  const handleFavorite = async (e, stickerId) => {
    e.stopPropagation();
    const next = await toggleFavorite(stickerId);
    setFavorites(next);
  };

  const handleCreate = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setLoading(true);
    try {
      const data = await readStickerFile(file);
      const packId = activePack?.id || DEFAULT_PACK_ID;
      const { sticker, packId: savedPackId } = await addSticker({
        packId,
        fileName: data.fileName,
        fileType: data.fileType,
        fileData: data.fileData,
        fileSize: data.fileSize,
      });
      await refresh();
      setActiveTab(`pack:${savedPackId}`);
      await handleSelect(sticker, savedPackId);
    } catch (err) {
      onError?.(err);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return createPortal(
    <>
      <input
        type="file"
        hidden
        ref={fileInputRef}
        accept="image/png,image/webp,image/gif,image/jpeg"
        onChange={(e) => void handleFileChange(e)}
      />
      <div
        ref={panelRef}
        className="sticker-picker animate-scale"
        style={{
          position: 'fixed',
          bottom: position.bottom,
          left: position.left,
          zIndex: 1260,
        }}
        role="dialog"
        aria-label="Sticker auswählen"
      >
        <div className="sticker-picker-header">
          <div className="sticker-picker-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'favorites'}
              className={`sticker-picker-tab${activeTab === 'favorites' ? ' active' : ''}`}
              onClick={() => setActiveTab('favorites')}
            >
              <Star size={14} strokeWidth={ICON_STROKE} aria-hidden />
              Favoriten
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'recent'}
              className={`sticker-picker-tab${activeTab === 'recent' ? ' active' : ''}`}
              onClick={() => setActiveTab('recent')}
            >
              Zuletzt
            </button>
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                role="tab"
                aria-selected={activeTab === `pack:${pack.id}`}
                className={`sticker-picker-tab${activeTab === `pack:${pack.id}` ? ' active' : ''}`}
                onClick={() => setActiveTab(`pack:${pack.id}`)}
              >
                {pack.name}
              </button>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Schließen">
            <X size={16} strokeWidth={ICON_STROKE} />
          </button>
        </div>

        <div className="sticker-picker-grid">
          <button
            type="button"
            className="sticker-picker-create"
            onClick={handleCreate}
            disabled={loading || disabled}
            title="Sticker erstellen"
          >
            <Plus size={22} strokeWidth={ICON_STROKE} />
            <span>{loading ? '…' : 'Neu'}</span>
          </button>
          {gridStickers.map((sticker) => {
            const packId = sticker.packId || activePack?.id || DEFAULT_PACK_ID;
            const isFav = favorites.includes(sticker.id);
            const src = getStickerDataUrl(sticker);
            return (
              <button
                key={sticker.id}
                type="button"
                className="sticker-picker-item"
                onClick={() => void handleSelect(sticker, packId)}
                disabled={disabled}
                title={sticker.name || 'Sticker'}
              >
                {src ? <img src={src} alt="" loading="lazy" /> : null}
                <span
                  role="button"
                  tabIndex={0}
                  className={`sticker-picker-fav${isFav ? ' is-fav' : ''}`}
                  onClick={(e) => void handleFavorite(e, sticker.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleFavorite(e, sticker.id);
                    }
                  }}
                  aria-label={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
                >
                  <Star size={12} strokeWidth={ICON_STROKE} fill={isFav ? 'currentColor' : 'none'} />
                </span>
              </button>
            );
          })}
          {gridStickers.length === 0 && activeTab !== 'favorites' ? (
            <div className="sticker-picker-empty">Noch keine Sticker in diesem Pack</div>
          ) : null}
          {gridStickers.length === 0 && activeTab === 'favorites' ? (
            <div className="sticker-picker-empty">Markiere Sticker mit ★ als Favoriten</div>
          ) : null}
        </div>
      </div>
    </>,
    document.body
  );
}
