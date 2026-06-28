const test = require('node:test');
const assert = require('node:assert/strict');

test('buildMessageNotificationPreview shows decrypted chat text', async () => {
  const { buildMessageNotificationPreview } = await import('../src/renderer/utils/messageNotificationPreview.js');
  assert.equal(
    buildMessageNotificationPreview({ kind: 'chat', content: 'Hallo Welt' }),
    'Hallo Welt'
  );
  assert.equal(
    buildMessageNotificationPreview({ kind: 'file', fileName: 'notes.txt' }),
    'Datei: notes.txt'
  );
});
