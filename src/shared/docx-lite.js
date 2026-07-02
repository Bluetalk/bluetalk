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

// ======================================================================
//  Rich-Text: HTML ⇄ .docx (Fett/Kursiv/Unterstr./Durchgestr., Über-
//  schriften 1–3, Auf­zählung/Nummerierung, Ausrichtung, Farbe/Highlight)
//
//  Der Live-Editor hält seinen Zustand als HTML. Diese Funktionen bilden
//  dieselbe gängige Word-Teilmenge auf beide Richtungen ab — weiterhin
//  ohne externe Abhängigkeiten, in Renderer und Node lauffähig.
// ======================================================================

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'col', 'wbr']);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** XML-Entities + die im Editor-HTML üblichen benannten Entities. */
function decodeHtmlEntities(value) {
  return decodeXmlEntities(String(value ?? '').replace(/&nbsp;/g, ' '));
}

/** @param {string} attrs  Roh-Attributstring @param {string} name */
function getAttr(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"|${name}\\s*=\\s*'([^']*)'`, 'i').exec(String(attrs || ''));
  return m ? (m[1] ?? m[2] ?? '') : '';
}

/** Einzelne CSS-Eigenschaft aus einem style="" Attribut. */
function getStyleProp(style, prop) {
  const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'i').exec(String(style || ''));
  return m ? m[1].trim() : '';
}

