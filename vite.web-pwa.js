// PWA-Metas, Manifest und Icons — nur Vite-Mode `web`.
// Kein Service-Worker, damit API/WebSocket nicht gecacht werden.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readIconSvg() {
  return fs.readFileSync(path.join(here, 'assets', 'icon.svg'));
}

function readIconPng() {
  return fs.readFileSync(path.join(here, 'assets', 'icon.png'));
}

function manifestJson() {
  return `${JSON.stringify({
    name: 'BlueTalk',
    short_name: 'BlueTalk',
    description: 'BlueTalk P2P-Messenger',
    lang: 'de',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#0a0a0a',
    theme_color: '#08111f',
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192-maskable.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }, null, 2)}\n`;
}

const HEAD_SNIPPET = `
    <meta name="theme-color" content="#08111f" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="apple-mobile-web-app-title" content="BlueTalk" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />
`;

function injectHead(html) {
  let next = html.replace(
    /<meta name="viewport"[^>]*>/,
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />'
  );
  if (!next.includes('apple-mobile-web-app-capable')) {
    next = next.replace('</head>', `${HEAD_SNIPPET}  </head>`);
  }
  return next;
}

function iconAssets() {
  const svg = readIconSvg();
  const png = readIconPng();
  return [
    { fileName: 'manifest.webmanifest', source: manifestJson() },
    { fileName: 'icons/icon.svg', source: svg },
    { fileName: 'icons/icon-192.png', source: png },
    { fileName: 'icons/icon-512.png', source: png },
    { fileName: 'icons/icon-192-maskable.png', source: png },
    { fileName: 'icons/icon-512-maskable.png', source: png },
    { fileName: 'icons/apple-touch-icon.png', source: png },
  ];
}

function send(res, body, type) {
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.end(body);
}

export function bluetalkWebPwaPlugin() {
  const assets = iconAssets();
  const byUrl = new Map(
    assets.map((a) => [`/${a.fileName}`, a])
  );

  return {
    name: 'bluetalk-web-pwa',
    transformIndexHtml(html) {
      return injectHead(html);
    },
    generateBundle() {
      for (const asset of assets) {
        this.emitFile({
          type: 'asset',
          fileName: asset.fileName,
          source: asset.source,
        });
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        const asset = byUrl.get(url);
        if (!asset) {
          next();
          return;
        }
        const type = asset.fileName.endsWith('.svg')
          ? 'image/svg+xml'
          : asset.fileName.endsWith('.png')
            ? 'image/png'
            : 'application/manifest+json';
        send(res, asset.source, type);
      });
    },
  };
}
