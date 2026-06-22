import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, Smile, Star, Trash2 } from 'lucide-react';
import SettingsBackHeader from '../../components/settings/SettingsBackHeader';
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
  const toast = useToast();
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
    <div className="page">
      <input
        type="file"
        hidden
        ref={fileInputRef}
        accept="image/png,image/webp,image/gif,image/jpeg"
        onChange={(e) => void handleFileChange(e)}
      />
      <SettingsBackHeader
        title="Sticker"
        subtitle="Erstellen, verwalten und Favoriten"
        icon={Smile}
      />

      <div className="page-body">
        <section className="settings-section">
          <div className="card stickers-settings-overview">
            <div className="stickers-settings-stats">
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
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-section-title">Packs</h3>
          <div className="card">
            <div className="stickers-settings-pack-tabs">
              {packs.map((pack) => (
                <button
                  key={pack.id}
                  type="button"
                  className={`stickers-settings-pack-tab${pack.id === selectedPackId ? ' active' : ''}`}
                  onClick={() => setSelectedPackId(pack.id)}
                >
                  {pack.name}
                  <span className="stickers-settings-pack-count">{pack.stickers?.length || 0}</span>
                </button>
              ))}
            </div>
            <div className="stickers-settings-pack-actions">
              <div className="stickers-settings-new-pack">
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
                  Pack erstellen
                </button>
              </div>
              {selectedPack && selectedPack.id !== DEFAULT_PACK_ID ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm stickers-settings-delete-pack"
                  onClick={() => void handleDeletePack(selectedPack.id)}
                >
                  <Trash2 size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                  Pack löschen
                </button>
              ) : null}
            </div>
          </div>
        </section>

        {selectedPack ? (
          <section className="settings-section">
            <div className="settings-section-header-row">
              <h3 className="settings-section-title">{selectedPack.name}</h3>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleAddSticker}
                disabled={loading}
              >
                <Plus size={14} strokeWidth={SETTINGS_ICON_STROKE} aria-hidden />
                Sticker hinzufügen
              </button>
            </div>
            <div className="card">
              <div className="stickers-settings-grid">
                {(selectedPack.stickers || []).map((sticker) => {
                  const src = getStickerDataUrl(sticker);
                  const isFav = favorites.includes(sticker.id);
                  return (
                    <div key={sticker.id} className="stickers-settings-item">
                      <div className="stickers-settings-item-preview">
                        {src ? <img src={src} alt="" loading="lazy" /> : null}
                      </div>
                      <div className="stickers-settings-item-meta">
                        <span className="stickers-settings-item-name" title={sticker.name}>
                          {sticker.name || sticker.fileName}
                        </span>
                        <span className="stickers-settings-item-size">{formatStickerSize(sticker.fileSize || 0)}</span>
                      </div>
                      <div className="stickers-settings-item-actions">
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
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