/** CSS-Farbe (#abc, #aabbcc, rgb(...)) → "RRGGBB" (Großbuchstaben) oder ''. */
function colorToHex(value) {
  const v = String(value || '').trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return m[1].toUpperCase();
  m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return m[1].split('').map((c) => c + c).join('').toUpperCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (m) {
    return [m[1], m[2], m[3]]
      .map((n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  }
  return '';
}

function alignFromStyle(style) {
  const a = getStyleProp(style, 'text-align').toLowerCase();
  return a === 'center' || a === 'right' || a === 'justify' ? a : '';
}

/** HTML grob in Tokens zerlegen (kein DOM — läuft auch in Node). */
function tokenizeHtml(html) {
  const tokens = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', text: html.slice(last, m.index) });
    const name = m[2].toLowerCase();
    if (m[1] === '/') tokens.push({ type: 'close', name });
    else if (m[4] === '/' || VOID_TAGS.has(name)) tokens.push({ type: 'void', name, attrs: m[3] });
    else tokens.push({ type: 'open', name, attrs: m[3] });
    last = re.lastIndex;
  }
  if (last < html.length) tokens.push({ type: 'text', text: html.slice(last) });
  return tokens;
}

const BLOCK_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div', 'pre']);
const HEADING_TYPE = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h3', h5: 'h3', h6: 'h3' };

/**
 * Editor-HTML → flache Blockliste.
 * @returns {Array<{ type: string, ordered: boolean, align: string, runs: Array<{ text: string, b: boolean, i: boolean, u: boolean, s: boolean, color: string, hl: string }> }>}
 */
function htmlToBlocks(html) {
  const tokens = tokenizeHtml(String(html || ''));
  const blocks = [];
  const fmt = { b: 0, i: 0, u: 0, s: 0, color: [], hl: [] };
  const listStack = [];
  let cur = null;

  const finish = () => { if (cur) { blocks.push(cur); cur = null; } };
  const start = (type, attrs) => {
    finish();
    cur = { type, ordered: listStack[listStack.length - 1] === 'ol', align: alignFromStyle(getAttr(attrs, 'style')), runs: [] };
  };
  const addText = (raw) => {
    const text = decodeHtmlEntities(raw);
    if (!text) return;
    if (!cur) cur = { type: 'p', ordered: false, align: '', runs: [] };
    cur.runs.push({
      text,
      b: fmt.b > 0,
      i: fmt.i > 0,
      u: fmt.u > 0,
      s: fmt.s > 0,
      color: fmt.color[fmt.color.length - 1] || '',
      hl: fmt.hl[fmt.hl.length - 1] || '',
    });
  };

  for (const tok of tokens) {
    if (tok.type === 'text') { addText(tok.text); continue; }
    const { name } = tok;
    if (tok.type === 'void') {
      if (name === 'br') { if (cur) finish(); else blocks.push({ type: 'p', ordered: false, align: '', runs: [] }); }
      continue;
    }
    if (tok.type === 'open') {
      if (name === 'ul' || name === 'ol') { finish(); listStack.push(name); continue; }
      if (BLOCK_TAGS.has(name)) { start(HEADING_TYPE[name] || (name === 'li' ? 'li' : 'p'), tok.attrs); continue; }
      if (name === 'strong' || name === 'b') fmt.b++;
      else if (name === 'em' || name === 'i') fmt.i++;
      else if (name === 'u' || name === 'ins' || name === 'a') fmt.u++;
      else if (name === 's' || name === 'strike' || name === 'del') fmt.s++;
      else if (name === 'span' || name === 'font') {
        const style = getAttr(tok.attrs, 'style');
        fmt.color.push(colorToHex(getStyleProp(style, 'color') || getAttr(tok.attrs, 'color')));
        fmt.hl.push(colorToHex(getStyleProp(style, 'background-color') || getStyleProp(style, 'background')));
      }
      continue;
    }
    // close
    if (name === 'ul' || name === 'ol') { finish(); listStack.pop(); continue; }
    if (BLOCK_TAGS.has(name)) { finish(); continue; }
    if (name === 'strong' || name === 'b') fmt.b = Math.max(0, fmt.b - 1);
    else if (name === 'em' || name === 'i') fmt.i = Math.max(0, fmt.i - 1);
    else if (name === 'u' || name === 'ins' || name === 'a') fmt.u = Math.max(0, fmt.u - 1);
    else if (name === 's' || name === 'strike' || name === 'del') fmt.s = Math.max(0, fmt.s - 1);
    else if (name === 'span' || name === 'font') { fmt.color.pop(); fmt.hl.pop(); }
  }
  finish();
  return blocks;
}

const RICH_NAMESPACES = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function runToXml(run) {
  const rPr = [];
  if (run.b) rPr.push('<w:b/><w:bCs/>');
  if (run.i) rPr.push('<w:i/><w:iCs/>');
  if (run.u) rPr.push('<w:u w:val="single"/>');
  if (run.s) rPr.push('<w:strike/>');
  if (run.color) rPr.push(`<w:color w:val="${run.color}"/>`);
  if (run.hl) rPr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${run.hl}"/>`);
  const rPrXml = rPr.length ? `<w:rPr>${rPr.join('')}</w:rPr>` : '';
  // Zeilenumbrüche im Run als <w:br/>, Tabs als <w:tab/> erhalten.
  const pieces = String(run.text ?? '').split(/(\n|\t)/).map((piece) => {
    if (piece === '\n') return '<w:br/>';
    if (piece === '\t') return '<w:tab/>';
    return piece ? `<w:t xml:space="preserve">${escapeXml(piece)}</w:t>` : '';
  }).join('');
  return `<w:r>${rPrXml}${pieces}</w:r>`;
}

function blockToXml(block) {
  const pPr = [];
  const styleId = { h1: 'Heading1', h2: 'Heading2', h3: 'Heading3' }[block.type];
  if (styleId) pPr.push(`<w:pStyle w:val="${styleId}"/>`);
  if (block.type === 'li') pPr.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${block.ordered ? 2 : 1}"/></w:numPr>`);
  const jc = { center: 'center', right: 'right', justify: 'both' }[block.align];
  if (jc) pPr.push(`<w:jc w:val="${jc}"/>`);
  const pPrXml = pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  const runs = block.runs.length ? block.runs.map(runToXml).join('') : '';
  return `<w:p>${pPrXml}${runs}</w:p>`;
}

function buildRichDocumentXml(html) {
  const body = htmlToBlocks(html).map(blockToXml).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document ${RICH_NAMESPACES}>`
    + `<w:body>${body}<w:sectPr/></w:body></w:document>`;
}

const RICH_CONTENT_TYPES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
  + '</Types>';

const DOC_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
  + '</Relationships>';

function headingStyle(id, name, size, color) {
  return `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/>`
    + '<w:pPr><w:spacing w:before="240" w:after="120"/><w:keepNext/></w:pPr>'
    + `<w:rPr><w:b/><w:bCs/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:styles ${RICH_NAMESPACES}>`
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + headingStyle('Heading1', 'heading 1', 40, '111827')
  + headingStyle('Heading2', 'heading 2', 32, '1F2937')
  + headingStyle('Heading3', 'heading 3', 26, '374151')
  + '</w:styles>';

function abstractNum(id, fmt, text) {
  return `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="1"/>`
    + `<w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
    + '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>';
}

const NUMBERING_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<w:numbering ${RICH_NAMESPACES}>`
  + abstractNum(0, 'bullet', '•')
  + abstractNum(1, 'decimal', '%1.')
  + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
  + '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
  + '</w:numbering>';

/**
 * Editor-HTML → gültige .docx-Datei mit Formatierung.
 * @param {string} html
 * @returns {Uint8Array}
 */
function buildDocxFromHtml(html) {
  const encoder = new TextEncoder();
  return buildStoredZip([
    { name: '[Content_Types].xml', data: encoder.encode(RICH_CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: encoder.encode(RELS_XML) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(DOC_RELS_XML) },
    { name: 'word/document.xml', data: encoder.encode(buildRichDocumentXml(html)) },
    { name: 'word/styles.xml', data: encoder.encode(STYLES_XML) },
    { name: 'word/numbering.xml', data: encoder.encode(NUMBERING_XML) },
  ]);
}

// ---------- .docx → Editor-HTML ----------

/** numbering.xml → Map numId → ordered? (true = nummeriert, false = Aufzählung) */
function parseNumberingOrdered(numberingXml) {
  const map = new Map();
  if (!numberingXml) return map;
  const absFmt = new Map();
  const absRe = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g;
  let a;
  while ((a = absRe.exec(numberingXml)) !== null) {
    const fmt = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(a[0]);
    absFmt.set(a[1], fmt ? fmt[1] : 'bullet');
  }
  const numRe = /<w:num\b[^>]*w:numId="(\d+)"[\s\S]*?<w:abstractNumId\b[^>]*w:val="(\d+)"/g;
  let n;
  while ((n = numRe.exec(numberingXml)) !== null) {
    map.set(n[1], (absFmt.get(n[2]) || 'bullet') !== 'bullet');
  }
  return map;
}

/** true, wenn ein Toggle-Property (z. B. w:b) in rPr aktiv ist. */
function toggleOn(rPr, tag) {
  const m = new RegExp(`<w:${tag}(\\s[^>]*)?/?>`).exec(rPr);
  if (!m) return false;
  const val = /w:val="([^"]*)"/.exec(m[1] || '');
  return !(val && /^(0|false|off|none)$/i.test(val[1]));
}

/** Text eines <w:r>…</w:r> mit Tabs (\t) und Umbrüchen (\n). */
function runInnerText(runXml) {
  let text = '';
  const tokens = runXml.match(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g) || [];
  for (const token of tokens) {
    if (token.startsWith('<w:tab')) text += '\t';
    else if (token.startsWith('<w:br') || token.startsWith('<w:cr')) text += '\n';
    else if (!token.endsWith('/>')) {
      text += decodeXmlEntities(token.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, ''));
    }
  }
  return text;
}

/** Run-Text als HTML mit den passenden Inline-Tags umschließen. */
function wrapRunHtml(text, f) {
  if (!text) return '';
  let inner = escapeHtml(text).replace(/\n/g, '<br>').replace(/\t/g, '    ');
  if (f.color || f.hl) {
    const styles = [];
    if (f.color) styles.push(`color:#${f.color}`);
    if (f.hl) styles.push(`background-color:#${f.hl}`);
    inner = `<span style="${styles.join(';')}">${inner}</span>`;
  }
  if (f.s) inner = `<s>${inner}</s>`;
  if (f.u) inner = `<u>${inner}</u>`;
  if (f.i) inner = `<em>${inner}</em>`;
  if (f.b) inner = `<strong>${inner}</strong>`;
  return inner;
}

