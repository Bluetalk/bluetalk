const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectImageMimeFromBase64,
  isImageAttachment,
  normalizeAttachmentFileType,
  resolveImageMime,
} = require('../src/shared/attachment-image.js');

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

test('detectImageMimeFromBase64 recognizes common signatures', () => {
  assert.equal(detectImageMimeFromBase64(PNG_B64), 'image/png');
  assert.equal(detectImageMimeFromBase64(JPEG_B64), 'image/jpeg');
});

test('resolveImageMime uses extension and signature fallbacks', () => {
  assert.equal(resolveImageMime('', 'screenshot.png', PNG_B64), 'image/png');
  assert.equal(resolveImageMime('application/octet-stream', 'blob', PNG_B64), 'image/png');
  assert.equal(resolveImageMime('image/jpeg', 'x', ''), 'image/jpeg');
});

test('isImageAttachment accepts clipboard-style octet-stream blobs', () => {
  assert.equal(isImageAttachment('application/octet-stream', 'blob', PNG_B64), true);
  assert.equal(isImageAttachment('application/octet-stream', 'notes.txt', 'SGVsbG8='), false);
});

test('normalizeAttachmentFileType upgrades unknown image payloads', () => {
  assert.equal(
    normalizeAttachmentFileType('blob', 'application/octet-stream', PNG_B64),
    'image/png'
  );
});
