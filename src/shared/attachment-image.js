const EXT_TO_IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

function extOf(fileName) {
  const i = String(fileName || '').lastIndexOf('.');
  if (i <= 0) return '';
  return String(fileName).slice(i + 1).toLowerCase();
}

function stripDataUrlPrefix(data) {
  const s = String(data || '').trim();
  const idx = s.indexOf('base64,');
  return idx >= 0 ? s.slice(idx + 7) : s;
}

function detectImageMimeFromBase64(base64) {
  const raw = stripDataUrlPrefix(base64).replace(/\s/g, '').slice(0, 24);
  if (!raw) return '';
  if (raw.startsWith('iVBORw0KGgo')) return 'image/png';
  if (raw.startsWith('/9j/')) return 'image/jpeg';
  if (raw.startsWith('R0lGOD')) return 'image/gif';
  if (raw.startsWith('UklGR')) return 'image/webp';
  if (raw.startsWith('Qk')) return 'image/bmp';
  if (raw.startsWith('PHN2Zy')) return 'image/svg+xml';
  return '';
}

function resolveImageMime(fileType, fileName, fileData) {
  const mime = String(fileType || '').toLowerCase().split(';')[0].trim();
  if (mime.startsWith('image/')) return mime;
  const fromExt = EXT_TO_IMAGE_MIME[extOf(fileName)];
  if (fromExt) return fromExt;
  if (fileData) return detectImageMimeFromBase64(fileData);
  return '';
}

function isImageAttachment(fileType, fileName, fileData) {
  return Boolean(resolveImageMime(fileType, fileName, fileData));
}

function normalizeAttachmentFileType(fileName, fileType, fileData) {
  const imageMime = resolveImageMime(fileType, fileName, fileData);
  if (imageMime) return imageMime;
  const trimmed = String(fileType || '').trim();
  return trimmed || 'application/octet-stream';
}

module.exports = {
  EXT_TO_IMAGE_MIME,
  extOf,
  stripDataUrlPrefix,
  detectImageMimeFromBase64,
  resolveImageMime,
  isImageAttachment,
  normalizeAttachmentFileType,
};