/**
 * word/document.xml (+ optional numbering.xml) → Editor-HTML.
 */
function documentXmlToHtml(xml, numberingXml) {
  const orderedByNum = parseNumberingOrdered(numberingXml);
  const parts = String(xml).split(/<w:p[ >]/).slice(1);
  const htmlParts = [];
  let listItems = '';
  let listOrdered = false;
  const flushList = () => {
    if (listItems) {
      htmlParts.push(`<${listOrdered ? 'ol' : 'ul'}>${listItems}</${listOrdered ? 'ol' : 'ul'}>`);
      listItems = '';
    }
  };

  for (const part of parts) {
    const paraXml = part.split(/<\/w:p>/)[0] ?? part;
    const pPrMatch = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(paraXml);
    const pPr = pPrMatch ? pPrMatch[1] : '';
    const styleId = (/<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(pPr) || [])[1] || '';
    const jc = (/<w:jc\b[^>]*w:val="([^"]+)"/.exec(pPr) || [])[1] || '';
    const numId = (/<w:numPr[\s\S]*?<w:numId\b[^>]*w:val="(\d+)"/.exec(pPr) || [])[1] || '';
    const cssAlign = jc === 'center' ? 'center' : jc === 'right' ? 'right' : jc === 'both' ? 'justify' : '';
    const alignAttr = cssAlign ? ` style="text-align:${cssAlign}"` : '';

    let runsHtml = '';
    const runs = paraXml.match(/<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:r\b[^>]*\/>/g) || [];
    for (const runXml of runs) {
      const rPr = (/<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(runXml) || [])[1] || '';
      runsHtml += wrapRunHtml(runInnerText(runXml), {
        b: toggleOn(rPr, 'b'),
        i: toggleOn(rPr, 'i'),
        u: toggleOn(rPr, 'u'),
        s: toggleOn(rPr, 'strike'),
        color: (/<w:color\b[^>]*w:val="([0-9A-Fa-f]{6})"/.exec(rPr) || [])[1]?.toUpperCase() || '',
        hl: (/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/.exec(rPr) || [])[1]?.toUpperCase() || '',
      });
    }

    const headingTag = /heading\s*1/i.test(styleId) ? 'h1' : /heading\s*2/i.test(styleId) ? 'h2' : /heading\s*3/i.test(styleId) ? 'h3' : '';

    if (numId && !headingTag) {
      const ordered = orderedByNum.get(numId) ?? false;
      if (listItems && ordered !== listOrdered) flushList();
      listOrdered = ordered;
      listItems += `<li${alignAttr}>${runsHtml || '<br>'}</li>`;
    } else {
      flushList();
      const tag = headingTag || 'p';
      htmlParts.push(`<${tag}${alignAttr}>${runsHtml || '<br>'}</${tag}>`);
    }
  }
  flushList();
  return htmlParts.join('') || '<p><br></p>';
}

/**
 * .docx-Datei → Editor-HTML (mit Formatierung).
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function parseDocxHtml(buffer) {
  const entries = listZipEntries(buffer);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('not_a_docx');
  const xml = new TextDecoder().decode(await readZipEntry(buffer, docEntry));
  const numEntry = entries.find((e) => e.name === 'word/numbering.xml');
  const numberingXml = numEntry ? new TextDecoder().decode(await readZipEntry(buffer, numEntry)) : '';
  return documentXmlToHtml(xml, numberingXml);
}

export {
  parseDocx,
  buildDocx,
  parseDocxHtml,
  buildDocxFromHtml,
  htmlToBlocks,
  documentXmlToHtml,
  extractDocumentText,
  buildDocumentXml,
  crc32,
  buildStoredZip,
  listZipEntries,
};
