const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('sticker sending uses the existing file transfer state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'pages', 'Chats.jsx'),
    'utf8'
  );
  const start = source.indexOf('const sendSticker = useCallback');
  const end = source.indexOf('const openFilePicker', start);
  const sendSticker = source.slice(start, end);

  assert.ok(start >= 0 && end > start, 'sendSticker callback should exist');
  assert.doesNotMatch(sendSticker, /setSendingFile\s*\(/);
  assert.match(sendSticker, /setFileTransfer\(\{ stage: 'sending'/);
  assert.match(sendSticker, /finally\s*\{[\s\S]*setFileTransfer\(null\)/);
});
