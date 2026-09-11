import { marked } from 'marked';

marked.setOptions({ gfm: true });

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

export function renderDocsMarkdown(markdown) {
  const html = marked.parse(String(markdown || ''), { gfm: true, async: false });
  return String(html).replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_, level, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    return `<h${level} id="${slugify(text)}">${inner}</h${level}>`;
  });
}

export function extractToc(markdown) {
  const headings = [];
  for (const line of String(markdown || '').split('\n')) {
    const match = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const text = match[2].replace(/#+$/, '').trim();
    headings.push({
      level: match[1].length,
      text,
      id: slugify(text),
    });
  }
  return headings;
}
