const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const docxLiteUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'shared', 'docx-lite.js')).href;

test('docx-lite round-trips text through a valid docx', async () => {
  const { buildDocx, parseDocx } = await import(docxLiteUrl);
  const text = 'Hallo Welt\n\nZweiter Absatz mit <spitzen> & "Zeichen"\n\tEingerückt';
  const bytes = buildDocx(text);
  assert.ok(bytes instanceof Uint8Array);
  // ZIP-Magic am Anfang (PK\x03\x04)
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);
  const parsed = await parseDocx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(parsed, text);
});

test('docx-lite extracts runs, tabs and breaks from document.xml', async () => {
  const { extractDocumentText } = await import(docxLiteUrl);
  const xml = '<w:document><w:body>'
    + '<w:p><w:r><w:t>Erste</w:t></w:r><w:r><w:t xml:space="preserve"> Zeile</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>Mit</w:t><w:tab/><w:t>Tab</w:t><w:br/><w:t>und Umbruch &amp; Entit&#228;t</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  assert.equal(extractDocumentText(xml), 'Erste Zeile\nMit\tTab\nund Umbruch & Entität');
});

test('docx-lite parseDocx rejects non-docx zip content', async () => {
  const { buildStoredZip, parseDocx } = await import(docxLiteUrl);
  const zip = buildStoredZip([{ name: 'hello.txt', data: new TextEncoder().encode('hi') }]);
  await assert.rejects(
    () => parseDocx(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength)),
    /not_a_docx/,
  );
});

test('docx-lite listZipEntries reads the archive it wrote', async () => {
  const { buildDocx, listZipEntries } = await import(docxLiteUrl);
  const bytes = buildDocx('abc');
  const names = listZipEntries(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    .map((e) => e.name)
    .sort();
  assert.deepEqual(names, ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].sort());
});
