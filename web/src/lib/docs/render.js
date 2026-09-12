import { marked } from 'marked';

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

marked.use({
  gfm: true,
  renderer: {
    heading({ text, tokens, depth }) {
      const id = slugify(text);
      const inner = this.parser.parseInline(tokens);
      return `<h${depth} id="${id}"><a class="docs-anchor" href="#${id}" aria-label="Abschnitt verlinken">#</a>${inner}</h${depth}>\n`;
    },
  },
});

export function renderDocsMarkdown(markdown) {
  return String(marked.parse(String(markdown || ''), { async: false }));
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
