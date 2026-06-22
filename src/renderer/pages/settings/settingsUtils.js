export const SETTINGS_ICON_STROKE = 1.75;

export function formatDateTime(timestamp) {
  if (!timestamp) return 'Never';
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
      return 'Unavailable';
    case 'checking':
      return 'Checking';
    case 'available':
      return 'Update found';
    case 'downloading':
      return 'Downloading';
    case 'downloaded':
      return 'Ready to install';
    case 'pending_build':
      return 'Build pending';
    case 'error':
      return 'Error';
    default:
      return 'Idle';
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
