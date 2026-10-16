import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bluetalkWebPwaPlugin } from './vite.web-pwa.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const WEB_CSP = "default-src 'self'; connect-src 'self' ws: wss: https:; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

export default defineConfig(({ mode }) => {
  const isWeb = mode === 'web';
  return {
    plugins: [
      react(),
      isWeb && {
        name: 'bluetalk-web-csp',
        transformIndexHtml(html) {
          return html
            .replace("lang=\"en\"", "lang=\"de\"")
            .replace(/content="default-src[^"]+"/, `content="${WEB_CSP}"`);
        },
      },
      isWeb && bluetalkWebPwaPlugin(),
    ].filter(Boolean),
    base: isWeb ? '/' : './',
    clearScreen: false,
    define: {
      __BLUETALK_WEB__: JSON.stringify(isWeb),
    },
    build: {
      outDir: isWeb ? 'dist-web' : 'dist',
      emptyOutDir: true,
      sourcemap: false,
      target: isWeb ? ['es2022', 'chrome110', 'safari16'] : ['es2021', 'chrome105', 'safari13'],
      rollupOptions: {
        output: {
          manualChunks: {
            markdown: ['react-markdown', 'remark-gfm', 'remark-math', 'rehype-katex'],
            highlighting: ['highlight.js', 'rehype-highlight'],
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(rootDir, 'src/renderer'),
        '@shared': path.resolve(rootDir, 'src/shared'),
        '@bridge': isWeb
          ? path.resolve(rootDir, 'src/bridge/webBridge/index.js')
          : path.resolve(rootDir, 'src/bridge/bluetalkBridge.js'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
  };
});
