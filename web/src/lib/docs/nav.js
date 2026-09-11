export const DOCS_NAV = [
  {
    title: 'Einstieg',
    items: [
      { slug: 'getting-started', label: 'Getting Started' },
      { slug: 'manifest', label: 'Manifest' },
    ],
  },
  {
    title: 'API',
    items: [
      { slug: 'main-process-api', label: 'Main Process' },
      { slug: 'ui-api', label: 'UI (Renderer)' },
      { slug: 'peer-networking', label: 'Peer Networking' },
      { slug: 'chat-contacts', label: 'Chat & Contacts' },
      { slug: 'ui-registration', label: 'UI Registration' },
      { slug: 'game-plugins', label: 'Game Plugins' },
      { slug: 'realtime-api', label: 'Realtime API' },
    ],
  },
  {
    title: 'Beispiele',
    items: [
      { slug: 'examples/hello-plugin', label: 'Hello Plugin' },
    ],
  },
];

export function flattenDocsNav(nav = DOCS_NAV) {
  const out = [];
  for (const section of nav) {
    for (const item of section.items) {
      out.push({ ...item, section: section.title });
    }
  }
  return out;
}

export function docsPath(slug) {
  return `/docs/${slug}`;
}

const CONTENT = import.meta.glob('./content/**/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function slugFromPath(path) {
  return path.replace(/^\.\/content\//, '').replace(/\.md$/, '');
}

export const DOCS_CONTENT = Object.fromEntries(
  Object.entries(CONTENT).map(([path, raw]) => [slugFromPath(path), String(raw || '')]),
);
