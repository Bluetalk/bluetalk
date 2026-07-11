export const SETTINGS_ICON_STROKE = 1.75;

export function formatDateTime(timestamp) {
  if (!timestamp) return 'Nie';
  return new Date(timestamp).toLocaleString();
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function getUpdateStatusLabel(state) {
  switch (state?.status) {
    case 'unsupported':
      return 'Nicht verfügbar';
    case 'checking':
      return 'Prüfe';
    case 'available':
      return 'Update gefunden';
    case 'downloading':
      return 'Wird geladen';
    case 'downloaded':
      return 'Bereit zur Installation';
    case 'pending_build':
      return 'Build ausstehend';
    case 'error':
      return 'Fehler';
    default:
      return 'Inaktiv';
  }
}

export function getUpdateBadgeClass(state) {
  switch (state?.status) {
    case 'available':
    case 'downloading':
      return 'badge-blue';
    case 'downloaded':
      return 'badge-success';
    case 'pending_build':
      return 'badge-warn';
    case 'error':
      return 'badge-danger';
    default:
      return 'badge-muted';
  }
}
