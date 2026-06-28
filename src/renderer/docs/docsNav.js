export const DOCS_NAV = [
  {
    title: 'Introduction',
    items: [
      { slug: 'getting-started', label: 'Getting Started' },
      { slug: 'manifest', label: 'Manifest Reference' },
    ],
  },
  {
    title: 'API Reference',
    items: [
      { slug: 'main-process-api', label: 'Main Process API' },
      { slug: 'ui-api', label: 'UI (Renderer) API' },
      { slug: 'peer-networking', label: 'Peer Networking' },
      { slug: 'chat-contacts', label: 'Chat & Contacts' },
      { slug: 'ui-registration', label: 'UI Registration' },
      { slug: 'game-plugins', label: 'Game Plugins' },
      { slug: 'realtime-api', label: 'Realtime API' },
    ],
  },
  {
    title: 'Examples',
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
