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

test('docx-lite htmlToBlocks maps formatting, headings and lists', async () => {
  const { htmlToBlocks } = await import(docxLiteUrl);
  const blocks = htmlToBlocks(
    '<h1>Titel</h1>'
    + '<p>Ganz <strong>fett</strong> und <em>kursiv</em> und <u>unter</u> und <s>weg</s>.</p>'
    + '<p style="text-align:center"><span style="color:#ff0000">rot</span></p>'
    + '<ul><li>Punkt A</li><li>Punkt B</li></ul>'
    + '<ol><li>Eins</li></ol>',
  );
  assert.equal(blocks[0].type, 'h1');
  assert.equal(blocks[0].runs[0].text, 'Titel');
  const para = blocks[1];
  assert.equal(para.type, 'p');
  assert.ok(para.runs.some((r) => r.text === 'fett' && r.b));
  assert.ok(para.runs.some((r) => r.text === 'kursiv' && r.i));
  assert.ok(para.runs.some((r) => r.text === 'unter' && r.u));
  assert.ok(para.runs.some((r) => r.text === 'weg' && r.s));
  assert.equal(blocks[2].align, 'center');
  assert.equal(blocks[2].runs[0].color, 'FF0000');
  const listItems = blocks.filter((b) => b.type === 'li');
  assert.equal(listItems.length, 3);
  assert.equal(listItems[0].ordered, false);
  assert.equal(listItems[2].ordered, true);
});

test('docx-lite round-trips rich HTML through a valid docx', async () => {
  const { buildDocxFromHtml, parseDocxHtml, listZipEntries } = await import(docxLiteUrl);
  const html = '<h1>Bericht</h1>'
    + '<p>Ein <strong>fetter</strong> und <em>kursiver</em> Satz.</p>'
    + '<ul><li>Erster Punkt</li><li>Zweiter Punkt</li></ul>'
    + '<ol><li>Schritt eins</li></ol>'
    + '<p style="text-align:right">rechts</p>';
  const bytes = buildDocxFromHtml(html);
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes[0], 0x50);
  assert.equal(bytes[1], 0x4b);

  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const names = listZipEntries(buf).map((e) => e.name);
  assert.ok(names.includes('word/styles.xml'));
  assert.ok(names.includes('word/numbering.xml'));

  const out = await parseDocxHtml(buf);
  assert.match(out, /<h1[^>]*>Bericht<\/h1>/);
  assert.match(out, /<strong>fetter<\/strong>/);
  assert.match(out, /<em>kursiver<\/em>/);
  assert.match(out, /<ul><li[^>]*>Erster Punkt<\/li>/);
  assert.match(out, /<ol><li[^>]*>Schritt eins<\/li><\/ol>/);
  assert.match(out, /text-align:right/);
});

test('docx-lite parseDocxHtml reads bold/italic runs from Word XML', async () => {
  const { buildDocxFromHtml, documentXmlToHtml } = await import(docxLiteUrl);
  // Fremd-Word-XML (andere Attributreihenfolge, w:val-Formen) muss auch gehen.
  const xml = '<w:document><w:body>'
    + '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Kapitel</w:t></w:r></w:p>'
    + '<w:p><w:r><w:rPr><w:b w:val="true"/></w:rPr><w:t xml:space="preserve">stark</w:t></w:r>'
    + '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t> normal</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const out = documentXmlToHtml(xml, '');
  assert.match(out, /<h2[^>]*>Kapitel<\/h2>/);
  assert.match(out, /<strong>stark<\/strong>/);
  assert.match(out, /normal/);
  assert.doesNotMatch(out, /<strong> normal<\/strong>/);
  // sanity: buildDocxFromHtml akzeptiert die Ausgabe wieder
  assert.ok(buildDocxFromHtml(out) instanceof Uint8Array);
});
