import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Download,
  Film,
  FolderOpen,
  Image,
  MessageSquare,
  Music,
  FileText,
  Smile,
} from 'lucide-react';
import { useApp } from '../App';
import { useToast } from '../components/ToastProvider';

const ICON_STROKE = 1.75;

const FILTERS = [
  { id: 'all', label: 'Alle', icon: FolderOpen },
  { id: 'image', label: 'Bilder', icon: Image },
  { id: 'video', label: 'Videos', icon: Film },
  { id: 'audio', label: 'Audio', icon: Music },
  { id: 'other', label: 'Dateien', icon: FileText },
  { id: 'sticker', label: 'Sticker', icon: Smile },
];

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function downloadBase64AsFile(fileName, base64) {
  const link = document.createElement('a');
  link.href = `data:application/octet-stream;base64,${base64}`;
  link.download = fileName || 'download';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export default function LibraryPage() {
  const { contacts } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [previewCache, setPreviewCache] = useState({});
  const previewCacheRef = useRef({});
  const previewPendingRef = useRef(new Map());
  const [lightbox, setLightbox] = useState(null);

  const refresh = useCallback(async () => {
    if (!window.bluetalk?.library?.listMedia) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const list = await window.bluetalk.library.listMedia();
      setItems(Array.isArray(list) ? list : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const contactName = useCallback(
    (peerId, sender) => {
      const c = contacts.find((x) => x.id === peerId);
      return c?.nickname || c?.displayName || sender || peerId?.slice(0, 8) || 'Unbekannt';
    },
    [contacts]
  );

  const filtered = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter((item) => item.category === filter);
  }, [items, filter]);

  const loadPreview = useCallback(async (item) => {
    const key = `${item.peerId}:${item.messageId}`;
    if (Object.prototype.hasOwnProperty.call(previewCacheRef.current, key)) {
      return previewCacheRef.current[key];
    }
    if (previewPendingRef.current.has(key)) return previewPendingRef.current.get(key);
    if (!item.hasData || !window.bluetalk?.library?.getMediaData) return null;
    const pending = (async () => {
      try {
        const data = await window.bluetalk.library.getMediaData(item.peerId, item.messageId);
        let entry = null;
        if (data?.fileData) {
          const mime = /^image\/(?:png|jpeg|gif|webp|bmp)$/i.test(data.fileType || '')
            ? data.fileType
            : 'application/octet-stream';
          const url = (item.category === 'image' || item.category === 'sticker') && mime.startsWith('image/')
            ? `data:${mime};base64,${data.fileData}`
            : null;
          entry = { ...data, url };
        }
        previewCacheRef.current = { ...previewCacheRef.current, [key]: entry };
        setPreviewCache(previewCacheRef.current);
        return entry;
      } catch {
        previewCacheRef.current = { ...previewCacheRef.current, [key]: null };
        setPreviewCache(previewCacheRef.current);
        return null;
      } finally {
        previewPendingRef.current.delete(key);
      }
    })();
    previewPendingRef.current.set(key, pending);
    return pending;
  }, []);

  useEffect(() => {
    const visual = filtered
      .filter((item) => (item.category === 'image' || item.category === 'sticker') && item.fileSize <= 2 * 1024 * 1024)
      .slice(0, 12);
    for (const item of visual) {
      void loadPreview(item);
    }
  }, [filtered, loadPreview]);

  const saveItem = async (item) => {
    const data = previewCache[`${item.peerId}:${item.messageId}`] ||
      (await loadPreview(item));
    if (!data?.fileData) {
      toast({ variant: 'error', title: 'Datei nicht verfügbar' });
      return;
    }
    const name = data.fileName || item.fileName || 'download';
    if (window.bluetalk?.file?.saveAs) {
      try {
        const res = await window.bluetalk.file.saveAs({ defaultFilename: name, base64: data.fileData });
        if (res?.ok) {
          toast({ variant: 'success', title: 'Datei gespeichert' });
          return;
        }
        if (res?.canceled) return;
      } catch {
        /* fallback */
      }
    }
    downloadBase64AsFile(name, data.fileData);
    toast({ variant: 'success', title: 'Download gestartet' });
  };

  const openItem = async (item) => {
    const data = previewCache[`${item.peerId}:${item.messageId}`] ||
      (await loadPreview(item));
    if (item.category === 'image' || item.category === 'sticker') {
      if (data?.url) {
        setLightbox({
          src: data.url,
          alt: item.fileName || 'Medien',
          defaultFilename: item.fileName || 'bild',
          base64: data.fileData,
        });
      }
      return;
    }
    await saveItem(item);
  };

  const goToChat = (peerId) => {
    navigate('/', { state: { openPeerId: peerId } });
  };

  return (
    <div className="page library-page">
      <div className="page-header">
        <div>
          <h1>Bibliothek</h1>
          <p className="page-subtitle">Alle empfangenen Dateien und Medien</p>
        </div>
      </div>

      <div className="page-body">
        <div className="library-filters">
          {FILTERS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`library-filter-btn${filter === id ? ' active' : ''}`}
              onClick={() => setFilter(id)}
            >
              <Icon size={14} strokeWidth={ICON_STROKE} aria-hidden />
              {label}
              {id === 'all' ? (
                <span className="library-filter-count">{items.length}</span>
              ) : (
                <span className="library-filter-count">
                  {items.filter((i) => i.category === id).length}
                </span>
              )}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="library-loading">
            <span className="spinner spinner--accent" />
            <span>Bibliothek wird geladen…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="library-empty card">
            <FolderOpen size={32} strokeWidth={ICON_STROKE} aria-hidden />
            <p>Noch keine empfangenen Dateien</p>
            <span>Dateien und Sticker aus Chats erscheinen hier automatisch.</span>
          </div>
        ) : (
          <div className="library-grid">
            {filtered.map((item) => {
              const key = `${item.peerId}:${item.messageId}`;
              const preview = previewCache[key];
              const isVisual = item.category === 'image' || item.category === 'sticker';
              const FilterIcon = FILTERS.find((f) => f.id === item.category)?.icon || FileText;
              return (
                <div key={key} className="library-item card">
                  <button
                    type="button"
                    className="library-item-preview"
                    onClick={() => void openItem(item)}
                  >
                    {isVisual && preview?.url ? (
                      <img src={preview.url} alt="" loading="lazy" />
                    ) : (
                      <div className="library-item-icon">
                        <FilterIcon size={28} strokeWidth={ICON_STROKE} />
                      </div>
                    )}
                    {item.category === 'sticker' ? (
                      <span className="library-item-badge">Sticker</span>
                    ) : null}
                  </button>
                  <div className="library-item-info">
                    <div className="library-item-name" title={item.fileName || ''}>
                      {item.fileName || (item.kind === 'sticker' ? 'Sticker' : 'Datei')}
                    </div>
                    <div className="library-item-meta">
                      <span>{contactName(item.peerId, item.sender)}</span>
                      {item.fileSize ? <span>{formatSize(item.fileSize)}</span> : null}
                    </div>
                    <div className="library-item-date">{formatDate(item.timestamp)}</div>
                  </div>
                  <div className="library-item-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      title="Speichern"
                      onClick={() => void saveItem(item)}
                    >
                      <Download size={14} strokeWidth={ICON_STROKE} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon btn-sm"
                      title="Zum Chat"
                      onClick={() => goToChat(item.peerId)}
                    >
                      <MessageSquare size={14} strokeWidth={ICON_STROKE} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox ? (
        <div className="media-lightbox" role="dialog" aria-modal="true" onClick={() => setLightbox(null)}>
          <div className="media-lightbox-inner" onClick={(e) => e.stopPropagation()}>
            <img src={lightbox.src} alt={lightbox.alt} />
            <div className="media-lightbox-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  if (!lightbox?.base64) return;
                  const name = lightbox.defaultFilename || 'bild';
                  if (window.bluetalk?.file?.saveAs) {
                    const res = await window.bluetalk.file.saveAs({ defaultFilename: name, base64: lightbox.base64 });
                    if (res?.ok) {
                      toast({ variant: 'success', title: 'Datei gespeichert' });
                      return;
                    }
                    if (res?.canceled) return;
                  }
                  downloadBase64AsFile(name, lightbox.base64);
                  toast({ variant: 'success', title: 'Download gestartet' });
                }}
              >
                <Download size={14} strokeWidth={ICON_STROKE} aria-hidden />
                Speichern
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLightbox(null)}>
                Schließen
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
