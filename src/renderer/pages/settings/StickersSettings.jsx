import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Star, Trash2 } from 'lucide-react';
import SettingsPage from '../../components/settings/SettingsPage';
import { useToast } from '../../components/ToastProvider';
import {
  addSticker,
  computePacksSize,
  createPack,
  DEFAULT_PACK_ID,
  deletePack,
  deleteSticker,
  formatStickerSize,
  getStickerDataUrl,
  loadFavorites,
  loadStickerPacks,
  readStickerFile,
  toggleFavorite,
} from '../../stickers/stickerStore';
import { SETTINGS_ICON_STROKE } from './settingsUtils';

export default function StickersSettingsPage() {
  const { toast } = useToast();
  const fileInputRef = useRef(null);
  const [packs, setPacks] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [selectedPackId, setSelectedPackId] = useState(DEFAULT_PACK_ID);
  const [newPackName, setNewPackName] = useState('');
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const [p, f] = await Promise.all([loadStickerPacks(), loadFavorites()]);
    setPacks(p);
    setFavorites(f);
    if (!p.find((pack) => pack.id === selectedPackId)) {
      setSelectedPackId(p[0]?.id || DEFAULT_PACK_ID);
    }
  }, [selectedPackId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedPack = packs.find((p) => p.id === selectedPackId) || packs[0];
  const totalSize = computePacksSize(packs);
  const totalStickers = packs.reduce((n, p) => n + (p.stickers?.length || 0), 0);

  const handleAddSticker = () => fileInputRef.current?.click();

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !selectedPack) return;
    setLoading(true);
    try {
      const data = await readStickerFile(file);
      await addSticker({
        packId: selectedPack.id,
        fileName: data.fileName,
        fileType: data.fileType,
        fileData: data.fileData,
        fileSize: data.fileSize,
      });
      await refresh();
      toast({ variant: 'success', title: 'Sticker hinzugefügt' });
    } catch (err) {
      toast({ variant: 'error', title: 'Fehler', message: err?.message || 'Sticker konnte nicht erstellt werden' });
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePack = async () => {
    const name = newPackName.trim();
    if (!name) return;
    try {
      const { pack } = await createPack(name);
      setNewPackName('');
      setSelectedPackId(pack.id);
      await refresh();
      toast({ variant: 'success', title: 'Pack erstellt' });
    } catch (error) {
      toast({ variant: 'error', title: 'Pack konnte nicht erstellt werden', message: error?.message });
    }
  };

  const handleDeleteSticker = async (stickerId) => {
    await deleteSticker(stickerId);
    await refresh();
    toast({ variant: 'success', title: 'Sticker gelöscht' });
  };

  const handleDeletePack = async (packId) => {
    if (packId === DEFAULT_PACK_ID) return;
    const next = await deletePack(packId);
    if (next) {
      setSelectedPackId(DEFAULT_PACK_ID);
      await refresh();
      toast({ variant: 'success', title: 'Pack gelöscht' });
    }
  };

  const handleToggleFavorite = async (stickerId) => {
    const next = await toggleFavorite(stickerId);
    setFavorites(next);
  };

  return (
    <SettingsPage title="Sticker">
      <input
        type="file"
        hidden
        ref={fileInputRef}
        accept="image/png,image/webp,image/gif,image/jpeg"
        onChange={(e) => void handleFileChange(e)}
      />

      <div className="stickers-studio-stats">
        <div>
          <span className="stickers-settings-stat-value">{totalStickers}</span>
          <span className="stickers-settings-stat-label">Sticker</span>
        </div>
        <div>
          <span className="stickers-settings-stat-value">{packs.length}</span>
          <span className="stickers-settings-stat-label">Packs</span>
        </div>
        <div>
          <span className="stickers-settings-stat-value">{favorites.length}</span>
          <span className="stickers-settings-stat-label">Favoriten</span>
        </div>
        <div>
          <span className="stickers-settings-stat-value">{formatStickerSize(totalSize)}</span>
          <span className="stickers-settings-stat-label">Speicher</span>
        </div>
      </div>

      <div className="stickers-studio">
        <aside className="stickers-studio-packs">
          <div className="stickers-studio-packs-list">
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                className={`stickers-studio-pack${pack.id === selectedPackId ? ' is-active' : ''}`}
                onClick={() => setSelectedPackId(pack.id)}
              >
                <span className="stickers-studio-pack-name">{pack.name}</span>
                <span className="stickers-studio-pack-count">{pack.stickers?.length || 0}</span>
              </button>
            ))}
          </div>
          <div className="stickers-studio-new-pack">
            <input
              type="text"
              placeholder="Neues Pack…"
              value={newPackName}
              onChange={(e) => setNewPackName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCreatePack();
              }}
            />
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleCreatePack()}>
              Anlegen
            </button>
          </div>
        </aside>

        <div className="stickers-studio-main">
          {selectedPack ? (
            <>
              <div className="stickers-studio-toolbar">
                <h3 className="settings-section-heading">{selectedPack.name}</h3>
                <div className="stickers-studio-toolbar-actions">
                  {selectedPack.id !== DEFAULT_PACK_ID ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm stickers-settings-delete-pack"
                      onClick={() => void handleDeletePack(selectedPack.id)}
                    >
                      <Trash2 size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                      Pack löschen
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleAddSticker}
                    disabled={loading}
                  >
                    <Plus size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                    Hinzufügen
                  </button>
                </div>
              </div>
              <div className="stickers-studio-grid">
                {(selectedPack.stickers || []).map((sticker) => {
                  const src = getStickerDataUrl(sticker);
                  const isFav = favorites.includes(sticker.id);
                  return (
                    <div key={sticker.id} className="stickers-studio-item">
                      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : null}
                      <div className="stickers-studio-item-actions">
                        <button
                          type="button"
                          className={`btn btn-ghost btn-icon btn-sm${isFav ? ' is-fav' : ''}`}
                          onClick={() => void handleToggleFavorite(sticker.id)}
                          title={isFav ? 'Aus Favoriten entfernen' : 'Zu Favoriten hinzufügen'}
                        >
                          <Star size={14} strokeWidth={SETTINGS_ICON_STROKE} fill={isFav ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => void handleDeleteSticker(sticker.id)}
                          title="Sticker löschen"
                        >
                          <Trash2 size={14} strokeWidth={SETTINGS_ICON_STROKE} />
                        </button>
                      </div>
                    </div>
                  );
                })}
                {(selectedPack.stickers || []).length === 0 ? (
                  <p className="stickers-settings-empty">
                    Noch keine Sticker. Füge PNG, WebP oder GIF hinzu (max. 2 MB).
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </SettingsPage>
  );
}
