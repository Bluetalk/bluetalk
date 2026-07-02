/**
 * docx-lite — minimaler .docx-Import/-Export ohne Abhängigkeiten.
 *
 * Ein .docx ist ein ZIP-Archiv mit XML-Dateien. Für den Live-Editor reicht:
 *  - parseDocx(buffer):  ZIP lesen, word/document.xml finden (deflate über die
 *    Web-Standard-DecompressionStream dekomprimieren) und den Absatztext
 *    extrahieren (w:p / w:t, inkl. Tabs und Zeilenumbrüchen).
 *  - buildDocx(text):    ein gültiges, minimales .docx erzeugen (ZIP mit
 *    unkomprimierten Einträgen + CRC32, ein w:p pro Zeile).
 *
 * Läuft in Renderer (Chromium) und Node ≥18 (Tests) — beide haben
 * DecompressionStream, TextEncoder/TextDecoder.
 */

// ---------- CRC32 (für den ZIP-Writer) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------- ZIP lesen ----------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(view) {
  // EOCD steht am Ende; der Kommentar kann bis 65535 Bytes lang sein.
  const start = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= start; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

function listZipEntries(buffer) {
  const view = new DataView(buffer);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('invalid_zip');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(offset, true) !== CENTRAL_SIG) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(buffer, entry) {
  const view = new DataView(buffer);
  const o = entry.localOffset;
  if (view.getUint32(o, true) !== LOCAL_SIG) throw new Error('invalid_zip_entry');
  const nameLen = view.getUint16(o + 26, true);
  const extraLen = view.getUint16(o + 28, true);
  const dataStart = o + 30 + nameLen + extraLen;
  const compressed = new Uint8Array(buffer, dataStart, entry.compressedSize);
  if (entry.method === 0) return compressed;
  if (entry.method !== 8) throw new Error('unsupported_zip_method');
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

// ---------- document.xml → Text ----------

function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Extrahiert lesbaren Text aus document.xml. Regex statt DOM-Parser, damit es
 * auch in Node (Tests) läuft — docx-XML ist maschinell erzeugt und wohlgeformt.
 */
function extractDocumentText(xml) {
  const paragraphs = [];
  // Absätze splitten; Inhalt vor dem ersten <w:p> (sectPr etc.) ignorieren.
  const parts = String(xml).split(/<w:p[ >]/).slice(1);
  for (const part of parts) {
    const body = part.split(/<\/w:p>/)[0] ?? part;
    let text = '';
    // Reihenfolge der Runs beibehalten: w:t (Text), w:tab, w:br/w:cr.
    // `<w:t` braucht ein Wortende ((?:\s…)?>), sonst würde auch <w:tab/> matchen.
    const tokens = body.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g) || [];
    for (const token of tokens) {
      if (token.startsWith('<w:tab')) text += '\t';
      else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) text += '\n';
      else {
        const inner = token.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, '');
        if (!token.endsWith('/>')) text += decodeXmlEntities(inner);
      }
    }
    paragraphs.push(text);
  }
  return paragraphs.join('\n');
}

/**
 * @param {ArrayBuffer} buffer  Inhalt einer .docx-Datei
 * @returns {Promise<string>}   extrahierter Dokumenttext
 */
async function parseDocx(buffer) {
  const entries = listZipEntries(buffer);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('not_a_docx');
  const bytes = await readZipEntry(buffer, docEntry);
  return extractDocumentText(new TextDecoder().decode(bytes));
}

// ---------- Text → .docx ----------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Steuerzeichen sind in XML 1.0 unzulässig (Tab bleibt erhalten).
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function buildDocumentXml(text) {
  const lines = String(text ?? '').split('\n');
  const body = lines
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '</Types>';

const RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';

function writeUint16(arr, value) {
  arr.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(arr, value) {
  arr.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * ZIP mit unkomprimierten Einträgen (method 0) — klein genug für Dokumente
 * und ohne Kompressions-Abhängigkeit.
 * @param {Array<{ name: string, data: Uint8Array }>} files
 * @returns {Uint8Array}
 */
function buildStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = [];
    writeUint32(local, LOCAL_SIG);
    writeUint16(local, 20); // version needed
    writeUint16(local, 0);  // flags
    writeUint16(local, 0);  // method: stored
    writeUint16(local, 0);  // mod time
    writeUint16(local, 0);  // mod date
    writeUint32(local, crc);
    writeUint32(local, file.data.length);
    writeUint32(local, file.data.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);  // extra len
    const localHeader = new Uint8Array(local);
    localParts.push(localHeader, nameBytes, file.data);

    const central = [];
    writeUint32(central, CENTRAL_SIG);
    writeUint16(central, 20); // version made by
    writeUint16(central, 20); // version needed
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, crc);
    writeUint32(central, file.data.length);
    writeUint32(central, file.data.length);
    writeUint16(central, nameBytes.length);
    writeUint16(central, 0); // extra
    writeUint16(central, 0); // comment
    writeUint16(central, 0); // disk
    writeUint16(central, 0); // internal attrs
    writeUint32(central, 0); // external attrs
    writeUint32(central, offset);
    centralParts.push(new Uint8Array(central), nameBytes);

    offset += localHeader.length + nameBytes.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = [];
  writeUint32(eocd, EOCD_SIG);
  writeUint16(eocd, 0);
  writeUint16(eocd, 0);
  writeUint16(eocd, files.length);
  writeUint16(eocd, files.length);
  writeUint32(eocd, centralSize);
  writeUint32(eocd, offset);
  writeUint16(eocd, 0);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, new Uint8Array(eocd)]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * @param {string} text  Dokumenttext (Zeilen = Absätze)
 * @returns {Uint8Array} Bytes einer gültigen .docx-Datei
 */
function buildDocx(text) {
  const encoder = new TextEncoder();
  return buildStoredZip([
    { name: '[Content_Types].xml', data: encoder.encode(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encoder.encode(RELS_XML) },
    { name: 'word/document.xml', data: encoder.encode(buildDocumentXml(text)) },
  ]);
}

export {
  parseDocx,
  buildDocx,
  extractDocumentText,
  buildDocumentXml,
  crc32,
  buildStoredZip,
  listZipEntries,
};
