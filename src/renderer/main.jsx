import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import '@bridge';
import './styles/global.css';
import App from './App';

const GAME_WINDOW_ROUTES = new Set([
  '/poker-game',
  '/uno-game',
  '/connect-four-game',
  '/chess-game',
  '/tic-tac-toe-game',
  '/kart-game',
]);

if (!__BLUETALK_WEB__) {
  // Natives WebView2-Rechtsklickmenü überall unterdrücken. Eigene Kontextmenüs
  // öffnen über React-Handler und sind von preventDefault nicht betroffen.
  window.addEventListener('contextmenu', (event) => event.preventDefault());
} else {
  document.documentElement.classList.add('bluetalk-web');
}

const hashPath = window.location.hash.slice(1).split(/[?#]/, 1)[0] || '/';
const isGameWindow = GAME_WINDOW_ROUTES.has(hashPath);
const GameWindowApp = lazy(() => import('./GameWindowApp'));
const WebRoot = __BLUETALK_WEB__ ? lazy(() => import('./web/WebRoot')) : null;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isGameWindow ? (
      <Suspense fallback={<main className="page"><div className="page-body">BlueTalk wird geladen…</div></main>}>
        <GameWindowApp />
      </Suspense>
    ) : __BLUETALK_WEB__ ? (
      <Suspense fallback={<main className="page"><div className="page-body">BlueTalk wird geladen…</div></main>}>
        <WebRoot />
      </Suspense>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
