const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');

async function loadStickerStore() {
  const source = await fs.readFile(
    path.join(__dirname, '..', 'src', 'renderer', 'stickers', 'stickerStore.js'),
    'utf8'
  );
  const transformed = await esbuild.transform(source, { format: 'cjs', platform: 'node', target: 'node20' });
  const module = { exports: {} };
  const evaluate = new Function('module', 'exports', 'require', transformed.code);
  evaluate(module, module.exports, require);
  return module.exports;
}

function pngData() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

test('sticker validation checks base64, real size, signature, and MIME', async () => {
  const stickers = await loadStickerStore();
  const fileData = pngData().toString('base64');
  const valid = stickers.validateStickerData({
    fileData,
    fileType: 'image/png',
    fileSize: pngData().length,
  });
  assert.equal(valid.fileType, 'image/png');
  assert.equal(valid.fileSize, pngData().length);
  assert.equal(stickers.base64ByteLength(fileData), pngData().length);

  assert.throws(
    () => stickers.validateStickerData({ fileData, fileType: 'image/jpeg', fileSize: pngData().length }),
    /stimmen nicht überein/
  );
  assert.throws(
    () => stickers.validateStickerData({ fileData: 'not-base64', fileType: 'image/png' }),
    /Ungültige/
  );
});

test('sticker pack sanitization removes corrupt and duplicate records', async () => {
  const stickers = await loadStickerStore();
  const fileData = pngData().toString('base64');
  const valid = {
    id: 'st-valid',
    name: 'Valid',
    fileName: 'valid.png',
    fileType: 'image/png',
    fileData,
    fileSize: pngData().length,
  };
  const packs = stickers.sanitizeStickerPacks([
    { id: 'custom', name: 'Custom', stickers: [valid, valid, { ...valid, id: 'st-bad', fileData: 'broken' }] },
  ]);
  assert.ok(packs.some((pack) => pack.id === stickers.DEFAULT_PACK_ID));
  assert.equal(packs.find((pack) => pack.id === 'custom').stickers.length, 1);
  assert.equal(stickers.computePacksSize(packs), pngData().length);
});
